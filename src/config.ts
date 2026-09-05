import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Zod schema for individual MCP tool input parameters
 */
export const ToolDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional().default({}),
});

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;

/**
 * Zod schema for downstream server configuration
 */
export const ServerConfigSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string(), z.string()).optional(),
  disabled: z.boolean().optional().default(false),
  tags: z.array(z.string()).optional().default([]),
  onDemand: z.boolean().optional(), // undefined falls back to global defaultOnDemand
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Zod schema for global SlothMCP configuration (~/.config/sloth/mcp.json)
 */
export const SlothConfigSchema = z.object({
  $schema: z.string().optional(),
  idleTimeoutMs: z.number().int().positive().optional().default(300_000), // default 5 minutes
  defaultOnDemand: z.boolean().optional().default(true), // default on-demand lazy lifecycle
  servers: z.record(z.string(), ServerConfigSchema).default({}),
});

export type SlothConfig = z.infer<typeof SlothConfigSchema>;

/**
 * Zod schema for cached manifest files (~/.cache/sloth/manifests/<server>.json)
 */
export const ManifestDataSchema = z.object({
  server: z.string().min(1),
  fingerprint: z.string().min(1),
  indexedAt: z.number().int().positive(),
  tools: z.array(ToolDefinitionSchema).default([]),
});

export type ManifestData = z.infer<typeof ManifestDataSchema>;

/**
 * Computes a deterministic SHA-256 hash fingerprint of tool definitions
 */
export function computeSchemaFingerprint(tools: ToolDefinition[]): string {
  // Sort tools by name to ensure hash stability
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Resolves configuration and cache directory paths (supports env var overrides for isolation in testing)
 */
export function getConfigDir(): string {
  return process.env.SLOTH_CONFIG_DIR || join(homedir(), ".config", "sloth");
}

export function getConfigPath(): string {
  return join(getConfigDir(), "mcp.json");
}

export function getCacheDir(): string {
  return process.env.SLOTH_CACHE_DIR || join(homedir(), ".cache", "sloth");
}

export function getManifestsDir(): string {
  return join(getCacheDir(), "manifests");
}

export function getManifestPath(serverName: string): string {
  return join(getManifestsDir(), `${serverName}.json`);
}

/**
 * Atomic JSON write helper: writes to a .tmp file first, flushes, and renames atomically.
 */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  const serialized = JSON.stringify(data, null, 2);

  try {
    writeFileSync(tmpPath, serialized, "utf-8");
    renameSync(tmpPath, filePath);
  } catch (error) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
    }
    throw error;
  }
}

/**
 * Loads and validates the Sloth configuration from disk.
 * Returns default empty configuration if the file does not exist.
 */
export function loadConfig(): SlothConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return {
      idleTimeoutMs: 300_000,
      defaultOnDemand: true,
      servers: {},
    };
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return SlothConfigSchema.parse(parsed);
  } catch (error) {
    console.error(`[SlothConfig] Error parsing config at ${configPath}:`, error);
    return {
      idleTimeoutMs: 300_000,
      defaultOnDemand: true,
      servers: {},
    };
  }
}

/**
 * Saves the Sloth configuration atomically to disk.
 */
export function saveConfig(config: SlothConfig): void {
  const validated = SlothConfigSchema.parse(config);
  writeJsonAtomic(getConfigPath(), validated);
}

/**
 * Loads a cached manifest for a downstream server.
 */
export function loadManifest(serverName: string): ManifestData | null {
  const manifestPath = getManifestPath(serverName);
  if (!existsSync(manifestPath)) {
    return null;
  }

  try {
    const raw = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(raw);
    return ManifestDataSchema.parse(parsed);
  } catch (error) {
    console.error(`[SlothConfig] Error reading manifest for ${serverName}:`, error);
    return null;
  }
}

/**
 * Saves a cached manifest for a downstream server atomically.
 */
export function saveManifest(manifest: ManifestData): void {
  const validated = ManifestDataSchema.parse(manifest);
  writeJsonAtomic(getManifestPath(manifest.server), validated);
}

/**
 * Deletes a cached manifest if it exists.
 */
export function deleteManifest(serverName: string): boolean {
  const manifestPath = getManifestPath(serverName);
  if (existsSync(manifestPath)) {
    try {
      unlinkSync(manifestPath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Loads all available cached manifests from the manifests directory.
 */
export function loadAllManifests(): Map<string, ManifestData> {
  const manifestsDir = getManifestsDir();
  const result = new Map<string, ManifestData>();

  if (!existsSync(manifestsDir)) {
    return result;
  }

  const files = readdirSync(manifestsDir);

  for (const file of files) {
    if (file.endsWith(".json")) {
      const serverName = file.slice(0, -5);
      const manifest = loadManifest(serverName);
      if (manifest) {
        result.set(serverName, manifest);
      }
    }
  }

  return result;
}
