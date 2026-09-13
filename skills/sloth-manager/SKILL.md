---
name: sloth-manager
description: Operate and manage SlothMCP, the MCP gateway/router that aggregates MCP servers behind one entry point across AI harnesses (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Antigravity, OpenCode, ZCode). Use when the user asks to install/uninstall/configure the Sloth MCP gateway in a harness, migrate existing MCP servers into Sloth, add/remove/toggle/sync downstream MCP servers, eject/restore harness MCP configs, or diagnose MCP setup problems (sloth doctor).
---

# SlothMCP Manager

SlothMCP is a dynamic MCP gateway: instead of each AI harness (IDE/CLI) connecting to N
separate MCP server processes, the harness connects only to Sloth, and Sloth spawns, routes
to, and caches the downstream servers on demand. This skill teaches you how to operate the
`sloth` CLI to manage that setup on the user's behalf.

## Core concepts

- **Harness**: an AI client whose config file Sloth can manage (e.g. `claude-code`,
  `cursor`, `vscode`, `zcode`). Each harness has a known config path and a server section
  key (most use top-level `mcpServers`; ZCode uses nested `mcp.servers`).
- **Downstream server**: a real MCP server registered in Sloth's own config
  (`~/.config/sloth/mcp.json`, override with `SLOTH_CONFIG_DIR`).
- **Gateway entry**: the single `sloth` entry written into a harness config. When present,
  the harness routes all MCP traffic through Sloth.

## Command reference

Run `sloth <command>` via Bash. All commands are safe to run read-only unless noted.

| Command | Purpose |
| :--- | :--- |
| `sloth harnesses` | Scan the machine: which harnesses are installed, whether Sloth is wired in. |
| `sloth doctor` | Health checks: Node runtime, config files, harness wiring, server paths. |
| `sloth list` | List registered downstream servers, their status, and cached tool counts. |
| `sloth add <name> <command> [args...]` | Register a downstream server and cache its tool schemas. Flags: `-e key=value` (env), `-t tag...` (search tags), `--always-on` (disable idle reaping). |
| `sloth rm <name>` | Remove a downstream server and its cached manifest. |
| `sloth toggle <name>` | Enable/disable a downstream server without deleting it. |
| `sloth sync [name]` | Re-introspect upstream servers and refresh the schema cache. |
| `sloth config get` / `sloth config set <target> [field] [val]` | View/modify Sloth settings. |
| `sloth import [harness]` | Import servers from a harness config into Sloth (preserves enabled/disabled). |
| `sloth install <harness> [--migrate]` | Wire the harness to Sloth. Creates a timestamped `.bak` backup first. With `--migrate`, also imports existing servers and leaves only `sloth` in the harness config. |
| `sloth eject <harness>` | Undo: restore servers into the harness config and remove the `sloth` entry. Prefers the latest `.bak` backup (byte-for-byte); otherwise dynamically exports Sloth's servers back. Alias: `sloth restore`. |
| `sloth uninstall <harness> [--restore]` | Remove the `sloth` entry only. With `--restore`, behaves like eject. |

`start` (the default command) launches the stdio gateway — harnesses run it themselves; you
normally never run it manually.

## Workflows

**Install Sloth into a harness (replacing direct server connections):**

1. `sloth harnesses` — confirm the harness is detected and see its config path.
2. `sloth install <harness-id> --migrate` — migrate existing servers in and point the
   harness at Sloth. Always prefer `--migrate` unless the user wants to keep servers
   configured both directly and in Sloth.
3. `sloth list` — verify the imported servers are present.
4. Tell the user to restart the harness app; MCP config is read at session start.

**Register a new downstream server:**

1. `sloth add <name> <command> [args...] -e KEY=value -t tag` — the command must be
   executable on the user's PATH (or an absolute path).
2. `sloth sync <name>` if the schema cache needs a refresh after the server changed.

**Remove Sloth from a harness:**

1. `sloth eject <harness-id>` — restores the original config (backup) or re-exports the
   servers.
2. Confirm with `sloth harnesses` that `hasSlothConfigured` is now false.
3. If the user wants Sloth fully gone, repeat for each installed harness before removing
   the package.

**Handling large tool outputs (`read_result`):**

When `execute_tool` runs a downstream tool whose output exceeds `resultInlineMaxBytes` (~30KB),
it atomically stores the full unmutated result in the local cache and returns a bounded preview
with an opaque `result_id`.

1. To inspect structured data: `read_result(result_id, view: "json", path: "/items", offset: 0, limit: 20)`
2. To inspect logs/text: `read_result(result_id, view: "text", offset: 0, limit: 200)`
3. To inspect metadata/envelope: `read_result(result_id, view: "envelope")`
4. For exact lossless byte reassembly: `read_result(result_id, view: "raw", offset: 0, limit: 24576)`
5. **Rule for write/destructive tools:** Never call `execute_tool` again with the same write arguments just to re-fetch omitted output—always use `read_result` with the returned `result_id`.

## Safety rules

- Never hand-edit a harness config file while the Sloth gateway is installed in it — use
  `sloth install` / `eject` / `uninstall` so the timestamped `.bak` backups stay consistent.
- `sloth install` and `eject` modify real user config files. Report the created/used
  `.bak.<timestamp>` path in your summary so the user knows their rollback point.
- When testing install/eject behavior, always use an isolated fake `HOME`
  (e.g. `HOME=$(mktemp -d) sloth install ...`) — never test against the real
  `~/.zcode`, `~/.claude.json`, etc.
- ZCode's config parser is strict: entries with unknown keys are silently dropped. Do not
  hand-craft entries with `disabled`; Sloth writes `type: "stdio"` / `enabled: false`
  itself.
