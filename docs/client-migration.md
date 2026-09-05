# Client Harness Integration & Migration Guide

SlothMCP provides automated discovery, server import, safe installation, and byte-for-byte rollback across all major AI developer environments.

---

## 1. Supported Client Harnesses & Paths

SlothMCP natively resolves configuration file locations across macOS, Linux, and Windows:

| Client Harness | Config File Path | Configuration Key |
| :--- | :--- | :--- |
| **Cursor IDE** | `~/.cursor/mcp.json` | `mcpServers` |
| **Claude Desktop** | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`<br>Linux: `~/.config/Claude/claude_desktop_config.json`<br>Windows: `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| **Claude Code CLI**| `~/.claude.json` | `mcpServers` |
| **VS Code** | macOS: `~/Library/Application Support/Code/User/mcp.json`<br>Linux: `~/.config/Code/User/mcp.json`<br>Windows: `%APPDATA%\Code\User\mcp.json` | `servers` |
| **Windsurf IDE** | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| **Google Antigravity**| `~/.gemini/antigravity/mcp_config.json` | `mcpServers` |
| **OpenCode** | `~/.config/opencode/opencode.json` | `mcp` |

---

## 2. Detecting Installed Clients

Check which AI environments are installed on your machine and whether Sloth is configured:

```bash
npx sloth harnesses
```

**Output Example:**
```text
Detected AI Client Harnesses:
─────────────────────────────────────────────────────────────────────────────────────
Harness ID         Installed    Sloth Active    Servers    Path
─────────────────────────────────────────────────────────────────────────────────────
cursor             Yes          Configured      1          /Users/dev/.cursor/mcp.json
claude-desktop     Yes          Not yet         5          /Users/dev/Library/Application Support/Claude/claude_desktop_config.json
claude-code        Yes          Not yet         2          /Users/dev/.claude.json
vscode             Yes          Not yet         3          /Users/dev/Library/Application Support/Code/User/mcp.json
windsurf           No           Not yet         0          /Users/dev/.codeium/windsurf/mcp_config.json
─────────────────────────────────────────────────────────────────────────────────────
```

---

## 3. The Migration Workflow (`--migrate`)

### The Problem with Naive Installation
If you add `"sloth"` to your IDE's config while leaving 15 existing servers defined, your IDE will connect to **all 15 servers AND Sloth** simultaneously. The IDE UI remains flooded with 50+ tool schemas, eliminating the token reduction benefit.

### The Sloth `--migrate` Solution

Run:
```bash
npx sloth install cursor --migrate
```

**What Happens Under the Hood:**
1. **Full State Extraction**: Reads all servers defined in `~/.cursor/mcp.json`, preserving commands, args, environment variables, and `disabled: true` states.
2. **Rolling Backup**: Creates a timestamped byte-for-byte backup of your original configuration:
   `~/.cursor/mcp.json.bak.1756789000000`
3. **Sloth Config Update**: Writes all extracted servers into `~/.config/sloth/mcp.json`.
4. **Tool Introspection**: Automatically spawns each server once, introspects its tool schemas, computes a SHA-256 fingerprint, and stores the manifest in `~/.cache/sloth/manifests/`.
5. **Client Config Handoff**: Replaces the client's `mcpServers` section so **ONLY `"sloth"` is active**:
   ```json
   {
     "mcpServers": {
       "sloth": {
         "command": "node",
         "args": ["/path/to/sloth/build/src/index.js"]
       }
     }
   }
   ```
6. **Result**: When you open Cursor, the tool menu shows **only Sloth's 3 meta-tools**, cutting token usage by 85% while Sloth lazily manages all 15 servers in the background.

---

## 4. Reverting / Rollback (`--restore`)

If you ever want to uninstall Sloth and restore your original configuration:

```bash
npx sloth uninstall cursor --restore
```

**What Happens Under the Hood:**
1. Sloth locates the latest `.bak` backup file for Cursor.
2. Restores `~/.cursor/mcp.json` byte-for-byte to its pre-Sloth state.
3. Deletes the temporary backup file.

If you run `npx sloth uninstall cursor` without `--restore`, it cleanly removes only the `"sloth"` entry from the client's configuration while leaving all other entries intact.
