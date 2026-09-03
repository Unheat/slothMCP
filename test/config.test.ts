import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeSchemaFingerprint,
  deleteManifest,
  loadAllManifests,
  loadConfig,
  loadManifest,
  saveConfig,
  saveManifest,
  type ManifestData,
  type SlothConfig,
  type ToolDefinition,
} from "../src/config.js";

describe("SlothConfig & Manifest Storage", () => {
  let tempConfigDir: string;
  let tempCacheDir: string;

  beforeEach(() => {
    tempConfigDir = join(tmpdir(), `sloth-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempCacheDir = join(tmpdir(), `sloth-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    process.env.SLOTH_CONFIG_DIR = tempConfigDir;
    process.env.SLOTH_CACHE_DIR = tempCacheDir;
  });

  afterEach(() => {
    if (existsSync(tempConfigDir)) {
      rmSync(tempConfigDir, { recursive: true, force: true });
    }
    if (existsSync(tempCacheDir)) {
      rmSync(tempCacheDir, { recursive: true, force: true });
    }
  });

  it("returns default empty config when no file exists", () => {
    const config = loadConfig();
    expect(config.idleTimeoutMs).toBe(300_000);
    expect(config.servers).toEqual({});
  });

  it("saves and loads configuration atomically", () => {
    const newConfig: SlothConfig = {
      idleTimeoutMs: 120_000,
      servers: {
        docker: {
          command: "docker-mcp",
          args: ["--verbose"],
          env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
          disabled: false,
          tags: ["containers", "devops"],
        },
      },
    };

    saveConfig(newConfig);
    const loaded = loadConfig();

    expect(loaded.idleTimeoutMs).toBe(120_000);
    expect(loaded.servers.docker).toBeDefined();
    expect(loaded.servers.docker.command).toBe("docker-mcp");
    expect(loaded.servers.docker.args).toEqual(["--verbose"]);
    expect(loaded.servers.docker.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
  });

  it("computes deterministic SHA-256 fingerprint independent of tool order", () => {
    const toolsA: ToolDefinition[] = [
      { name: "restart", description: "Restart container", inputSchema: {} },
      { name: "logs", description: "Fetch container logs", inputSchema: {} },
    ];

    const toolsB: ToolDefinition[] = [
      { name: "logs", description: "Fetch container logs", inputSchema: {} },
      { name: "restart", description: "Restart container", inputSchema: {} },
    ];

    const hashA = computeSchemaFingerprint(toolsA);
    const hashB = computeSchemaFingerprint(toolsB);

    expect(hashA).toBe(hashB);
    expect(hashA).toHaveLength(64);
  });

  it("saves, loads, lists, and deletes cached manifests", () => {
    const manifestDocker: ManifestData = {
      server: "docker",
      fingerprint: "hash-docker-1",
      indexedAt: Date.now(),
      tools: [
        {
          name: "restart",
          description: "Restart a container",
          inputSchema: {
            type: "object",
            properties: { container: { type: "string" } },
            required: ["container"],
          },
        },
      ],
    };

    const manifestPostgres: ManifestData = {
      server: "postgres",
      fingerprint: "hash-pg-1",
      indexedAt: Date.now(),
      tools: [
        {
          name: "query",
          description: "Execute SQL query",
          inputSchema: {
            type: "object",
            properties: { sql: { type: "string" } },
            required: ["sql"],
          },
        },
      ],
    };

    saveManifest(manifestDocker);
    saveManifest(manifestPostgres);

    // Load individual manifest
    const loadedDocker = loadManifest("docker");
    expect(loadedDocker).not.toBeNull();
    expect(loadedDocker?.server).toBe("docker");
    expect(loadedDocker?.tools).toHaveLength(1);
    expect(loadedDocker?.tools[0].name).toBe("restart");

    // Load all manifests
    const all = loadAllManifests();
    expect(all.size).toBe(2);
    expect(all.has("docker")).toBe(true);
    expect(all.has("postgres")).toBe(true);

    // Delete manifest
    const deleted = deleteManifest("docker");
    expect(deleted).toBe(true);
    expect(loadManifest("docker")).toBeNull();
    expect(loadAllManifests().size).toBe(1);
  });
});
