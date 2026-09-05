import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestData, SlothConfig } from "../src/config.js";
import { createSlothServer, type SlothServerInstance } from "../src/server.js";

describe("SlothMCP Server Gateway Integration", () => {
  const mockServerScript = join(__dirname, "mock-server.ts");
  let serverInstance: SlothServerInstance;

  const mockConfig: SlothConfig = {
    idleTimeoutMs: 1000,
    defaultOnDemand: true,
    servers: {
      mock: {
        command: "npx",
        args: ["tsx", mockServerScript],
        disabled: false,
        tags: ["testing", "mock"],
      },
    },
  };

  const mockManifests = new Map<string, ManifestData>([
    [
      "mock",
      {
        server: "mock",
        fingerprint: "hash-mock",
        indexedAt: Date.now(),
        tools: [
          {
            name: "echo",
            description: "Echo back a message string",
            inputSchema: {
              type: "object",
              properties: {
                msg: { type: "string", description: "Message to echo" },
              },
              required: ["msg"],
            },
          },
        ],
      },
    ],
  ]);

  beforeEach(() => {
    serverInstance = createSlothServer({
      config: mockConfig,
      customManifests: mockManifests,
    });
  });

  afterEach(async () => {
    if (serverInstance) {
      await serverInstance.stop();
    }
  });

  it("registers the three core meta-tools on the server", () => {
    expect(serverInstance.toolIndex.size).toBe(1);
    expect(serverInstance.pool.activeCount).toBe(0);
  });

  it("searches tools and returns formatted compact 1-line signatures", async () => {
    const results = serverInstance.toolIndex.search("echo message");
    expect(results.length).toBe(1);
    expect(results[0].signature).toBe("mock.echo(msg: string): Echo back a message string");
  });

  it("retrieves raw JSONSchema via getTool definition lookup", () => {
    const schema = serverInstance.toolIndex.getTool("mock", "echo");
    expect(schema).not.toBeNull();
    expect(schema?.name).toBe("echo");
    expect(schema?.inputSchema).toHaveProperty("required", ["msg"]);
  });

  it("executes downstream tool lazily and returns result", async () => {
    expect(serverInstance.pool.activeCount).toBe(0);

    const result = (await serverInstance.pool.executeTool("mock", "echo", {
      msg: "integration-test",
    })) as { content: Array<{ text: string }> };

    expect(serverInstance.pool.activeCount).toBe(1);
    expect(result.content[0].text).toBe("echo:integration-test");
  });

  it("handles non-existent tool with error response gracefully", async () => {
    await expect(
      serverInstance.pool.executeTool("mock", "non_existent_tool", {})
    ).rejects.toThrow();
  });
});
