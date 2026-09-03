import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeJsonAtomic, type ServerConfig } from "./config.js";

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

export interface InstallResult {
  backupPath: string;
  configPath: string;
}

/**
 * Safely injects SlothMCP into a client harness with an automated timestamped backup.
 */
export function installSlothToHarness(
  harnessId: HarnessId,
  customConfigPath?: string,
  customEntry?: { command: string; args: string[] }
): InstallResult {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  const configPath = customConfigPath || def.getPath();
  let existingData: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    // Create timestamped backup
    const backupPath = `${configPath}.bak.${Date.now()}`;
    copyFileSync(configPath, backupPath);

    try {
      const raw = readFileSync(configPath, "utf-8");
      existingData = JSON.parse(raw);
    } catch {
      existingData = {};
    }

    const servers = (existingData[def.configKey] || {}) as Record<string, unknown>;

    // Inject sloth entry
    servers["sloth"] = customEntry || {
      command: "node",
      args: [join(dirname(dirname(new URL(import.meta.url).pathname)), "build", "src", "index.js")],
    };

    existingData[def.configKey] = servers;
    writeJsonAtomic(configPath, existingData);

    return { backupPath, configPath };
  } else {
    // Create fresh config
    const dir = dirname(configPath);
    existingData[def.configKey] = {
      sloth: customEntry || {
        command: "node",
        args: [join(dirname(dirname(new URL(import.meta.url).pathname)), "build", "src", "index.js")],
      },
    };

    writeJsonAtomic(configPath, existingData);
    return { backupPath: "", configPath };
  }
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
