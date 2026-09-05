import { copyFileSync, existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig, saveConfig, writeJsonAtomic, type ServerConfig } from "./config.js";

export type HarnessId =
  | "claude-desktop"
  | "cursor"
  | "claude-code"
  | "windsurf"
  | "vscode"
  | "antigravity"
  | "opencode";

export interface HarnessDefinition {
  id: HarnessId;
  displayName: string;
  configKey: "mcpServers" | "servers" | "mcp";
  getPath: (platform?: NodeJS.Platform) => string;
}

export const SUPPORTED_HARNESSES: Record<HarnessId, HarnessDefinition> = {
  "claude-desktop": {
    id: "claude-desktop",
    displayName: "Claude Desktop",
    configKey: "mcpServers",
    getPath: (platform = process.platform) => {
      if (platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
      }
      if (platform === "win32") {
        const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        return join(appData, "Claude", "claude_desktop_config.json");
      }
      return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
    },
  },
  cursor: {
    id: "cursor",
    displayName: "Cursor IDE",
    configKey: "mcpServers",
    getPath: () => join(homedir(), ".cursor", "mcp.json"),
  },
  "claude-code": {
    id: "claude-code",
    displayName: "Claude Code CLI",
    configKey: "mcpServers",
    getPath: () => join(homedir(), ".claude.json"),
  },
  windsurf: {
    id: "windsurf",
    displayName: "Windsurf IDE",
    configKey: "mcpServers",
    getPath: () => join(homedir(), ".codeium", "windsurf", "mcp_config.json"),
  },
  vscode: {
    id: "vscode",
    displayName: "VS Code",
    configKey: "servers",
    getPath: (platform = process.platform) => {
      if (platform === "darwin") {
        return join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json");
      }
      if (platform === "win32") {
        const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        return join(appData, "Code", "User", "mcp.json");
      }
      return join(homedir(), ".config", "Code", "User", "mcp.json");
    },
  },
  antigravity: {
    id: "antigravity",
    displayName: "Google Antigravity",
    configKey: "mcpServers",
    getPath: () => join(homedir(), ".gemini", "antigravity", "mcp_config.json"),
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    configKey: "mcp",
    getPath: () => join(homedir(), ".config", "opencode", "opencode.json"),
  },
};

export interface DetectedHarnessStatus {
  id: HarnessId;
  displayName: string;
  configPath: string;
  installed: boolean;
  hasSlothConfigured: boolean;
  serverCount: number;
}

/**
 * Detects all client harnesses on the host and their configuration status.
 */
export function detectHarnesses(): DetectedHarnessStatus[] {
  const result: DetectedHarnessStatus[] = [];

  for (const def of Object.values(SUPPORTED_HARNESSES)) {
    const configPath = def.getPath();
    const installed = existsSync(configPath);
    let hasSlothConfigured = false;
    let serverCount = 0;

    if (installed) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw);
        const servers = parsed[def.configKey] || {};
        serverCount = Object.keys(servers).length;
        hasSlothConfigured = Boolean(servers["sloth"]);
      } catch {
        // ignore parse error during status scan
      }
    }

    result.push({
      id: def.id,
      displayName: def.displayName,
      configPath,
      installed,
      hasSlothConfigured,
      serverCount,
    });
  }

  return result;
}

export interface ImportedServerRecord {
  name: string;
  config: ServerConfig;
}

/**
 * Reads and maps all downstream MCP servers from a harness config,
 * preserving both enabled and disabled server states.
 */
export function readHarnessServers(harnessId: HarnessId, customConfigPath?: string): ImportedServerRecord[] {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'. Supported: ${Object.keys(SUPPORTED_HARNESSES).join(", ")}`);
  }

  const configPath = customConfigPath || def.getPath();
  if (!existsSync(configPath)) {
    return [];
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);
  const rawServers = parsed[def.configKey] || {};

  const imported: ImportedServerRecord[] = [];

  for (const [name, srv] of Object.entries<Record<string, unknown>>(rawServers)) {
    // Skip self/sloth entry if already configured
    if (name === "sloth") continue;

    const command = typeof srv.command === "string" ? srv.command : "";
    if (!command) {
      // Skip non-command entries (e.g. pure remote HTTP without stdio bridge)
      continue;
    }

    const args = Array.isArray(srv.args) ? (srv.args as string[]) : [];
    const env = srv.env && typeof srv.env === "object" ? (srv.env as Record<string, string>) : undefined;
    const disabled = Boolean(srv.disabled || srv.enabled === false);

    const config: ServerConfig = {
      command,
      args,
      env,
      disabled,
      tags: [harnessId],
    };

    imported.push({ name, config });
  }

  return imported;
}

