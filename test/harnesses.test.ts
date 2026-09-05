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
