#!/usr/bin/env node
import { Command } from "commander";
import {
  computeSchemaFingerprint,
  deleteManifest,
  loadAllManifests,
  loadConfig,
  loadManifest,
  saveConfig,
  saveManifest,
  type ManifestData,
  type ServerConfig,
  type ToolDefinition,
} from "../src/config.js";
import { ProcessPool } from "../src/pool.js";
import { createSlothServer } from "../src/server.js";

const program = new Command();

program
  .name("sloth")
  .description("SlothMCP: Dynamic Model Context Protocol (MCP) Gateway & Router")
  .version("0.1.0");

/**
 * Command: sloth add <name> <command> [args...]
 */
program
  .command("add <name> <command> [args...]")
  .description("Register a new downstream MCP server and introspect its tool schemas into cache")
  .option("-e, --env <key=value...>", "Environment variables for the server process", [])
  .option("-t, --tags <tags...>", "Search tags for the server", [])
  .action(async (name: string, command: string, args: string[], options: { env?: string[]; tags?: string[] }) => {
    try {
      const config = loadConfig();

      // Parse env vars
      const envObj: Record<string, string> = {};
      if (options.env) {
        for (const entry of options.env) {
          const [k, ...v] = entry.split("=");
          if (k) envObj[k] = v.join("=");
        }
      }

      const serverConfig: ServerConfig = {
        command,
        args: args || [],
        env: Object.keys(envObj).length > 0 ? envObj : undefined,
        tags: options.tags || [],
        disabled: false,
      };

      config.servers[name] = serverConfig;
      saveConfig(config);

      console.log(`[Sloth] Added server '${name}'. Introspecting tools...`);

      // Introspect tools
      const pool = new ProcessPool();
      pool.updateServerConfigs({ [name]: serverConfig });

      try {
        const rawTools = (await pool.introspectTools(name, true)) as ToolDefinition[];
        const fingerprint = computeSchemaFingerprint(rawTools);

        const manifest: ManifestData = {
          server: name,
          fingerprint,
          indexedAt: Date.now(),
          tools: rawTools,
        };

        saveManifest(manifest);
        console.log(`[Sloth] Successfully cached ${rawTools.length} tool(s) for '${name}' (Fingerprint: ${fingerprint.slice(0, 12)}...)`);
      } catch (err) {
        console.warn(`[Sloth] Note: Could not introspect tools immediately (${err instanceof Error ? err.message : String(err)}). Manifest will be created on first start.`);
      }

      console.log(`[Sloth] Server '${name}' registered successfully.`);
    } catch (error) {
      console.error("[Sloth] Error adding server:", error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

/**
 * Command: sloth rm <name>
 */
program
  .command("rm <name>")
  .alias("remove")
  .description("Remove a downstream MCP server and delete its cached manifest")
  .action((name: string) => {
    const config = loadConfig();
    if (!config.servers[name]) {
      console.error(`[Sloth] Server '${name}' does not exist in configuration.`);
      process.exit(1);
    }

    delete config.servers[name];
    saveConfig(config);
    deleteManifest(name);

    console.log(`[Sloth] Server '${name}' and cached manifest removed.`);
  });

/**
 * Command: sloth list
 */
program
  .command("list")
  .alias("ls")
  .description("List all registered downstream MCP servers, status, and cached tool counts")
  .action(() => {
    const config = loadConfig();
    const manifests = loadAllManifests();
    const serverNames = Object.keys(config.servers);

    if (serverNames.length === 0) {
      console.log("[Sloth] No servers registered yet. Use `sloth add <name> <command>` to register one.");
      return;
    }

    console.log("\nRegistered Downstream Servers:");
    console.log("─".repeat(70));
    console.log(
      `${"Name".padEnd(16)} ${"Status".padEnd(12)} ${"Tools".padEnd(8)} ${"Command"}`
    );
    console.log("─".repeat(70));

    for (const name of serverNames) {
      const srv = config.servers[name];
      const manifest = manifests.get(name) || loadManifest(name);
      const toolCount = manifest ? manifest.tools.length : 0;
      const status = srv.disabled ? "disabled" : "enabled";
      const fullCmd = [srv.command, ...(srv.args || [])].join(" ");

      console.log(
        `${name.padEnd(16)} ${status.padEnd(12)} ${String(toolCount).padEnd(8)} ${fullCmd}`
      );
    }
    console.log("─".repeat(70) + "\n");
  });

/**
 * Command: sloth toggle <name>
 */
program
  .command("toggle <name>")
  .description("Enable or disable a downstream server without deleting its configuration")
  .action((name: string) => {
    const config = loadConfig();
    const srv = config.servers[name];
    if (!srv) {
      console.error(`[Sloth] Server '${name}' not found.`);
      process.exit(1);
    }

    srv.disabled = !srv.disabled;
    saveConfig(config);

    console.log(`[Sloth] Server '${name}' is now ${srv.disabled ? "disabled" : "enabled"}.`);
  });

/**
 * Command: sloth sync [name]
 */
program
  .command("sync [name]")
  .description("Introspect upstream servers and refresh schema cache with SHA-256 fingerprint verification")
  .action(async (targetName?: string) => {
    const config = loadConfig();
    const pool = new ProcessPool();
    pool.updateServerConfigs(config.servers);

    const serversToSync = targetName ? [targetName] : Object.keys(config.servers);

    console.log(`[Sloth] Syncing ${serversToSync.length} server(s)...`);

    for (const name of serversToSync) {
      const srv = config.servers[name];
      if (!srv) {
        console.warn(`[Sloth] Server '${name}' not found in configuration.`);
        continue;
      }

      if (srv.disabled) {
        console.log(`[Sloth] Skipping disabled server '${name}'.`);
        continue;
      }

      try {
        console.log(`[Sloth] Introspecting '${name}'...`);
        const rawTools = (await pool.introspectTools(name, true)) as ToolDefinition[];
        const newFingerprint = computeSchemaFingerprint(rawTools);
        const oldManifest = loadManifest(name);

        if (oldManifest && oldManifest.fingerprint === newFingerprint) {
          console.log(`[Sloth] '${name}' schemas unchanged (Fingerprint: ${newFingerprint.slice(0, 12)}...). Skipping rewrite.`);
        } else {
          const manifest: ManifestData = {
            server: name,
            fingerprint: newFingerprint,
            indexedAt: Date.now(),
            tools: rawTools,
          };
          saveManifest(manifest);
          console.log(`[Sloth] Updated manifest for '${name}' (${rawTools.length} tool(s)).`);
        }
      } catch (err) {
        console.error(`[Sloth] Failed to sync '${name}':`, err instanceof Error ? err.message : String(err));
      }
    }

    console.log("[Sloth] Sync complete.");
  });

/**
 * Command: sloth start (or default)
 */
program
  .command("start", { isDefault: true })
  .description("Start the SlothMCP Gateway Server over stdio (connect with Claude Desktop / Cursor)")
  .action(async () => {
    const sloth = createSlothServer();
    await sloth.start();
  });

program.parse(process.argv);
