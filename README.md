<div align="center">

# SlothMCP

**A sub-millisecond, zero-infrastructure Model Context Protocol (MCP) Gateway that cuts LLM token bloat by 85% and idle RAM by 98%.**

[![CI](https://github.com/Unheat/slothMCP/actions/workflows/ci.yml/badge.svg)](https://github.com/Unheat/slothMCP/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)

[Quickstart](#quickstart) • [Benchmarks](docs/benchmarks.md) • [Architecture](docs/architecture.md) • [Client Migration](docs/client-migration.md) • [Configuration Reference](docs/configuration.md) • [Output Shaper](docs/output-shaper.md)

</div>

---

## The Problem

Modern AI workflows connect LLM coding agents (Cursor, Claude Desktop, VS Code, Windsurf) to dozens of external MCP servers (Docker, Postgres, GitHub, AWS, Kubernetes). 

Directly loading all tool schemas into the host IDE causes three critical bottlenecks:
1. **Prompt Context Saturation:** 30–50 full JSON tool schemas consume **3,500–5,000 tokens on every prompt turn**, draining context windows before work begins.
2. **Tool Selection Degradation:** LLM routing accuracy drops sharply when selecting across >15 tools simultaneously (the "needle-in-a-haystack" schema issue).
3. **Idle Resource Waste:** Spawning 15–20 persistent downstream Node/Python/Docker child processes consumes **1.5GB–2.2GB of idle RAM**.

---

## The Sloth Solution

**SlothMCP** acts as a single, ultra-lightweight stdio MCP server facing your IDE while lazily brokering requests to all your downstream tools.

```text
┌─────────────────────────┐
│ Host IDE (Cursor/Claude)│
└────────────┬────────────┘
             │ stdio JSON-RPC (Exposes exactly 3 Meta-Tools: ~500 tokens)
             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                          SlothMCP Gateway                              │
│                                                                        │
│  • search_tools(query) ──► In-Memory MiniSearch BM25 (P50 = 56 µs)     │
│  • get_tool_schema(s,t) ─► Progressive disclosure of raw JSONSchemas   │
│  • execute_tool(s,t,a) ──► Self-healing argument auto-repair           │
│                                                                        │
│  Lazy Subprocess Pool (0 MB idle RAM; on-demand spawn + 5m TTL reap)   │
└──────────────┬─────────────────────────────┬───────────────────────────┘
               │ (wakes up on demand)        │ (wakes up on demand)
               ▼                             ▼
      ┌─────────────────┐           ┌─────────────────┐
      │  Docker MCP     │           │  Postgres MCP   │
      └─────────────────┘           └─────────────────┘
```

---

## Benchmarks

All metrics measured on an Apple Silicon M-series machine using the automated benchmark suite (`test/benchmark.test.ts` with `js-tiktoken` and `cl100k_base`):

| Benchmark Metric | Direct MCP (Normal Setup) | SlothMCP Gateway | Net Savings / Impact |
| :--- | :---: | :---: | :--- |
| **Input Schema Load (Per Turn)** | 3,613 tokens / turn | **521 tokens / turn** | **85.21% Net Token Reduction** |
| **10-Turn Conversation Total** | 36,130 tokens | **5,344 tokens** | **30,786 tokens saved** |
| **Output Table Bloat (50 records)** | 4,616 tokens | **1,591 tokens** | **65.53% Output Token Reduction** |
| **Oversized Log Dump (>50KB)** | Floods context (40k+ tokens) | Hard-capped (20% head / 80% tail) | **100% stack trace preservation** |
| **Idle Memory (15 servers)** | ~1.5 GB – 2.2 GB RAM | **~18 MB RAM** | **> 98% RAM Savings** |
| **Search Routing Latency (P95)** | N/A | **0.267 ms (267 µs)** | Instant (< 1ms routing overhead) |
| **Retrieval Accuracy (Precision@3)** | Degrades past 15 tools | **100.00% (12/12)** | Perfect recall via field boosting |

---

## Supported AI Client Harnesses

SlothMCP works seamlessly with standard `stdio` MCP clients across **macOS, Linux, and Windows**:

| Harness | ID | Default Config Location | Support Level |
| :--- | :--- | :--- | :---: |
| **Cursor IDE** | `cursor` | `~/.cursor/mcp.json` | Full (1-Click Migrate & Rollback) |
| **Claude Desktop** | `claude-desktop` | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)<br>`~/.config/Claude/claude_desktop_config.json` (Linux)<br>`%APPDATA%\Claude\claude_desktop_config.json` (Windows) | Full (1-Click Migrate & Rollback) |
| **VS Code (Copilot Chat)** | `vscode` | `~/Library/Application Support/Code/User/mcp.json` (macOS)<br>`~/.config/Code/User/mcp.json` (Linux)<br>`%APPDATA%\Code\User\mcp.json` (Windows) | Full (1-Click Migrate & Rollback) |
| **Claude Code CLI** | `claude-code` | `~/.claude.json` | Full (1-Click Migrate & Rollback) |
| **Windsurf IDE (Codeium)** | `windsurf` | `~/.codeium/windsurf/mcp_config.json` | Full (1-Click Migrate & Rollback) |
| **Google Antigravity** | `antigravity` | `~/.gemini/antigravity/mcp_config.json` | Full (1-Click Migrate & Rollback) |
| **OpenCode** | `opencode` | `~/.config/opencode/opencode.json` | Full (1-Click Migrate & Rollback) |

> [!NOTE]
> Run `npx sloth harnesses` to automatically scan your machine and detect which of these clients are installed and whether Sloth is active.

---

## Quickstart

Run SlothMCP instantly with zero global installation:

### 1. One-Click IDE Migration

Migrate all existing MCP servers from Cursor into Sloth with an automated backup:

```bash
npx sloth install cursor --migrate
```

Or for Claude Desktop:

```bash
npx sloth install claude-desktop --migrate
```

> [!TIP]
> The `--migrate` flag automatically imports all existing servers into Sloth (preserving enabled and disabled states), creates a rolling timestamped `.bak` backup, and configures the IDE to talk exclusively to Sloth.

### 2. Verify Your Setup

```bash
npx sloth doctor
```

```text
SlothMCP System & Health Doctor:
─────────────────────────────────────────────────────────────────────────────────────
Category   Item                 Status  Details
─────────────────────────────────────────────────────────────────────────────────────
Node       Node.js Runtime      ok      v22.14.0 (>= 20 supported)
Configs    Sloth Config         ok      ~/.config/sloth/mcp.json (3 servers)
Harnesses  Cursor IDE           ok      Installed & Sloth Active (1 server configured)
Servers    Server 'docker'      ok      docker-mcp (enabled, on-demand, 4 cached tools)
Servers    Server 'postgres'    ok      postgres-mcp (enabled, on-demand, 3 cached tools)
─────────────────────────────────────────────────────────────────────────────────────
System Status: HEALTHY. SlothMCP is ready to route tools.
```

---

## Key Features

### 1. Fixed 40-Token Taxonomy (Solves "Discovery Invisibility")
Hiding tools behind dynamic search usually causes LLMs to ignore MCP and fall back to raw bash `grep` or `find`. 

SlothMCP embeds an alphabetically sorted, deterministic directory tree directly into the description of `search_tools`:
```text
Dynamic MCP Registry. MANDATORY: Search here before running raw terminal scripts.
Available Namespaces & Tools:
• /codebase/*   -> [find_symbol, text_search]
• /database/*   -> [inspect_tables, query, run_migration]
• /docker/*     -> [exec, logs, ps, restart]
• /github/*     -> [create_pull_request, get_file_contents, list_issues]
```
The model receives 100% global capability visibility upfront for just ~40 tokens.

### 2. In-Memory BM25 Indexer & Compact AST Signatures
- Uses `minisearch` with field-level boosting: `name (5.0)`, `canonical ID (4.0)`, `parameters (2.0)`, `description (1.5)`.
- Converts verbose JSONSchemas into compact 1-line TypeScript AST signatures:
  ```text
  docker.restart(container: string, timeout?: number): Restart a running container
  ```
  Saves **~75% of tokens** on search results compared to raw JSONSchema.

### 3. Configurable Lifecycle: On-Demand by Default vs. Always-On
- **On-Demand (Default):** Processes stay dormant (0 MB RAM). When invoked, they wake up lazily and auto-reap via `SIGTERM` (with 3s `SIGKILL` escalation) after 5 minutes of inactivity.
- **Always-On:** Need a database or stateful server always running? Set `onDemand: false`. Sloth pre-warms it on gateway startup and disables idle reaping.

### 4. Output Shaper & Context Guard
- **Tabular Array Compression:** Detects uniform JSON arrays ($\ge 3$ records) and converts them into compact typed CSV tables (`[50]{id,name,status}:`). Yields **65.53% token reduction**.
- **Smart Sandwich Slicing:** When logs or build outputs exceed 30KB, preserves **20% Head (~6,000 chars)** and **80% Tail (~24,000 chars)**. Critical stack traces, compiler errors, and exit codes at the bottom are never lost.

### 5. Self-Healing Argument Auto-Repair
- **Fuzzy Key Matching:** Remaps misnamed keys (e.g. `container_name`, `containerId`, or `target_container` $\to$ `container`) automatically using normalized Levenshtein heuristics.
- **Type Coercion:** Coerces string numbers (`"8080"` $\to$ `8080`) and booleans (`"true"` $\to$ `true`) to match the target schema.
- **Error Signatures:** If an argument is missing, returns the exact compact tool signature in the error output for instant single-turn self-correction.

---

## CLI Reference

| Command | Usage | Description |
| :--- | :--- | :--- |
| **`sloth list`** | `sloth list` | Displays table of all registered servers, mode (`on-demand` vs `always-on`), and tool counts. |
| **`sloth add`** | `sloth add <name> <cmd> [args...] [--always-on]` | Registers an MCP server, introspects its tools, and caches its manifest. |
| **`sloth rm`** | `sloth rm <name>` | Removes server and deletes its cached manifest. |
| **`sloth toggle`** | `sloth toggle <name>` | Instantly enables or disables a server without deleting its config. |
| **`sloth sync`** | `sloth sync [name]` | Spawns servers, verifies SHA-256 fingerprints, and refreshes manifests. |
| **`sloth config`** | `sloth config set <server> onDemand <true\|false>` | Toggles on-demand vs always-on mode for a server or global default. |
| **`sloth harnesses`**| `sloth harnesses` | Scans host machine and lists detected AI clients (Claude Desktop, Cursor, VS Code, etc.). |
| **`sloth import`** | `sloth import [harness]` | Imports all servers from an existing IDE config into Sloth (preserving enabled/disabled). |
| **`sloth install`**| `sloth install <harness> [--migrate]` | Configures IDE to use SlothMCP with automated rolling `.bak` backup. |
| **`sloth uninstall`**| `sloth uninstall <harness> [--restore]` | Removes Sloth from IDE config, or restores original configuration from backup. |
| **`sloth doctor`** | `sloth doctor` | Comprehensive health check on Node runtime, paths, configs, and harnesses. |

---

## Documentation

For in-depth architectural proofs, protocol specifications, benchmarks, and configuration guides:

- 📖 **[System Architecture & Protocol](docs/architecture.md)** — Stdio JSON-RPC boundary, 3 meta-tools, lazy state machine, single-flight locking.
- 📊 **[Empirical Benchmarks & Token Proof](docs/benchmarks.md)** — Mathematical token derivation, 1,000-query latency percentiles, precision metrics.
- 🚀 **[Client Harness Migration Guide](docs/client-migration.md)** — One-click setup and rollback for Cursor, Claude Desktop, VS Code, and Windsurf.
- ⚙️ **[Configuration & CLI Reference](docs/configuration.md)** — Complete `mcp.json` schema, on-demand vs always-on lifecycle, command matrix.
- 🛡️ **[Output Shaper & Context Guard](docs/output-shaper.md)** — In-memory tabular shape compression and 20/80 sandwich slicing.

---

## Architecture Principles

Built strictly under the **"LazyDev / Ponytail"** engineering philosophy:
- **Zero Heavy Infrastructure:** No Docker, no Python, no SQLite, no local ONNX vector runtimes. Runs everywhere standard Node.js $\ge 20$ is installed.
- **Process Hygiene:** Multiplexes stdio streams, captures child `stderr` in a 50-line circular ring buffer, and handles `SIGINT`/`SIGTERM` cleanly.
- **Atomic File Persistence:** All config writes use temporary files + `fsync` + atomic renames to prevent JSON corruption during IDE concurrent saves.

---

## Testing & Verification

Run the comprehensive test and evaluation suite:

```bash
npm test
```

```text
✓ test/indexer.test.ts   (5 tests)
✓ test/cli.test.ts       (4 tests)
✓ test/config.test.ts    (4 tests)
✓ test/harnesses.test.ts (4 tests)
✓ test/shaper.test.ts    (6 tests)
✓ test/repair.test.ts    (4 tests)
✓ test/benchmark.test.ts (3 tests)
✓ test/server.test.ts    (5 tests)
✓ test/pool.test.ts      (9 tests)

Test Files: 9 passed (9)
Tests:      44 passed (44)
Duration:   ~3.7s
```

Compile TypeScript:

```bash
npm run build
```
