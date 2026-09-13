import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import {
  ejectHarnessConfig,
  installSlothToHarness,
  readHarnessServers,
  restoreHarnessFromBackup,
  SUPPORTED_HARNESSES,
  uninstallSlothFromHarness,
} from "../src/harnesses.js";

describe("Harness Detection, Import & Installation", () => {
  let tempDir: string;
  let tempConfigDir: string;
  let tempCacheDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sloth-harness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempConfigDir = join(tmpdir(), `sloth-test-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempCacheDir = join(tmpdir(), `sloth-test-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    process.env.SLOTH_CONFIG_DIR = tempConfigDir;
    process.env.SLOTH_CACHE_DIR = tempCacheDir;
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (existsSync(tempConfigDir)) {
      rmSync(tempConfigDir, { recursive: true, force: true });
    }
    if (existsSync(tempCacheDir)) {
      rmSync(tempCacheDir, { recursive: true, force: true });
    }
  });

  it("resolves correct OS paths for major harnesses", () => {
    const claudeMac = SUPPORTED_HARNESSES["claude-desktop"].getPath("darwin");
    expect(claudeMac).toContain("Library/Application Support/Claude/claude_desktop_config.json");

    const claudeLinux = SUPPORTED_HARNESSES["claude-desktop"].getPath("linux");
    expect(claudeLinux).toContain(".config/Claude/claude_desktop_config.json");

    const cursorPath = SUPPORTED_HARNESSES["cursor"].getPath();
    expect(cursorPath).toContain(".cursor/mcp.json");

    const vsCodeMac = SUPPORTED_HARNESSES["vscode"].getPath("darwin");
    expect(vsCodeMac).toContain("Library/Application Support/Code/User/mcp.json");
  });

  it("reads and preserves both enabled and disabled servers from mock Cursor config", () => {
    const mockCursorConfigPath = join(tempDir, "cursor-mcp.json");

    const mockCursorData = {
      mcpServers: {
        docker: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-docker"],
          env: { DOCKER_HOST: "unix:///var/run/docker.sock" },
          disabled: false,
        },
        postgres: {
          command: "postgres-mcp",
          args: ["postgresql://localhost/db"],
          // enabled omitted defaults to enabled
        },
        "aws-s3": {
          command: "aws-s3-mcp",
          args: [],
          disabled: true, // explicitly disabled
        },
        sloth: {
          command: "sloth",
          args: ["start"], // should be skipped from import
        },
      },
    };

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockCursorConfigPath, JSON.stringify(mockCursorData, null, 2), "utf-8");

    const imported = readHarnessServers("cursor", mockCursorConfigPath);

    expect(imported).toHaveLength(3); // docker, postgres, aws-s3 (sloth skipped)

    const docker = imported.find((s) => s.name === "docker");
    expect(docker).toBeDefined();
    expect(docker?.config.disabled).toBe(false);
    expect(docker?.config.command).toBe("npx");
    expect(docker?.config.env?.DOCKER_HOST).toBe("unix:///var/run/docker.sock");

    const postgres = imported.find((s) => s.name === "postgres");
    expect(postgres).toBeDefined();
    expect(postgres?.config.disabled).toBe(false);

    const awsS3 = imported.find((s) => s.name === "aws-s3");
    expect(awsS3).toBeDefined();
    expect(awsS3?.config.disabled).toBe(true); // preserved as disabled!
  });

  it("writes the existing compiled gateway path in the default Sloth entry", () => {
    const mockConfigPath = join(tempDir, "default-entry.json");
    mkdirSync(tempDir, { recursive: true });

    installSlothToHarness("cursor", { customConfigPath: mockConfigPath });

    const installed = JSON.parse(readFileSync(mockConfigPath, "utf-8"));
    const gatewayPath = installed.mcpServers.sloth.args[0] as string;
    expect(gatewayPath).not.toContain("build/build");
    expect(gatewayPath).toMatch(/build\/src\/index\.js$/);
    expect(existsSync(gatewayPath)).toBe(true);
  });

  it("safely installs Sloth into harness config with automated backup and uninstalls cleanly", () => {
    const mockClaudeConfigPath = join(tempDir, "claude_desktop_config.json");

    const initialData = {
      mcpServers: {
        github: {
          command: "github-mcp",
          args: [],
        },
      },
    };

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockClaudeConfigPath, JSON.stringify(initialData, null, 2), "utf-8");

    // 1. Install without migrate (append mode)
    const customEntry = { command: "node", args: ["/path/to/sloth/build/index.js"] };
    const installResult = installSlothToHarness("claude-desktop", {
      customConfigPath: mockClaudeConfigPath,
      customEntry,
      migrate: false,
    });

    expect(installResult.configPath).toBe(mockClaudeConfigPath);
    expect(installResult.backupPath).toContain(".bak.");
    expect(existsSync(installResult.backupPath)).toBe(true);

    // Verify backup contains original data without sloth
    const backupContent = JSON.parse(readFileSync(installResult.backupPath, "utf-8"));
    expect(backupContent.mcpServers.github).toBeDefined();
    expect(backupContent.mcpServers.sloth).toBeUndefined();

    // Verify target config has sloth injected and github kept
    const updatedContent = JSON.parse(readFileSync(mockClaudeConfigPath, "utf-8"));
    expect(updatedContent.mcpServers.github).toBeDefined();
    expect(updatedContent.mcpServers.sloth).toBeDefined();
    expect(updatedContent.mcpServers.sloth.command).toBe("node");

    // 2. Uninstall
    const uninstalled = uninstallSlothFromHarness("claude-desktop", mockClaudeConfigPath);
    expect(uninstalled).toBe(true);

    const postUninstall = JSON.parse(readFileSync(mockClaudeConfigPath, "utf-8"));
    expect(postUninstall.mcpServers.github).toBeDefined();
    expect(postUninstall.mcpServers.sloth).toBeUndefined();
  });

  it("migrates existing servers to Sloth, clears client config to ONLY sloth, and restores cleanly", () => {
    const mockCursorConfigPath = join(tempDir, "cursor_mcp.json");

    const initialData = {
      mcpServers: {
        docker: { command: "docker-mcp", args: ["--flag"], disabled: false },
        postgres: { command: "postgres-mcp", args: [] },
        "aws-s3": { command: "aws-s3-mcp", args: [], disabled: true },
      },
    };

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockCursorConfigPath, JSON.stringify(initialData, null, 2), "utf-8");

    // Execute install with migrate: true
    const customEntry = { command: "node", args: ["/path/to/sloth.js"] };
    const result = installSlothToHarness("cursor", {
      customConfigPath: mockCursorConfigPath,
      customEntry,
      migrate: true,
    });

    expect(result.importedCount).toBe(3);
    expect(existsSync(result.backupPath)).toBe(true);

    // Verify Sloth config now contains all 3 servers with their enabled/disabled states preserved
    const slothConfig = loadConfig();
    expect(slothConfig.servers["docker"]).toBeDefined();
    expect(slothConfig.servers["docker"].disabled).toBe(false);
    expect(slothConfig.servers["postgres"]).toBeDefined();
    expect(slothConfig.servers["postgres"].disabled).toBe(false);
    expect(slothConfig.servers["aws-s3"]).toBeDefined();
    expect(slothConfig.servers["aws-s3"].disabled).toBe(true); // preserved as disabled!

    // Verify Cursor client config now contains ONLY 'sloth'
    const cursorConfigAfterMigrate = JSON.parse(readFileSync(mockCursorConfigPath, "utf-8"));
    const serverKeys = Object.keys(cursorConfigAfterMigrate.mcpServers);
    expect(serverKeys).toEqual(["sloth"]);
    expect(cursorConfigAfterMigrate.mcpServers.docker).toBeUndefined();
    expect(cursorConfigAfterMigrate.mcpServers.postgres).toBeUndefined();
    expect(cursorConfigAfterMigrate.mcpServers["aws-s3"]).toBeUndefined();

    // Now test restoreHarnessFromBackup
    const restoreResult = restoreHarnessFromBackup("cursor", mockCursorConfigPath);
    expect(restoreResult.restored).toBe(true);

    // Verify client config is restored byte-for-byte with all 3 original servers
    const restoredConfig = JSON.parse(readFileSync(mockCursorConfigPath, "utf-8"));
    expect(Object.keys(restoredConfig.mcpServers).sort()).toEqual(["aws-s3", "docker", "postgres"]);
    expect(restoredConfig.mcpServers.sloth).toBeUndefined();
    expect(restoredConfig.mcpServers["aws-s3"].disabled).toBe(true);
  });

  it("ejects servers back into harness using dynamic export when no backup file exists", () => {
    const mockClaudeConfigPath = join(tempDir, "claude_eject_export.json");

    // Client config currently only has sloth (e.g. fresh install or backup deleted)
    const clientData = {
      mcpServers: {
        sloth: { command: "node", args: ["/path/to/sloth.js"] },
      },
    };
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockClaudeConfigPath, JSON.stringify(clientData, null, 2), "utf-8");

    // Sloth config has 2 managed servers
    const slothConfig = loadConfig();
    slothConfig.servers["custom-db"] = { command: "db-cli", args: ["--pool"], disabled: false, tags: [] };
    slothConfig.servers["custom-k8s"] = { command: "k8s-mcp", args: [], disabled: true, tags: [] };
    saveConfig(slothConfig);

    // Call ejectHarnessConfig without any backup file on disk
    const ejectRes = ejectHarnessConfig("claude-desktop", mockClaudeConfigPath);

    expect(ejectRes.restored).toBe(true);
    expect(ejectRes.strategy).toBe("exported");
    expect(ejectRes.ejectedCount).toBe(2);

    // Verify Claude Desktop config now has the 2 servers and NO sloth
    const updatedClientConfig = JSON.parse(readFileSync(mockClaudeConfigPath, "utf-8"));
    expect(updatedClientConfig.mcpServers.sloth).toBeUndefined();
    expect(updatedClientConfig.mcpServers["custom-db"]).toBeDefined();
    expect(updatedClientConfig.mcpServers["custom-db"].command).toBe("db-cli");
    expect(updatedClientConfig.mcpServers["custom-k8s"]).toBeDefined();
    expect(updatedClientConfig.mcpServers["custom-k8s"].disabled).toBe(true);
  });
});

