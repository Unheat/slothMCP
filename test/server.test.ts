import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ManifestData, SlothConfig } from "../src/config.js";
import {
  createSlothServer,
  SLOTH_GATEWAY_INSTRUCTIONS,
  type SlothServerInstance,
} from "../src/server.js";

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
          {
            name: "oversized_json",
            description: "Returns oversized JSON data",
            inputSchema: {
              type: "object",
              properties: {
                item_count: { type: "number", description: "Number of items" },
              },
            },
          },
          {
            name: "get_oversized_count",
            description: "Get invocation count of oversized_json",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "rich_envelope",
            description: "Returns rich envelope with mixed blocks and structured content",
            inputSchema: {
              type: "object",
              properties: {
                msg: { type: "string", description: "Message to include" },
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

  it("registers the four permanent meta-tools on the server", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sloth-test-client", version: "1.0.0" });

    await Promise.all([serverInstance.server.connect(serverTransport), client.connect(clientTransport)]);
    const toolsResult = await client.listTools();
    const toolNames = toolsResult.tools.map((t) => t.name).sort();

    expect(toolNames).toEqual(["execute_tool", "get_tool_schema", "read_result", "search_tools"]);
    await client.close();
  });

  it("preserves small downstream result envelope completely unchanged", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sloth-test-client", version: "1.0.0" });

    await Promise.all([serverInstance.server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({
      name: "execute_tool",
      arguments: {
        server: "mock",
        tool: "rich_envelope",
        arguments: { msg: "small-payload" },
      },
    })) as Record<string, unknown>;

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ message: "small-payload", status: "ok" });
    expect(result._meta).toEqual({ traceId: "test-trace" });

    const content = result.content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({ type: "text", text: "rich:small-payload", annotations: { priority: 1 } });
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "aGVsbG8=" });
    expect(content[2]).toMatchObject({ type: "resource_link", uri: "file:///test.txt", name: "test-resource" });

    await client.close();
  });

  it("materializes oversized result atomically, returns bounded preview with result_id, and executes downstream tool exactly once", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sloth-test-client", version: "1.0.0" });

    await Promise.all([serverInstance.server.connect(serverTransport), client.connect(clientTransport)]);

    // Call execute_tool with oversized_json (which returns >30KB of data)
    const result = (await client.callTool({
      name: "execute_tool",
      arguments: {
        server: "mock",
        tool: "oversized_json",
        arguments: { item_count: 500 },
      },
    })) as Record<string, unknown>;

    expect(result.isError).toBeFalsy();
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content.length).toBeGreaterThanOrEqual(1);

    const summaryText = content[0].text;
    expect(summaryText).toContain("[SlothMCP] Tool result");
    expect(summaryText).toContain("exceeds inline limit");
    expect(summaryText).toContain("Complete result stored with ID:");

    const idMatch = summaryText.match(/ID: ([0-9a-f-]{36})/);
    expect(idMatch).not.toBeNull();
    const resultId = idMatch![1];

    // Read result using json view
    const jsonRes = (await client.callTool({
      name: "read_result",
      arguments: {
        result_id: resultId,
        view: "json",
        path: "/items",
        offset: 0,
        limit: 3,
      },
    })) as Record<string, unknown>;

    expect(jsonRes.isError).toBeFalsy();
    const jsonContent = jsonRes.content as Array<{ type: string; text: string }>;
    const parsedJson = JSON.parse(jsonContent[0].text);
    expect(parsedJson.values).toHaveLength(3);
    expect(parsedJson.values[0].id).toBe(0);
    expect(parsedJson.totalValues).toBe(500);
    expect(parsedJson.nextOffset).toBe(3);

    // Read result using envelope view
    const envRes = (await client.callTool({
      name: "read_result",
      arguments: {
        result_id: resultId,
        view: "envelope",
      },
    })) as Record<string, unknown>;
    const envContent = envRes.content as Array<{ type: string; text: string }>;
    const parsedEnv = JSON.parse(envContent[0].text);
    expect(parsedEnv.id).toBe(resultId);
    expect(parsedEnv.hasStructuredContent).toBe(true);

    // Read result using raw view
    const rawRes = (await client.callTool({
      name: "read_result",
      arguments: {
        result_id: resultId,
        view: "raw",
        offset: 0,
        limit: 1024,
      },
    })) as Record<string, unknown>;
    const rawContent = rawRes.content as Array<{ type: string; text: string }>;
    const parsedRaw = JSON.parse(rawContent[0].text);
    expect(parsedRaw.data).toBeDefined();
    expect(parsedRaw.totalBytes).toBeGreaterThan(30000);

    // Verify downstream invocation count is exactly 1 (no duplicate execution!)
    const countRes = (await client.callTool({
      name: "execute_tool",
      arguments: {
        server: "mock",
        tool: "get_oversized_count",
        arguments: {},
      },
    })) as Record<string, unknown>;
    const countContent = countRes.content as Array<{ type: string; text: string }>;
    expect(countContent[0].text).toBe("1");

    await client.close();
  });

  it("returns isError: true when read_result receives invalid or non-existent result_id", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sloth-test-client", version: "1.0.0" });

    await Promise.all([serverInstance.server.connect(serverTransport), client.connect(clientTransport)]);

    const invalidRes = (await client.callTool({
      name: "read_result",
      arguments: {
        result_id: "not-a-valid-uuid",
      },
    })) as Record<string, unknown>;

    expect(invalidRes.isError).toBe(true);
    const content = invalidRes.content as Array<{ type: string; text: string }>;
    expect(content[0].text).toContain("read_result error: Invalid result ID");

    await client.close();
  });

  it("sends gateway workflow instructions during MCP initialization", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "sloth-test-client", version: "1.0.0" });

    await Promise.all([serverInstance.server.connect(serverTransport), client.connect(clientTransport)]);

    expect(client.getInstructions()).toBe(SLOTH_GATEWAY_INSTRUCTIONS);
    await client.close();
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
