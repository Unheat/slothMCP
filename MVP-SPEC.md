# SlothMCP: MVP Specification (v1.0.0)

## 1. Scope & System Overview

**SlothMCP** is a lightweight TypeScript Model Context Protocol (MCP) gateway that runs over standard input/output (`stdio`). It aggregates multiple downstream MCP servers behind a single, low-overhead interface.

### Non-Goals for MVP:
- No local dense embedding neural networks (ONNX / Transformers) — pure BM25 lexical search is used.
- No SSE or WebSocket network transports — strictly `stdio`.
- No host IDE config hijacking / file sniffing (`claude_desktop_config.json`).
- No script execution sandboxes (e.g. QuickJS WASM).

---

## 2. Configuration & Data Formats

### 2.1 Configuration File (`~/.config/sloth/mcp.json`)
```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "idleTimeoutMs": 300000,
  "servers": {
    "docker": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-docker"],
      "env": {
        "DOCKER_HOST": "unix:///var/run/docker.sock"
      },
      "disabled": false
    },
    "hound": {
      "command": "hound-mcp",
      "args": ["--port", "8080"],
      "disabled": false
    }
  }
}
```

### 2.2 Manifest File (`~/.cache/sloth/manifests/<server>.json`)
```json
{
  "server": "docker",
  "fingerprint": "b7a9c3d4e5f6...",
  "indexedAt": 1756789000000,
  "tools": [
    {
      "name": "restart",
      "description": "Restart a container",
      "inputSchema": {
        "type": "object",
        "properties": {
          "container": { "type": "string", "description": "Container ID or name" },
          "timeout": { "type": "number", "description": "Seconds to wait before killing" }
        },
        "required": ["container"]
      }
    }
  ]
}
```

---

## 3. Host-Facing MCP Tool Definitions

When the host queries `tools/list`, SlothMCP returns exactly four tools:

### 3.1 `search_tools`
```json
{
  "name": "search_tools",
  "description": "Dynamic MCP Registry. MANDATORY: Search here before running raw terminal scripts or manual workarounds.\n\nAvailable Namespaces & Tools:\n• /codebase/* -> [ast_grep, find_symbol, text_search]\n• /database/* -> [inspect_tables, migrations, query]\n• /docker/*   -> [exec, logs, ps, restart]",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "Natural language or keyword search query (e.g. 'restart container', 'sql query')"
      },
      "namespace": {
        "type": "string",
        "description": "Optional namespace filter (e.g. 'docker', 'database', 'codebase')"
      },
      "limit": {
        "type": "number",
        "description": "Maximum number of tools to return (default: 5)"
      }
    },
    "required": ["query"]
  }
}
```

#### Output Format:
Returns compact 1-line TypeScript-style function signatures:
```text
docker.restart(container: string, timeout?: number): Restart a container
docker.logs(container: string, tail?: number): Fetch container logs
```

### 3.2 `get_tool_schema`
```json
{
  "name": "get_tool_schema",
  "description": "Progressive disclosure: retrieve the full original JSONSchema for a specific tool when handling complex or nested parameters.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server": {
        "type": "string",
        "description": "Target server namespace (e.g. 'docker')"
      },
      "tool": {
        "type": "string",
        "description": "Target tool name (e.g. 'restart')"
      }
    },
    "required": ["server", "tool"]
  }
}
```

#### Output Format:
Returns the verbatim `inputSchema` object for the tool.

### 3.3 `execute_tool`
```json
{
  "name": "execute_tool",
  "description": "Execute a downstream MCP tool. Lazily starts the downstream server if dormant.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "server": {
        "type": "string",
        "description": "Target server namespace (e.g. 'docker')"
      },
      "tool": {
        "type": "string",
        "description": "Target tool name (e.g. 'restart')"
      },
      "arguments": {
        "type": "object",
        "description": "Tool execution arguments matching the tool schema"
      }
    },
    "required": ["server", "tool", "arguments"]
  }
}
```

#### Output Format:
Returns standard MCP content array:
```json
{
  "content": [
    {
      "type": "text",
      "text": "Container api-gateway restarted successfully."
    }
  ]
}
```
If an error occurs downstream, returns:
```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Downstream execution failed: Container not found"
    }
  ]
}
```

