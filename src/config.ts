import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Default idle timeout before an inactive child process is reaped (5 minutes in milliseconds) */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

/** Default on-demand lifecycle posture (lazy on-demand by default) */
export const DEFAULT_ON_DEMAND = true;

/** Maximum serialized result size returned inline (30 KiB) */
export const DEFAULT_RESULT_INLINE_MAX_BYTES = 30 * 1024;
/** Stored result lifetime (two hours in milliseconds) */
export const DEFAULT_RESULT_TTL_MS = 2 * 60 * 60 * 1000;
/** Maximum serialized size of one stored result (64 MiB) */
export const DEFAULT_RESULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Maximum aggregate serialized size of stored results (256 MiB) */
export const DEFAULT_RESULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

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
export const SlothConfigSchema = z
  .object({
    $schema: z.string().optional(),
    idleTimeoutMs: z.number().int().positive().optional().default(DEFAULT_IDLE_TIMEOUT_MS),
    defaultOnDemand: z.boolean().optional().default(DEFAULT_ON_DEMAND),
    resultInlineMaxBytes: z.number().int().positive().optional().default(DEFAULT_RESULT_INLINE_MAX_BYTES),
    resultTtlMs: z.number().int().positive().optional().default(DEFAULT_RESULT_TTL_MS),
    resultMaxEntryBytes: z.number().int().positive().optional().default(DEFAULT_RESULT_MAX_ENTRY_BYTES),
    resultMaxTotalBytes: z.number().int().positive().optional().default(DEFAULT_RESULT_MAX_TOTAL_BYTES),
    servers: z.record(z.string(), ServerConfigSchema).default({}),
  })
  .refine((config) => config.resultInlineMaxBytes <= config.resultMaxEntryBytes, {
    message: "resultInlineMaxBytes must be less than or equal to resultMaxEntryBytes",
    path: ["resultInlineMaxBytes"],
  })
  .refine((config) => config.resultMaxEntryBytes <= config.resultMaxTotalBytes, {
    message: "resultMaxEntryBytes must be less than or equal to resultMaxTotalBytes",
    path: ["resultMaxEntryBytes"],
  });

export type ValidatedSlothConfig = z.output<typeof SlothConfigSchema>;
export type SlothConfig = Omit<
  ValidatedSlothConfig,
  "resultInlineMaxBytes" | "resultTtlMs" | "resultMaxEntryBytes" | "resultMaxTotalBytes"
> &
  Partial<
    Pick<
      ValidatedSlothConfig,
      "resultInlineMaxBytes" | "resultTtlMs" | "resultMaxEntryBytes" | "resultMaxTotalBytes"
    >
  >;

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
 * Computes a deterministic SHA-256 hash fingerprint of tool definitions.
 *
 * @param tools - Array of ToolDefinition objects to fingerprint
 * @returns 64-character hexadecimal SHA-256 hash string
 */
export function computeSchemaFingerprint(tools: ToolDefinition[]): string {
  // Sort tools by name to ensure hash stability across calls
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/**
 * Resolves configuration directory path (supports env var override for isolated testing).
 *
 * @returns Absolute filesystem path to the configuration directory
 */
export function getConfigDir(): string {
  return process.env.SLOTH_CONFIG_DIR || join(homedir(), ".config", "sloth");
}

/**
 * Resolves the path to the primary Sloth configuration file.
 *
 * @returns Absolute filesystem path to mcp.json
 */
export function getConfigPath(): string {
  return join(getConfigDir(), "mcp.json");
}

/**
 * Resolves cache directory path (supports env var override for isolated testing).
 *
 * @returns Absolute filesystem path to the cache directory
 */
export function getCacheDir(): string {
  return process.env.SLOTH_CACHE_DIR || join(homedir(), ".cache", "sloth");
}

/**
 * Resolves the directory where tool manifests are persisted.
 *
 * @returns Absolute filesystem path to manifests directory
 */
export function getManifestsDir(): string {
  return join(getCacheDir(), "manifests");
}

/**
 * Resolves the cache file path for a specific downstream server.
 *
 * @param serverName - Identifier name of the server
 * @returns Absolute filesystem path to the server's manifest JSON file
 */
export function getManifestPath(serverName: string): string {
  return join(getManifestsDir(), `${serverName}.json`);
}

/**
 * Atomic JSON write helper: writes to a unique temporary file first,
 * flushes, and renames atomically to prevent corrupted files during crashes or concurrent writes.
 *
 * @param filePath - Target absolute destination file path
 * @param data - Serializable JavaScript object to write as JSON
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
        // ignore cleanup error on failure
      }
    }
    throw error;
  }
}

/**
 * Loads and validates the Sloth configuration from disk.
 * Returns default configuration if the file does not exist.
 *
 * @returns Validated SlothConfig object
 */
export function loadConfig(): ValidatedSlothConfig {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return SlothConfigSchema.parse({});
  }

  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    return SlothConfigSchema.parse(parsed);
  } catch (error) {
    console.error(`[SlothConfig] Error parsing config at ${configPath}:`, error);
    return SlothConfigSchema.parse({});
  }
}

/**
 * Saves the Sloth configuration atomically to disk.
 *
 * @param config - SlothConfig object to validate and persist
 */
export function saveConfig(config: SlothConfig): void {
  const validated = SlothConfigSchema.parse(config);
  writeJsonAtomic(getConfigPath(), validated);
}

/**
 * Loads a cached manifest for a downstream server.
 *
 * @param serverName - Identifier name of the server
 * @returns Validated ManifestData object if found, or null if not present
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
 *
 * @param manifest - ManifestData object to validate and persist
 */
export function saveManifest(manifest: ManifestData): void {
  const validated = ManifestDataSchema.parse(manifest);
  writeJsonAtomic(getManifestPath(manifest.server), validated);
}

/**
 * Deletes a cached manifest if it exists on disk.
 *
 * @param serverName - Identifier name of the server whose manifest should be deleted
 * @returns Boolean indicating whether a manifest was successfully deleted
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
 *
 * @returns Map of serverName to ManifestData
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
