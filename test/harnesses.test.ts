import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installSlothToHarness,
  readHarnessServers,
  SUPPORTED_HARNESSES,
  uninstallSlothFromHarness,
} from "../src/harnesses.js";

describe("Harness Detection, Import & Installation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sloth-harness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
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

    // 1. Install
    const customEntry = { command: "node", args: ["/path/to/sloth/build/index.js"] };
    const installResult = installSlothToHarness("claude-desktop", mockClaudeConfigPath, customEntry);

    expect(installResult.configPath).toBe(mockClaudeConfigPath);
    expect(installResult.backupPath).toContain(".bak.");
    expect(existsSync(installResult.backupPath)).toBe(true);

    // Verify backup contains original data without sloth
    const backupContent = JSON.parse(readFileSync(installResult.backupPath, "utf-8"));
    expect(backupContent.mcpServers.github).toBeDefined();
    expect(backupContent.mcpServers.sloth).toBeUndefined();

    // Verify target config has sloth injected
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
});
