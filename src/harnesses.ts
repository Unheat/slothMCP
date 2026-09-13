import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { loadConfig, saveConfig, writeJsonAtomic, type ServerConfig } from "./config.js";

// Donor code provenance: no code in this module is copied or adapted from any
// repository under reference/ — all implementation is local (see
// .zcode/plans/plan-zcode-harness.md and .zcode/plans/plan-harness-skills-path.md).

export type HarnessId =
  | "claude-desktop"
  | "cursor"
  | "claude-code"
  | "windsurf"
  | "vscode"
  | "antigravity"
  | "opencode"
  | "zcode";

export interface HarnessDefinition {
  id: HarnessId;
  displayName: string;
  /**
   * Dot-path to the server section inside the harness config file
   * (e.g. "mcpServers" for flat configs, "mcp.servers" for nested ones).
   */
  configKey: string;
  getPath: (platform?: NodeJS.Platform) => string;
  /**
   * Optional getter resolving the user-level skills directory for harnesses
   * that natively support an Agent Skills directory (e.g. ~/.zcode/skills).
   * Returns undefined for harnesses without native skill support.
   */
  getSkillsPath?: (platform?: NodeJS.Platform) => string;
  /**
   * Optional hook to reshape a server entry before writing it into this
   * harness's config, for harnesses whose entry schema differs from the
   * common {command, args, env, disabled} shape.
   */
  normalizeEntry?: (entry: Record<string, unknown>) => Record<string, unknown>;
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
    getSkillsPath: () => join(homedir(), ".claude", "skills"),
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
    getSkillsPath: () => join(homedir(), ".gemini", "config", "skills"),
  },
  opencode: {
    id: "opencode",
    displayName: "OpenCode",
    configKey: "mcp",
    getPath: () => join(homedir(), ".config", "opencode", "opencode.json"),
    getSkillsPath: () => join(homedir(), ".config", "opencode", "skills"),
  },
  zcode: {
    id: "zcode",
    displayName: "ZCode",
    configKey: "mcp.servers",
    getPath: () => join(homedir(), ".zcode", "cli", "config.json"),
    getSkillsPath: () => join(homedir(), ".zcode", "skills"),
    // ZCode's config parser is strict: unknown keys (e.g. "disabled") cause the
    // server to be silently dropped, so entries must use type/enabled instead.
    normalizeEntry: (entry) => {
      const { disabled, ...rest } = entry;
      const out: Record<string, unknown> = { type: "stdio", ...rest };
      if (disabled === true) {
        out.enabled = false;
      } else {
        delete out.enabled;
      }
      return out;
    },
  },
};

/**
 * Resolves a dot-path (e.g. "mcp.servers") inside a parsed JSON object.
 *
 * @param parsed - Parsed JSON config object
 * @param configKey - Dot-path to the server section
 * @returns The section object, or undefined if any segment is missing or not an object
 */
function getServerSection(parsed: Record<string, unknown>, configKey: string): Record<string, unknown> | undefined {
  let node: unknown = parsed;
  for (const segment of configKey.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  return node as Record<string, unknown>;
}

/**
 * Resolves a dot-path inside a parsed JSON object, creating intermediate
 * objects (and the final section) as needed. Mutates `parsed` in place.
 *
 * @param parsed - Parsed JSON config object
 * @param configKey - Dot-path to the server section
 * @returns The (possibly newly created) section object
 */
function ensureServerSection(parsed: Record<string, unknown>, configKey: string): Record<string, unknown> {
  let node = parsed;
  for (const segment of configKey.split(".")) {
    const next = node[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  return node;
}

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
 *
 * @returns Array of DetectedHarnessStatus records for all supported IDEs and CLIs
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
        const servers: Record<string, unknown> = getServerSection(parsed, def.configKey) || {};
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
 *
 * @param harnessId - Identifier of target harness (e.g. 'cursor', 'claude-desktop')
 * @param customConfigPath - Optional custom configuration file path for testing
 * @returns Array of ImportedServerRecord objects containing name and ServerConfig
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
  const rawServers: Record<string, unknown> = getServerSection(parsed, def.configKey) || {};

  const imported: ImportedServerRecord[] = [];

  for (const [name, srv] of Object.entries(rawServers as Record<string, Record<string, unknown>>)) {
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
 *
 * @param configPath - Absolute path of the target configuration file
 * @returns Path to the most recent backup file, or null if none exist
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

/**
 * Resolves the root directory of the slothMCP package from either src/ or build/src/.
 */
export function getPackageRoot(): string {
  const moduleDirectory = dirname(new URL(import.meta.url).pathname);
  return basename(dirname(moduleDirectory)) === "build" ? dirname(dirname(moduleDirectory)) : dirname(moduleDirectory);
}

export interface SkillInstallOptions {
  customSkillsDir?: string;
  sourceSkillDir?: string;
}

/**
 * Copies the sloth-manager skill into the harness's user skills directory if supported.
 *
 * @param harnessId - Target harness ID
 * @param options - Optional custom skills destination or source override
 * @returns Absolute path of the installed skill directory, or null if harness does not support skills
 */
export function installHarnessSkill(harnessId: HarnessId, options: SkillInstallOptions = {}): string | null {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) return null;

  const skillsDir = options.customSkillsDir || def.getSkillsPath?.();
  if (!skillsDir) return null;

  const packageRoot = getPackageRoot();
  const sourceSkillDir = options.sourceSkillDir || join(packageRoot, "skills", "sloth-manager");
  if (!existsSync(sourceSkillDir)) return null;

  const targetDir = join(skillsDir, "sloth-manager");
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }

  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceSkillDir, targetDir, { recursive: true });
  return targetDir;
}

export interface SkillRemoveOptions {
  customSkillsDir?: string;
}

/**
 * Removes the sloth-manager skill from the harness's user skills directory if present.
 *
 * @param harnessId - Target harness ID
 * @param options - Optional custom skills destination override
 * @returns Absolute path of the removed skill directory, or null if not found/unsupported
 */
export function removeHarnessSkill(harnessId: HarnessId, options: SkillRemoveOptions = {}): string | null {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) return null;

  const skillsDir = options.customSkillsDir || def.getSkillsPath?.();
  if (!skillsDir) return null;

  const targetDir = join(skillsDir, "sloth-manager");
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    return targetDir;
  }
  return null;
}