/**
 * Finds the most recent rolling .bak file for a config path.
 */
export function findLatestBackup(configPath: string): string | null {
  const dir = dirname(configPath);
  if (!existsSync(dir)) return null;

  const baseName = basename(configPath);
  const prefix = `${baseName}.bak.`;

  try {
    const files = readdirSync(dir);
    const matching = files
      .filter((f) => f.startsWith(prefix))
      .sort((a, b) => {
        const timeA = parseInt(a.slice(prefix.length), 10) || 0;
        const timeB = parseInt(b.slice(prefix.length), 10) || 0;
        return timeB - timeA; // newest first
      });

    return matching.length > 0 ? join(dir, matching[0]) : null;
  } catch {
    return null;
  }
}

export interface InstallResult {
  backupPath: string;
  configPath: string;
  importedCount?: number;
}

export interface InstallOptions {
  migrate?: boolean; // When true: imports all existing servers into Sloth and replaces them in client config with only 'sloth'
  customConfigPath?: string;
  customEntry?: { command: string; args: string[] };
}

/**
 * Safely injects SlothMCP into a client harness with an automated timestamped backup.
 * Supports `--migrate` mode to import existing servers and clean up the client config.
 */
export function installSlothToHarness(harnessId: HarnessId, options: InstallOptions = {}): InstallResult {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  const configPath = options.customConfigPath || def.getPath();
  let existingData: Record<string, unknown> = {};
  let importedCount = 0;

  // Default entry pointing to built Sloth entrypoint
  const slothEntry = options.customEntry || {
    command: "node",
    args: [join(dirname(dirname(new URL(import.meta.url).pathname)), "build", "src", "index.js")],
  };

  if (existsSync(configPath)) {
    // 1. Create timestamped backup
    const backupPath = `${configPath}.bak.${Date.now()}`;
    copyFileSync(configPath, backupPath);

    try {
      const raw = readFileSync(configPath, "utf-8");
      existingData = JSON.parse(raw);
    } catch {
      existingData = {};
    }

    // 2. Handle Migration if requested
    if (options.migrate) {
      const importedRecords = readHarnessServers(harnessId, configPath);
      if (importedRecords.length > 0) {
        const slothConfig = loadConfig();
        for (const rec of importedRecords) {
          slothConfig.servers[rec.name] = rec.config;
        }
        saveConfig(slothConfig);
        importedCount = importedRecords.length;
      }

      // Replace server section with ONLY sloth
      existingData[def.configKey] = {
        sloth: slothEntry,
      };
    } else {
      // Append mode: keep existing servers and add sloth
      const servers = (existingData[def.configKey] || {}) as Record<string, unknown>;
      servers["sloth"] = slothEntry;
      existingData[def.configKey] = servers;
    }

    writeJsonAtomic(configPath, existingData);
    return { backupPath, configPath, importedCount };
  } else {
    // Create fresh config
    existingData[def.configKey] = {
      sloth: slothEntry,
    };

    writeJsonAtomic(configPath, existingData);
    return { backupPath: "", configPath, importedCount: 0 };
  }
}

export interface RestoreResult {
  restored: boolean;
  backupUsed?: string;
}

/**
 * Restores a client harness config from its most recent .bak backup.
 */
export function restoreHarnessFromBackup(harnessId: HarnessId, customConfigPath?: string): RestoreResult {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  const configPath = customConfigPath || def.getPath();
  const latestBackup = findLatestBackup(configPath);

  if (!latestBackup || !existsSync(latestBackup)) {
    return { restored: false };
  }

  copyFileSync(latestBackup, configPath);
  try {
    unlinkSync(latestBackup);
  } catch {
    // ignore
  }

  return { restored: true, backupUsed: latestBackup };
}

/**
 * Uninstalls SlothMCP from a client harness by removing the 'sloth' entry.
 */
export function uninstallSlothFromHarness(harnessId: HarnessId, customConfigPath?: string): boolean {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  const configPath = customConfigPath || def.getPath();
  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const servers = parsed[def.configKey] as Record<string, unknown> | undefined;

    if (servers && servers["sloth"]) {
      delete servers["sloth"];
      writeJsonAtomic(configPath, parsed);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