describe("ZCode harness (nested mcp.servers config)", () => {
  let tempDir: string;
  let tempConfigDir: string;
  let tempCacheDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sloth-zcode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempConfigDir = join(tmpdir(), `sloth-zcode-cfg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tempCacheDir = join(tmpdir(), `sloth-zcode-cache-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    process.env.SLOTH_CONFIG_DIR = tempConfigDir;
    process.env.SLOTH_CACHE_DIR = tempCacheDir;
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (existsSync(tempConfigDir)) {
      rmSync(tempConfigDir, { recursive: true, force: true });
    }
    if (existsSync(tempCacheDir)) {
      rmSync(tempCacheDir, { recursive: true, force: true });
    }
  });

  it("resolves the ZCode config path", () => {
    const zcodePath = SUPPORTED_HARNESSES["zcode"].getPath();
    expect(zcodePath).toContain(".zcode/cli/config.json");
  });

  it("imports servers from nested mcp.servers honoring enabled:false and skips url-only entries", () => {
    const mockZcodeConfigPath = join(tempDir, "zcode-config.json");

    const mockZcodeData = {
      plugins: { enabledPlugins: { "some-plugin@market": true } },
      mcp: {
        servers: {
          "codebase-memory": { type: "stdio", command: "codebase-memory-mcp", args: [] },
          hound: { type: "stdio", command: "/opt/hound", args: [], enabled: false },
          "remote-docs": { type: "http", url: "https://example.com/mcp" },
          sloth: { type: "stdio", command: "sloth", args: ["start"] }, // skipped from import
        },
      },
    };

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockZcodeConfigPath, JSON.stringify(mockZcodeData, null, 2), "utf-8");

    const imported = readHarnessServers("zcode", mockZcodeConfigPath);

    expect(imported).toHaveLength(2); // codebase-memory + hound (http and sloth skipped)

    const memory = imported.find((s) => s.name === "codebase-memory");
    expect(memory).toBeDefined();
    expect(memory?.config.disabled).toBe(false);
    expect(memory?.config.command).toBe("codebase-memory-mcp");

    const hound = imported.find((s) => s.name === "hound");
    expect(hound).toBeDefined();
    expect(hound?.config.disabled).toBe(true); // enabled:false mapped to disabled
  });

  it("installs sloth into nested mcp.servers with ZCode-shaped entry and preserves sibling keys", () => {
    const mockZcodeConfigPath = join(tempDir, "zcode-config.json");

    const initialData = {
      plugins: { enabledPlugins: { "some-plugin@market": true } },
      mcp: {
        servers: {
          "codebase-memory": { type: "stdio", command: "codebase-memory-mcp", args: [] },
        },
      },
    };

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockZcodeConfigPath, JSON.stringify(initialData, null, 2), "utf-8");

    const customEntry = { command: "node", args: ["/path/to/sloth/build/index.js"] };
    const installResult = installSlothToHarness("zcode", {
      customConfigPath: mockZcodeConfigPath,
      customEntry,
      migrate: false,
    });

    expect(installResult.backupPath).toContain(".bak.");
    expect(existsSync(installResult.backupPath)).toBe(true);

    const updated = JSON.parse(readFileSync(mockZcodeConfigPath, "utf-8"));

    // Sibling keys preserved
    expect(updated.plugins).toBeDefined();

    // Sloth entry written in ZCode's strict schema shape
    const slothEntry = updated.mcp.servers.sloth;
    expect(slothEntry).toBeDefined();
    expect(slothEntry.type).toBe("stdio");
    expect(slothEntry.command).toBe("node");
    expect(slothEntry.disabled).toBeUndefined();
    expect(slothEntry.enabled).toBeUndefined();

    // Existing server untouched
    expect(updated.mcp.servers["codebase-memory"]).toBeDefined();

    // Uninstall removes only sloth
    const uninstalled = uninstallSlothFromHarness("zcode", mockZcodeConfigPath);
    expect(uninstalled).toBe(true);
    const postUninstall = JSON.parse(readFileSync(mockZcodeConfigPath, "utf-8"));
    expect(postUninstall.mcp.servers.sloth).toBeUndefined();
    expect(postUninstall.mcp.servers["codebase-memory"]).toBeDefined();
    expect(postUninstall.plugins).toBeDefined();
  });

  it("migrates nested servers to Sloth and restores from backup cleanly", () => {
    const mockZcodeConfigPath = join(tempDir, "zcode-config.json");

    const initialData = {
      plugins: { enabledPlugins: { "some-plugin@market": true } },
      mcp: {
        servers: {
          "codebase-memory": { type: "stdio", command: "codebase-memory-mcp", args: [] },
          hound: { type: "stdio", command: "/opt/hound", args: [], enabled: false },
        },
      },
    };

    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockZcodeConfigPath, JSON.stringify(initialData, null, 2), "utf-8");

    const result = installSlothToHarness("zcode", {
      customConfigPath: mockZcodeConfigPath,
      customEntry: { command: "node", args: ["/path/to/sloth.js"] },
      migrate: true,
    });

    expect(result.importedCount).toBe(2);

    const slothConfig = loadConfig();
    expect(slothConfig.servers["hound"]).toBeDefined();
    expect(slothConfig.servers["hound"].disabled).toBe(true);

    // Only sloth remains under mcp.servers; siblings intact
    const afterMigrate = JSON.parse(readFileSync(mockZcodeConfigPath, "utf-8"));
    expect(Object.keys(afterMigrate.mcp.servers)).toEqual(["sloth"]);
    expect(afterMigrate.plugins).toBeDefined();

    const restoreResult = restoreHarnessFromBackup("zcode", mockZcodeConfigPath);
    expect(restoreResult.restored).toBe(true);

    const restored = JSON.parse(readFileSync(mockZcodeConfigPath, "utf-8"));
    expect(Object.keys(restored.mcp.servers).sort()).toEqual(["codebase-memory", "hound"]);
    expect(restored.mcp.servers.hound.enabled).toBe(false);
    expect(restored.plugins).toBeDefined();
  });

  it("ejects servers back into nested mcp.servers with ZCode-shaped entries when no backup exists", () => {
    const mockZcodeConfigPath = join(tempDir, "zcode-eject.json");

    const clientData = {
      plugins: { enabledPlugins: { "some-plugin@market": true } },
      mcp: {
        servers: {
          sloth: { type: "stdio", command: "node", args: ["/path/to/sloth.js"] },
        },
      },
    };
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(mockZcodeConfigPath, JSON.stringify(clientData, null, 2), "utf-8");

    const slothConfig = loadConfig();
    slothConfig.servers["custom-db"] = { command: "db-cli", args: ["--pool"], disabled: false, tags: [] };
    slothConfig.servers["custom-k8s"] = { command: "k8s-mcp", args: [], disabled: true, tags: [] };
    saveConfig(slothConfig);

    const ejectRes = ejectHarnessConfig("zcode", mockZcodeConfigPath);

    expect(ejectRes.restored).toBe(true);
    expect(ejectRes.strategy).toBe("exported");
    expect(ejectRes.ejectedCount).toBe(2);

    const updated = JSON.parse(readFileSync(mockZcodeConfigPath, "utf-8"));
    expect(updated.plugins).toBeDefined();
    expect(updated.mcp.servers.sloth).toBeUndefined();

    const db = updated.mcp.servers["custom-db"];
    expect(db.type).toBe("stdio");
    expect(db.command).toBe("db-cli");
    expect(db.disabled).toBeUndefined();
    expect(db.enabled).toBeUndefined();

    const k8s = updated.mcp.servers["custom-k8s"];
    expect(k8s.type).toBe("stdio");
    expect(k8s.disabled).toBeUndefined();
    expect(k8s.enabled).toBe(false);
  });
});