export interface InstallResult {
  backupPath: string;
  configPath: string;
  importedCount?: number;
  skillInstalledPath?: string;
}

export interface InstallOptions {
  migrate?: boolean; // When true: imports all existing servers into Sloth and replaces them in client config with only 'sloth'
  customConfigPath?: string;
  customSkillsDir?: string;
  customEntry?: { command: string; args: string[] };
  installSkill?: boolean; // When true (default), auto-installs sloth-manager skill into harness skills directory
}

/**
 * Safely injects SlothMCP into a client harness with an automated timestamped backup.
 * Supports `--migrate` mode to import existing servers and clean up the client config.
 * Automatically installs the sloth-manager skill for harnesses that support it unless disabled.
 *
 * @param harnessId - Identifier of target client harness
 * @param options - InstallOptions controlling migration, custom path, or custom entry
 * @returns InstallResult containing backupPath, configPath, imported server count, and optional skillInstalledPath
 */
export function installSlothToHarness(harnessId: HarnessId, options: InstallOptions = {}): InstallResult {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  const configPath = options.customConfigPath || def.getPath();
  let existingData: Record<string, unknown> = {};
  let importedCount = 0;

  // WORKAROUND: compiled modules run from build/src while source modules run from src ->
  // select the nearest package root so the gateway path never becomes build/build/src/index.js.
  const packageRoot = getPackageRoot();
  const slothEntry = options.customEntry || {
    command: "node",
    args: [join(packageRoot, "build", "src", "index.js")],
  };
  const normalizedEntry = def.normalizeEntry ? def.normalizeEntry(slothEntry) : slothEntry;

  // Install skill if supported and not opted out
  let skillInstalledPath: string | undefined;
  if (options.installSkill !== false) {
    const installed = installHarnessSkill(harnessId, { customSkillsDir: options.customSkillsDir });
    if (installed) {
      skillInstalledPath = installed;
    }
  }

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
      const section = ensureServerSection(existingData, def.configKey);
      for (const key of Object.keys(section)) {
        delete section[key];
      }
      section["sloth"] = normalizedEntry;
    } else {
      // Append mode: keep existing servers and add sloth
      ensureServerSection(existingData, def.configKey)["sloth"] = normalizedEntry;
    }

    writeJsonAtomic(configPath, existingData);
    return { backupPath, configPath, importedCount, skillInstalledPath };
  } else {
    // Create fresh config
    ensureServerSection(existingData, def.configKey)["sloth"] = normalizedEntry;

    writeJsonAtomic(configPath, existingData);
    return { backupPath: "", configPath, importedCount: 0, skillInstalledPath };
  }
}

export interface EjectOptions {
  customSkillsDir?: string;
  removeSkill?: boolean;
}

export interface EjectResult {
  restored: boolean;
  strategy: "backup" | "exported" | "not_needed";
  backupUsed?: string;
  ejectedCount: number;
  skillRemovedPath?: string;
}

/**
 * Unified shared logic to put back all MCP servers into the client harness configuration
 * and remove the 'sloth' gateway entry. Also cleans up the sloth-manager skill if installed.
 *
 * Strategy 1 (Priority): If a timestamped .bak backup exists, restores it byte-for-byte.
 * Strategy 2 (Fallback): If no backup exists, dynamically exports all servers from Sloth's
 * config back into the client harness file, cleanly removing the 'sloth' entry.
 *
 * Used by:
 * 1. `sloth eject <harness>` (and `sloth restore <harness>`)
 * 2. `sloth uninstall <harness> --restore` / `sloth uninstall <harness>`
 *
 * @param harnessId - Identifier of target client harness (e.g. 'cursor', 'claude-desktop')
 * @param customConfigPath - Optional custom configuration file path for testing
 * @param options - Optional EjectOptions controlling skill removal and custom directories
 * @returns EjectResult detailing restored status, strategy used, restored server count, and optional skillRemovedPath
 */
