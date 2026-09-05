# SlothMCP System Architecture & Protocol Deep-Dive

## 1. Overview & The Protocol Boundary

In standard Model Context Protocol (MCP) implementations, the host IDE (such as Claude Desktop, Cursor, or VS Code) connects directly to cloud LLM APIs (Anthropic, OpenAI) over HTTPS:

```text
┌─────────────────┐       Direct Cloud API (HTTPS)       ┌────────────────────────┐
│ Host IDE        │ ───────────────────────────────────► │ Cloud LLM Provider     │
│ (Claude/Cursor) │ ◄─────────────────────────────────── │ (Anthropic / OpenAI)   │
└────────┬────────┘                                      └────────────────────────┘
         │
         │ stdio JSON-RPC 2.0
         ▼
┌────────────────────────┐
│ SlothMCP Gateway       │  • tools/list is queried ONCE on IDE boot.
│ (stdio Server)         │  • The gateway never sees the user prompt before inference.
└────────────────────────┘  • Only receives tools/call when the model explicitly invokes one.
```

### Why Pre-Flight Routing is Impossible in Standard MCP
Because the host communicates directly with the cloud LLM, an MCP server running on `stdio` **never receives the user prompt before the LLM generates tokens**. 

Unless a system installs an invasive Man-In-The-Middle (MITM) HTTP reverse proxy to intercept and rewrite HTTPS traffic to `api.anthropic.com/v1/messages`, **tool discovery must be model-initiated**.

---

## 2. The Three Permanent Meta-Tools

SlothMCP exposes exactly three stable meta-tools to the host on session initialization:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                            SlothMCP Gateway                                 │
│                                                                             │
│ 1. search_tools(query, namespace?, limit?)                                  │
│    Embeds the 40-token deterministic capability taxonomy directly inside    │
│    its description. Returns compact 1-line TypeScript AST signatures.       │
│                                                                             │
│ 2. get_tool_schema(server, tool)                                            │
│    Progressive disclosure: returns full verbatim JSONSchema only when the   │
│    model needs to inspect complex, deeply nested parameters.                │
│                                                                             │
│ 3. execute_tool(server, tool, arguments)                                    │
│    Dispatches execution to downstream child processes with automatic        │
│    argument repair and error isolation.                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Solving Discovery Invisibility
Hiding all tools behind dynamic search typically causes LLMs to fall back to raw terminal commands (`grep`, `find`) because the model has no visibility into what tools are available.

SlothMCP solves this by injecting an **alphabetically sorted 40-token directory tree** directly into the `search_tools` tool description:

```text
Dynamic MCP Registry. MANDATORY: Search here before running raw terminal scripts.
Available Namespaces & Tools:
• /codebase/*   -> [find_symbol, text_search]
• /database/*   -> [inspect_tables, query, run_migration]
• /docker/*     -> [exec, logs, ps, restart]
• /github/*     -> [create_pull_request, get_file_contents, list_issues]
• /kubernetes/* -> [get_logs, get_pods, restart_deployment]
• /slack/*      -> [post_message]
```

This costs only ~40 tokens (compared to ~4,000 tokens for raw JSON schemas) while giving the model 100% global capability awareness.

---

## 3. Subprocess Pool Lifecycle State Machine

SlothMCP manages downstream child processes using a lazy state machine:

```text
                    ┌──────────┐
                    │ Dormant  │ (0 MB RAM, child process is stopped)
                    └────┬─────┘
                         │
                         │ execute_tool called (Single-Flight Lock)
                         ▼
                    ┌──────────┐
                    │ Starting │ (spawn stdio child, MCP initialize handshake)
                    └────┬─────┘
                         │
                         │ handshake complete
                         ▼
                    ┌──────────┐
                    │  Ready   │ (actively executing tools, inFlightCount > 0)
                    └────┬─────┘
                         │
                         │ inFlightCount reaches 0
                         ▼
                    ┌──────────┐
                    │   Idle   │ (inactivity timer starts)
                    └────┬─────┘
                         │
          ┌──────────────┴──────────────┐
          │ New tool call arrives       │ 5 minutes elapse (TTL)
          ▼                             ▼
     Reset timer,                  Send SIGTERM (graceful shutdown)
     return to Ready               Wait up to 3s -> SIGKILL fallback
                                   Return to Dormant (Reclaim Memory)
```

### Single-Flight Startup Lock
When an agent fires multiple concurrent tool requests to a dormant server (e.g., 5 simultaneous queries), SlothMCP places all incoming calls into a single initialization Promise (`startingLocks.get(serverName)`). Exactly **one** child process is spawned, avoiding duplicate processes and race conditions.

### Stream Isolation & Error Shielding
- **Stream Hygiene**: Downstream child processes have their `stderr` diverted into a 50-line circular ring buffer. Child processes can never write to `stdout`, keeping the host-facing JSON-RPC stream clean.
- **Fault Shielding**: If a downstream tool crashes or throws an exception, Sloth catches the error at the Promise boundary and converts it to a standard MCP `{ isError: true, content: [...] }` payload, preventing the IDE host session from hanging.

---

## 4. Self-Healing Argument Auto-Repair

When an LLM invokes `execute_tool`, parameter names sometimes suffer minor discrepancies (e.g. sending `container_name` instead of `container`). Rather than failing and wasting an entire roundtrip, SlothMCP applies a two-step repair pipeline:

1. **Fuzzy Key Remapping**:
   - Normalizes keys by stripping hyphens, underscores, and casing.
   - Remaps keys matching patterns like `${expected}name`, `${expected}id`, or `target${expected}`.
2. **Type Coercion**:
   - Coerces string numbers (`"8080"` $\to$ `8080`) when the schema expects `number` or `integer`.
   - Coerces string booleans (`"true"` $\to$ `true`, `"false"` $\to$ `false`) when the schema expects `boolean`.
3. **Self-Correcting Error Feedback**:
   - If a required parameter is completely missing, the error output includes the exact 1-line TypeScript signature (`Expected Tool Signature: docker.restart(container: string, timeout?: number)`), enabling single-turn model correction.
