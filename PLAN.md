# SlothMCP: Project Plan & Architectural Blueprint

## 1. Executive Summary

**SlothMCP** is a lightweight, zero-infrastructure Model Context Protocol (MCP) Router & Gateway designed under the **"LazyDev / Ponytail"** engineering philosophy:
- **Maximum leverage, minimal boilerplate**: Built on standard Node.js primitives and lightweight libraries rather than heavy distributed architectures.
- **Protocol compatibility**: Acts as a single stdio MCP server to the host IDE (Cursor, Claude Desktop, Windsurf) and an on-demand MCP client to downstream tools (Docker, GitHub, Postgres, Hound).
- **Core value proposition**:
  - Reduces LLM context window schema bloat by **85–95%** (exposing ~180 tokens of fixed meta-tools instead of 4,000–6,000 tokens of raw schemas).
  - Solves the **Discovery Invisibility Problem** via a fixed, deterministic 40-token hierarchical namespace taxonomy embedded directly in the `search_tools` tool description.
  - Eliminates idle background RAM waste by **>90%** via an on-demand lazy child process pool with a 5-minute inactivity TTL and automated `SIGTERM` / `SIGKILL` reaping.
  - Sub-millisecond ($<0.1\text{ms}$) in-memory BM25 tool search using `minisearch` with field-level boosting and compact 1-line TypeScript signature generation.

---

## 2. Core Protocol Constraints & Reality

In standard MCP over `stdio`:
```text
┌─────────────────┐       Direct Cloud API (HTTPS)       ┌────────────────────────┐
│ Host IDE        │ ───────────────────────────────────► │ Cloud LLM Provider     │
│ (Claude/Cursor) │ ◄─────────────────────────────────── │ (Anthropic / OpenAI)   │
└────────┬────────┘                                      └────────────────────────┘
         │
         │ stdio (JSON-RPC 2.0)
         ▼
┌────────────────────────┐
│ SlothMCP Gateway       │  • tools/list is fetched ONCE during IDE boot.
│ (stdio Server)         │  • Zero visibility into the user's raw prompt before LLM runs.
└────────────────────────┘  • Only receives tools/call when the model invokes a tool.
```

- **Constraint**: The MCP server never sees the raw user prompt before the LLM runs. Pre-flight schema rewriting is impossible without an external MITM HTTP proxy rewriting API traffic.
- **Solution**: Discovery is **model-initiated** via three permanent meta-tools, combined with an always-visible namespace directory tree in the description of `search_tools`.

---

## 3. Architecture & Mechanics

### 3.1 The Three Permanent Meta-Tools
When the host calls `tools/list`, SlothMCP always exposes exactly three stable tools:

1. **`search_tools(query: string, namespace?: string)`**:
   - Executes in-memory BM25 search over cached tool manifests.
   - Boosts: `name` (3.0), `description` (1.5), `parameters` (1.0).
   - Description embeds the deterministic 40-token hierarchical taxonomy tree:
     ```text
     Dynamic MCP Registry. Search here before running raw terminal scripts or manual workarounds.
     Available Namespaces:
     • /codebase/* -> [ast_grep, find_symbol, memory_search]
     • /database/* -> [query, inspect_tables, migrations]
     • /docker/*   -> [logs, ps, restart, exec]
     • /git/*      -> [diff, commit, create_pr, list_issues]
     ```
   - Returns compact 1-line TypeScript signatures (~30 tokens each vs ~180 tokens for raw JSONSchema).
   - Results are deterministically sorted by score descending, then tool name ascending to maximize LLM prompt-caching prefix hits.

2. **`get_tool_schema(server: string, tool: string)`**:
   - Progressive disclosure: returns the full original JSONSchema on-demand for tools with complex, nested, or strict object parameters.

3. **`execute_tool(server: string, tool: string, arguments: object)`**:
   - Dispatches tool execution to the downstream MCP server.
   - Wakes up dormant child processes lazily.
   - Catches downstream errors, timeouts, or process crashes and returns standard `{ isError: true, content: [...] }` payloads to prevent host JSON-RPC desynchronization.

---

### 3.2 Manifest Caching & Fast Zero-Process Boot
Downstream tool schemas are introspected once during `sloth add` / `sloth sync` and persisted to disk:
- Storage location: `~/.cache/sloth/manifests/<server>.json`
- Schema structure:
  ```json
  {
    "server": "docker",
    "fingerprint": "a3f12c...",
    "indexedAt": 1756789000000,
    "tools": [
      {
        "name": "restart",
        "description": "Restart a running container",
        "inputSchema": { ... }
      }
    ]
  }
  ```
- **Cold Boot**: At startup, SlothMCP reads disk manifests in $<10\text{ms}$ and builds the in-memory MiniSearch index. **Zero downstream child processes are spawned on boot (15MB RSS memory footprint).**

---

### 3.3 Lazy Subprocess Pool & Inactivity Reaper (5m TTL)