export function ejectHarnessConfig(
  harnessId: HarnessId,
  customConfigPath?: string,
  options: EjectOptions = {}
): EjectResult {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  // Remove skill if present and not opted out
  let skillRemovedPath: string | undefined;
  if (options.removeSkill !== false) {
    const removed = removeHarnessSkill(harnessId, { customSkillsDir: options.customSkillsDir });
    if (removed) {
      skillRemovedPath = removed;
    }
  }

  const configPath = customConfigPath || def.getPath();
  const latestBackup = findLatestBackup(configPath);

  // Strategy 1: Restore from latest backup file if present
  if (latestBackup && existsSync(latestBackup)) {
    let ejectedCount = 0;
    try {
      const backupRaw = readFileSync(latestBackup, "utf-8");
      const backupParsed = JSON.parse(backupRaw);
      const backupServers = getServerSection(backupParsed, def.configKey) || {};
      ejectedCount = Object.keys(backupServers).filter((k) => k !== "sloth").length;
    } catch {
      // ignore parse error on backup count detection
    }

    copyFileSync(latestBackup, configPath);
    try {
      unlinkSync(latestBackup);
    } catch {
      // ignore cleanup error
    }

    return {
      restored: true,
      strategy: "backup",
      backupUsed: latestBackup,
      ejectedCount,
      skillRemovedPath,
    };
  }

  // Strategy 2: Dynamic export fallback from Sloth config
  if (!existsSync(configPath)) {
    return { restored: false, strategy: "not_needed", ejectedCount: 0, skillRemovedPath };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const existingServers: Record<string, unknown> = getServerSection(parsed, def.configKey) || {};

    // Check if sloth was even installed
    const hadSloth = Boolean(existingServers["sloth"]);
    delete existingServers["sloth"];

    // Export all servers from Sloth config into client config
    const slothConfig = loadConfig();
    let exportedCount = 0;

    for (const [srvName, srvDef] of Object.entries(slothConfig.servers)) {
      const entry = {
        command: srvDef.command,
        args: srvDef.args || [],
        env: srvDef.env,
        disabled: srvDef.disabled,
      };
      existingServers[srvName] = def.normalizeEntry ? def.normalizeEntry(entry) : entry;
      exportedCount++;
    }

    Object.assign(ensureServerSection(parsed, def.configKey), existingServers);
    writeJsonAtomic(configPath, parsed);

    return {
      restored: hadSloth || exportedCount > 0,
      strategy: "exported",
      ejectedCount: exportedCount,
      skillRemovedPath,
    };
  } catch (err) {
    console.error(`[SlothHarness] Failed to dynamically eject servers into ${def.displayName}:`, err);
    return { restored: false, strategy: "not_needed", ejectedCount: 0, skillRemovedPath };
  }
}

export interface RestoreResult {
  restored: boolean;
  backupUsed?: string;
  ejectedCount?: number;
  skillRemovedPath?: string;
}

/**
 * Restores a client harness config from its most recent .bak backup or exports servers back.
 * Delegates to the unified ejectHarnessConfig logic.
 *
 * @param harnessId - Identifier of target harness
 * @param customConfigPath - Optional custom configuration file path for testing
 * @param options - Optional EjectOptions controlling skill removal and custom directories
 * @returns RestoreResult with restored boolean status and backupUsed path
 */
export function restoreHarnessFromBackup(
  harnessId: HarnessId,
  customConfigPath?: string,
  options: EjectOptions = {}
): RestoreResult {
  const res = ejectHarnessConfig(harnessId, customConfigPath, options);
  return {
    restored: res.restored,
    backupUsed: res.backupUsed,
    ejectedCount: res.ejectedCount,
    skillRemovedPath: res.skillRemovedPath,
  };
}

/**
 * Uninstalls SlothMCP from a client harness by removing the 'sloth' entry and cleaning up its skill.
 *
 * @param harnessId - Identifier of target harness
 * @param customConfigPath - Optional custom configuration file path for testing
 * @param options - Optional options for skill removal and custom directories
 * @returns Boolean indicating whether sloth was found and removed
 */
export function uninstallSlothFromHarness(
  harnessId: HarnessId,
  customConfigPath?: string,
  options: { customSkillsDir?: string; removeSkill?: boolean } = {}
): boolean {
  const def = SUPPORTED_HARNESSES[harnessId];
  if (!def) {
    throw new Error(`Unsupported harness '${harnessId}'.`);
  }

  if (options.removeSkill !== false) {
    removeHarnessSkill(harnessId, { customSkillsDir: options.customSkillsDir });
  }

  const configPath = customConfigPath || def.getPath();
  if (!existsSync(configPath)) {
    return false;
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const servers = getServerSection(parsed, def.configKey);

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
