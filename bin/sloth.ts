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
import { runDoctor } from "../src/doctor.js";
import {
  detectHarnesses,
  installSlothToHarness,
  readHarnessServers,
  SUPPORTED_HARNESSES,
  uninstallSlothFromHarness,
  type HarnessId,
} from "../src/harnesses.js";
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
 * Command: sloth harnesses
 */
program
  .command("harnesses")
  .description("Scan and list all detected AI client harnesses (Claude Desktop, Cursor, VS Code, etc.)")
  .action(() => {
    const statuses = detectHarnesses();

    console.log("\nDetected AI Client Harnesses:");
    console.log("─".repeat(85));
    console.log(
      `${"Harness ID".padEnd(18)} ${"Installed".padEnd(12)} ${"Sloth Active".padEnd(15)} ${"Servers".padEnd(10)} ${"Path"}`
    );
    console.log("─".repeat(85));

    for (const st of statuses) {
      const installedStr = st.installed ? "Yes" : "No";
      const slothStr = st.hasSlothConfigured ? "Configured" : "Not yet";
      console.log(
        `${st.id.padEnd(18)} ${installedStr.padEnd(12)} ${slothStr.padEnd(15)} ${String(st.serverCount).padEnd(10)} ${st.configPath}`
      );
    }
    console.log("─".repeat(85) + "\n");
  });

/**
 * Command: sloth import [harness]
 */
program
  .command("import [harness]")
  .description("Import downstream MCP servers from a client harness config, preserving enabled and disabled states")
  .option("-s, --sync", "Automatically introspect tools and build manifest cache after import", true)
  .action(async (targetHarness?: string, options?: { sync?: boolean }) => {
    const harnessesToImport: HarnessId[] = targetHarness
      ? [targetHarness as HarnessId]
      : (Object.keys(SUPPORTED_HARNESSES) as HarnessId[]);

    const config = loadConfig();
    let totalImported = 0;

    for (const hId of harnessesToImport) {
      if (!SUPPORTED_HARNESSES[hId]) {
        console.warn(`[Sloth] Unknown harness '${hId}'. Supported: ${Object.keys(SUPPORTED_HARNESSES).join(", ")}`);
        continue;
      }

      const records = readHarnessServers(hId);
      if (records.length === 0) {
        continue;
      }

      console.log(`[Sloth] Found ${records.length} server(s) in ${SUPPORTED_HARNESSES[hId].displayName}:`);

      for (const rec of records) {
        const statusLabel = rec.config.disabled ? "[disabled]" : "[enabled]";
        console.log(`  • ${rec.name} ${statusLabel} -> ${rec.config.command} ${(rec.config.args || []).join(" ")}`);
        config.servers[rec.name] = rec.config;
        totalImported++;
      }
    }

    if (totalImported === 0) {
      console.log("[Sloth] No servers found to import.");
      return;
    }

    saveConfig(config);
    console.log(`\n[Sloth] Successfully imported ${totalImported} server(s) into Sloth configuration.`);

    // Run sync if requested
    if (options?.sync) {
      console.log("[Sloth] Introspecting imported server schemas...");
      const pool = new ProcessPool();
      pool.updateServerConfigs(config.servers);

      for (const [name, srv] of Object.entries(config.servers)) {
        if (srv.disabled) {
          console.log(`[Sloth] Skipping disabled server '${name}' from initial spawn.`);
          continue;
        }

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
          console.log(`[Sloth] Cached ${rawTools.length} tool(s) for '${name}'.`);
        } catch (err) {
          console.warn(`[Sloth] Note: '${name}' could not be introspected right now (${err instanceof Error ? err.message : String(err)}).`);
        }
      }
    }

    console.log("[Sloth] Import complete. Use `sloth list` to view.");
  });

/**
 * Command: sloth install <harness>
 */
program
  .command("install <harness>")
  .description("Safely configure an AI harness to point to SlothMCP (creates timestamped .bak backup)")
  .action((harnessId: string) => {
    if (!SUPPORTED_HARNESSES[harnessId as HarnessId]) {
      console.error(`[Sloth] Unsupported harness '${harnessId}'. Supported: ${Object.keys(SUPPORTED_HARNESSES).join(", ")}`);
      process.exit(1);
    }

    const res = installSlothToHarness(harnessId as HarnessId);
    console.log(`[Sloth] Successfully installed SlothMCP gateway into ${SUPPORTED_HARNESSES[harnessId as HarnessId].displayName}!`);
    console.log(`[Sloth] Target Config: ${res.configPath}`);
    if (res.backupPath) {
      console.log(`[Sloth] Backup created: ${res.backupPath}`);
    }
  });

/**
 * Command: sloth uninstall <harness>
 */
program
  .command("uninstall <harness>")
  .description("Remove SlothMCP gateway entry from an AI harness configuration")
  .action((harnessId: string) => {
    if (!SUPPORTED_HARNESSES[harnessId as HarnessId]) {
      console.error(`[Sloth] Unsupported harness '${harnessId}'.`);
      process.exit(1);
    }

    const removed = uninstallSlothFromHarness(harnessId as HarnessId);
    if (removed) {
      console.log(`[Sloth] Successfully uninstalled SlothMCP from ${SUPPORTED_HARNESSES[harnessId as HarnessId].displayName}.`);
    } else {
      console.log(`[Sloth] Sloth was not found or already uninstalled from ${SUPPORTED_HARNESSES[harnessId as HarnessId].displayName}.`);
    }
  });

/**
 * Command: sloth doctor
 */
program
  .command("doctor")
  .description("Perform health checks on Node runtime, config files, client harnesses, and server paths")
  .action(() => {
    const checks = runDoctor();

    console.log("\nSlothMCP System & Health Doctor:");
    console.log("─".repeat(80));
    console.log(
      `${"Category".padEnd(16)} ${"Status".padEnd(10)} ${"Check Name".padEnd(30)} Details`
    );
    console.log("─".repeat(80));

    for (const c of checks) {
      const statusSymbol = c.status === "ok" ? "✓ OK" : c.status === "warn" ? "⚠ WARN" : "✗ ERROR";
      console.log(
        `${c.category.padEnd(16)} ${statusSymbol.padEnd(10)} ${c.name.padEnd(30)} ${c.message}`
      );
    }
    console.log("─".repeat(80) + "\n");
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
