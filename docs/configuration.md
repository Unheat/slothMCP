# SlothMCP Configuration & CLI Reference

This guide details all configuration options, file locations, schemas, and CLI commands.

---

## 1. Storage Locations & Architecture

SlothMCP maintains two clean, isolated directories:

1. **Configuration Store**: `~/.config/sloth/mcp.json`
   - Stores server commands, arguments, environment variables, tags, and lifecycle modes.
   - Overrideable via `SLOTH_CONFIG_DIR` environment variable.
2. **Manifest Cache**: `~/.cache/sloth/manifests/<server>.json`
   - Stores introspected tool definitions, descriptions, JSONSchemas, and SHA-256 fingerprints.
   - Overrideable via `SLOTH_CACHE_DIR` environment variable.

All disk writes are **atomic** (writing to `.tmp` files, flushing to disk, and renaming) to prevent JSON corruption during concurrent operations.

---

## 2. Configuration Schema (`~/.config/sloth/mcp.json`)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "idleTimeoutMs": 300000,
  "defaultOnDemand": true,
  "servers": {
    "docker": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-docker"],
      "env": {
        "DOCKER_HOST": "unix:///var/run/docker.sock"
      },
      "tags": ["containers", "devops"],
      "disabled": false,
      "onDemand": true
    },
    "postgres": {
      "command": "postgres-mcp",
      "args": ["postgresql://localhost:5432/production"],
      "tags": ["database", "sql"],
      "disabled": false,
      "onDemand": false
    }
  }
}
```

### Configuration Fields:

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `idleTimeoutMs` | number | `300000` (5m) | Inactivity timeout in milliseconds before an idle on-demand child process is reaped. |
| `defaultOnDemand`| boolean | `true` | Global default lifecycle mode. `true` = lazy spawn on demand; `false` = always-on persistent. |
| `servers` | object | `{}` | Map of registered downstream MCP servers keyed by unique server namespace name. |

### Per-Server Fields:

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `command` | string | *(required)* | The executable command to launch the downstream server. |
| `args` | string[] | `[]` | Command line arguments passed to the server process. |
| `env` | object | `undefined` | Environment variables injected into the child process. |
| `disabled` | boolean | `false` | When `true`, completely excluded from search index, taxonomy, and process pool (0 tokens, 0 RAM). |
| `tags` | string[] | `[]` | Search keywords used by MiniSearch BM25 ranking. |
| `onDemand` | boolean | `undefined` | If set, overrides `defaultOnDemand`. `true` = lazy lifecycle; `false` = persistent boot without reaping. |

---

## 3. CLI Command Reference

### `sloth list` (alias: `ls`)
Prints a formatted table of all registered servers, enabled status, lifecycle mode, cached tool count, and command:
```bash
sloth list
```

### `sloth add <name> <command> [args...]`
Registers a new downstream server and immediately introspects its tool schemas:
```bash
# Add an on-demand Docker server
sloth add docker npx -y @modelcontextprotocol/server-docker

# Add an always-on PostgreSQL server with environment variables and tags
sloth add postgres postgres-mcp -e DATABASE_URL=postgres://localhost:5432/db -t sql database --always-on
```

### `sloth rm <name>` (alias: `remove`)
Removes a server from `mcp.json` and deletes its cached manifest:
```bash
sloth rm docker
```

### `sloth toggle <name>`
Instantly enables or disables a server without deleting its configuration:
```bash
sloth toggle postgres
```

### `sloth sync [name]`
Introspects registered servers and updates cached manifests. Uses SHA-256 fingerprinting to skip disk rewrites if schemas haven't changed:
```bash
sloth sync
sloth sync docker
```

### `sloth config`
Get or set global and per-server settings:
```bash
# View configuration
sloth config get
sloth config get idleTimeoutMs

# Set global idle timeout (10 minutes)
sloth config set idleTimeoutMs 600000

# Set a server to always-on mode
sloth config set postgres onDemand false

# Set a server back to on-demand mode
sloth config set postgres onDemand true
```

### `sloth doctor`
Runs a comprehensive system diagnostic checking Node runtime compatibility, config file health, detected client harnesses, and server command availability:
```bash
sloth doctor
```
