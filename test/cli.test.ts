import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deleteManifest,
  loadAllManifests,
  loadConfig,
  loadManifest,
  saveConfig,
  saveManifest,
  type ManifestData,
} from "../src/config.js";

describe("Sloth CLI Configuration Flow", () => {
  let tempConfigDir: string;
  let tempCacheDir: string;

  beforeEach(() => {
    tempConfigDir = join(tmpdir(), `sloth-cli-test-config-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempCacheDir = join(tmpdir(), `sloth-cli-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);

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

  it("adds and enables a server in config", () => {
    const config = loadConfig();
    expect(config.servers).toEqual({});

    config.servers["test-docker"] = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-docker"],
      env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
      disabled: false,
      tags: ["containers"],
    };

    saveConfig(config);

    const reloaded = loadConfig();
    expect(reloaded.servers["test-docker"]).toBeDefined();
    expect(reloaded.servers["test-docker"].disabled).toBe(false);
  });

  it("toggles server disabled status", () => {
    const config = loadConfig();
    config.servers["test-db"] = {
      command: "postgres-mcp",
      args: [],
      disabled: false,
      tags: [],
    };
    saveConfig(config);

    // Toggle to disabled
    config.servers["test-db"].disabled = true;
    saveConfig(config);
    expect(loadConfig().servers["test-db"].disabled).toBe(true);

    // Toggle back to enabled
    config.servers["test-db"].disabled = false;
    saveConfig(config);
    expect(loadConfig().servers["test-db"].disabled).toBe(false);
  });

  it("removes server from config and deletes cached manifest", () => {
    const config = loadConfig();
    config.servers["to-remove"] = {
      command: "sample-cmd",
      args: [],
      disabled: false,
      tags: [],
    };
    saveConfig(config);

    const mockManifest: ManifestData = {
      server: "to-remove",
      fingerprint: "hash-123",
      indexedAt: Date.now(),
      tools: [{ name: "sample_tool", description: "Sample", inputSchema: {} }],
    };
    saveManifest(mockManifest);

    expect(loadManifest("to-remove")).not.toBeNull();

    // Remove server
    delete config.servers["to-remove"];
    saveConfig(config);
    deleteManifest("to-remove");

    expect(loadConfig().servers["to-remove"]).toBeUndefined();
    expect(loadManifest("to-remove")).toBeNull();
  });

  it("stores and modifies onDemand and defaultOnDemand configuration settings", () => {
    const config = loadConfig();
    expect(config.defaultOnDemand).toBe(true);

    config.defaultOnDemand = false;
    config.servers["persistent-srv"] = {
      command: "my-cmd",
      args: [],
      disabled: false,
      tags: [],
      onDemand: false,
    };
    config.servers["lazy-srv"] = {
      command: "my-lazy-cmd",
      args: [],
      disabled: false,
      tags: [],
      onDemand: true,
    };

    saveConfig(config);

    const reloaded = loadConfig();
    expect(reloaded.defaultOnDemand).toBe(false);
    expect(reloaded.servers["persistent-srv"].onDemand).toBe(false);
    expect(reloaded.servers["lazy-srv"].onDemand).toBe(true);
  });
});