```text
[Gateway Start] ──► Read Manifest Cache ──► Expose Meta-Tools ──► [0 Subprocesses Running (15MB RSS)]
                                                                           │
                                                                   execute_tool Request
                                                                           ▼
[Tool Call Finished] ◄── Execute RPC ◄── Handshake (150ms) ◄── Spawn Child Process
        │
  Start/Reset 5m Timer
        │
   (No calls in 5m)
        ▼
 Send SIGTERM ──(3s timeout)──► SIGKILL ──► Reclaim Memory (RSS back to 15MB)
```

- **Single-Flight Spawn**: Concurrent calls to the same dormant server share a single initialization `Promise` to avoid duplicate child processes.
- **In-Flight Reference Counting**: Inactivity timers only start after the last active tool call finishes.
- **Graceful Shutdown**: On 5-minute timeout or gateway exit (`SIGINT`/`SIGTERM`), sends `SIGTERM` followed by a 3-second `SIGKILL` escalation.
- **Stream Isolation**: Downstream `stderr` is captured in a 50-line circular ring buffer for debugging. Downstream processes never write to `stdout` (which belongs exclusively to the upstream JSON-RPC channel).

---

### 3.4 SHA-256 Schema Fingerprinting & Auto-Sync
- Computes `crypto.createHash('sha256').update(JSON.stringify(tools)).digest('hex')`.
- On `sloth sync` or when `tools/list_changed` is emitted, Sloth compares new fingerprint vs cached fingerprint. If unchanged, skips disk I/O and index rebuilds.

---

## 4. Minimal LazyDev Tech Stack

```text
slothMCP/
├── package.json               # Node >= 20, ESM
├── tsconfig.json              # Strict TS, NodeNext resolution, ES2022
├── bin/
│   └── sloth.ts               # Minimal CLI (add, rm, list, toggle, sync, start)
├── src/
│   ├── config.ts              # Config store (~/.config/sloth/mcp.json) + Zod validation + atomic writes
│   ├── indexer.ts             # MiniSearch BM25 + Compact TS AST Formatter + Dynamic Taxonomy
│   ├── pool.ts                # Lazy subprocess pool + Single-flight spawn + 5m TTL timer + SIGTERM
│   └── server.ts              # Stdio MCP Server exposing search_tools, get_tool_schema, execute_tool
└── test/
    └── benchmark.test.ts      # Vitest + js-tiktoken test (>85% token savings, latency, recall)
```

- **Runtime Dependencies**:
  - `@modelcontextprotocol/sdk` (or `@modelcontextprotocol/server` + `@modelcontextprotocol/client`): Official protocol primitives.
  - `minisearch`: Zero-dependency in-memory BM25 search engine (<15KB).
  - `zod`: Configuration & argument validation.
  - `commander`: Lightweight CLI framework.
- **Dev Dependencies**:
  - `typescript`, `@types/node`, `tsx`.
  - `vitest`: Unit & integration testing.
  - `js-tiktoken`: Token counting for benchmark assertions.

---

## 5. Phased Implementation Milestones

- [x] **Milestone 0: Project Exploration, Research & Scaffold Verification**
  - Confirmed MCP protocol constraints and analyzed prior art (`mcpproxy-go`, `fastmcp`).
  - Verified runnable stdio server with clean TypeScript build.
  - Created `reference/` directory with untracked reference repositories.
- [ ] **Milestone 1: Configuration Store & Manifest Manager (`src/config.ts`)**
  - Define Zod schemas for servers and manifests.
  - Implement atomic write helpers (`.tmp` write + `fsync` + `rename`).
  - Implement SHA-256 schema hashing.
- [ ] **Milestone 2: In-Memory BM25 Indexer & Taxonomy Generator (`src/indexer.ts`)**
  - Implement `MiniSearch` indexing with field boosts (`name: 3.0`, `description: 1.5`, `parameters: 1.0`).
  - Implement compact 1-line TypeScript AST signature formatter.
  - Implement deterministic taxonomy directory tree builder.
  - Implement deterministic alphabetical sorting for prompt cache preservation.
- [ ] **Milestone 3: Lazy Subprocess Pool & Lifecycle Reaper (`src/pool.ts`)**
  - Implement on-demand child process spawning with `StdioClientTransport`.
  - Implement single-flight initialization lock.
  - Implement 5-minute inactivity timer with `SIGTERM` / `SIGKILL` escalation.
  - Implement process cleanup handlers (`SIGINT`, `SIGTERM`, `exit`) and `stderr` ring buffer.
- [ ] **Milestone 4: Stdio Gateway Server & Meta-Tools (`src/server.ts`)**
  - Expose `search_tools`, `get_tool_schema`, and `execute_tool` via `StdioServerTransport`.
  - Implement error isolation for downstream tool failures.
- [ ] **Milestone 5: Minimal CLI Tool (`bin/sloth.ts`)**
  - Implement `add`, `rm`, `list`, `toggle`, `sync`, and `start` commands.
- [ ] **Milestone 6: Automated Vitest Benchmark & Evaluation Suite (`test/benchmark.test.ts`)**
  - Token consumption benchmark with `js-tiktoken` (proving $\ge 85\%$ token reduction).
  - BM25 query latency benchmark (asserting P95 $< 1\text{ms}$).
  - Precision@K recall evaluation across synthetic developer queries.
  - Subprocess lifecycle unit tests (lazy spawn, single-flight deduplication, auto-reap).