### 3.4 `read_result`
```json
{
  "name": "read_result",
  "description": "Retrieve stored large tool results in bounded, lossless pages. Supports JSON-value paging (view: 'json'), complete text lines (view: 'text'), result envelope metadata (view: 'envelope'), or lossless raw UTF-8 fragments (view: 'raw').",
  "inputSchema": {
    "type": "object",
    "properties": {
      "result_id": {
        "type": "string",
        "description": "Opaque result ID returned by execute_tool"
      },
      "view": {
        "type": "string",
        "enum": ["auto", "json", "text", "envelope", "raw"],
        "description": "Retrieval view: 'auto', 'json', 'text', 'envelope', or 'raw'"
      },
      "source": {
        "description": "JSON/text source selector ('auto', 'structured', 'root', or block index)"
      },
      "path": {
        "type": "string",
        "description": "RFC 6901 JSON pointer (e.g. '/items' or '/users/0')"
      },
      "block_index": {
        "type": "number",
        "description": "Content block index for 'text' view"
      },
      "offset": {
        "type": "number",
        "description": "Item offset ('json'), line offset ('text'), or byte offset ('raw')"
      },
      "limit": {
        "type": "number",
        "description": "Max items ('json'), lines ('text'), or bytes ('raw') to return"
      }
    },
    "required": ["result_id"]
  }
}
```

#### Output Format:
Returns JSON string representing the requested paged view (`JsonView`, `TextView`, `EnvelopeView`, or `RawView`). When `view` is omitted or `"auto"`, the gateway inspects the stored result and delegates to the most appropriate structured view. Small results are returned inline by `execute_tool` without materialization; large results are stored atomically before returning a handle, guaranteeing no duplicate downstream execution.

---

## 4. Subprocess Pool & Lifecycle State Machine

```text
               ┌──────────┐
               │ Dormant  │ (0 MB RAM, not running)
               └────┬─────┘
                    │
                    │ execute_tool invoked (Single-Flight Lock)
                    ▼
               ┌──────────┐
               │ Starting │ (spawn process, initialize MCP handshake)
               └────┬─────┘
                    │
                    │ handshake complete
                    ▼
               ┌──────────┐
               │  Ready   │ (actively executing tools, in-flight ref count > 0)
               └────┬─────┘
                    │
                    │ all active calls complete -> start 5m timer
                    ▼
               ┌──────────┐
               │   Idle   │ (waiting for next request)
               └────┬─────┘
                    │
                    ├─► [New execute_tool arrives] ──► Reset timer, return to Ready
                    │
                    └─► [5 minutes expire]
                           │
                           ├─► client.close() + SIGTERM
                           ├─► wait up to 3s
                           ├─► SIGKILL (if process refuses to exit)
                           └─► Return to Dormant (Reclaim Memory)
```

---

## 5. CLI Interface Specifications (`bin/sloth.ts`)

| Command | Usage | Description |
| :--- | :--- | :--- |
| `sloth add` | `sloth add <name> <command> [args...]` | Add a new server and introspect tool schemas into cache. |
| `sloth rm` | `sloth rm <name>` | Remove a server configuration and delete its cached manifest. |
| `sloth list` | `sloth list` | Display table of servers (Name, Status, Process State, Tool Count). |
| `sloth toggle` | `sloth toggle <name>` | Enable or disable a server without removing configuration. |
| `sloth sync` | `sloth sync [name]` | Spawn servers, fetch fresh schemas, update fingerprints and cache. |
| `sloth start` | `sloth start` | Start the stdio MCP gateway server for IDE host connections. |

---

## 6. Automated Evaluation & Benchmark Targets

The Vitest benchmark suite (`test/benchmark.test.ts`) must enforce the following metrics:

1. **Token Savings Metric**:
   - Baseline (40 tools across 5 servers): $\ge 3,500\text{ tokens / turn}$.
   - SlothMCP Meta-Tools: $\le 250\text{ tokens / turn}$.
   - **Target: $\ge 85\%$ aggregate token reduction across 10 simulated conversation turns.**
2. **Search Latency Metric**:
   - MiniSearch BM25 query time over 100 tool definitions:
   - **Target: P95 $< 1.0\text{ms}$.**
3. **Retrieval Precision**:
   - Precision@3 on standard developer query set:
   - **Target: $\ge 90\%$.**
4. **Lifecycle & Memory**:
   - Cold boot memory footprint: $\le 30\text{MB}$ RSS.
   - Idle process auto-reap verified with mocked timers.
