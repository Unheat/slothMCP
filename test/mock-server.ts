import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({
  name: "mock-downstream-server",
  version: "1.0.0",
});

let oversizedCallCount = 0;

server.registerTool(
  "echo",
  {
    description: "Echo back message",
    inputSchema: z.object({
      msg: z.string(),
    }),
  },
  async ({ msg }) => {
    return {
      content: [{ type: "text", text: `echo:${msg}` }],
    };
  }
);

server.registerTool(
  "oversized_json",
  {
    description: "Returns oversized JSON data",
    inputSchema: z.object({
      item_count: z.number().optional(),
    }),
  },
  async ({ item_count = 1000 }) => {
    oversizedCallCount++;
    const items = Array.from({ length: item_count }, (_, index) => ({
      id: index,
      name: `item-${index}`,
      call_count: oversizedCallCount,
      data: `payload-data-${index}-${"x".repeat(50)}`,
    }));
    return {
      structuredContent: {
        total: items.length,
        call_count: oversizedCallCount,
        items,
      },
      content: [
        {
          type: "text",
          text: JSON.stringify({
            total: items.length,
            call_count: oversizedCallCount,
            items,
          }),
        },
      ],
    };
  }
);

server.registerTool(
  "get_oversized_count",
  {
    description: "Get invocation count of oversized_json",
    inputSchema: z.object({}),
  },
  async () => {
    return {
      content: [{ type: "text", text: String(oversizedCallCount) }],
    };
  }
);

server.registerTool(
  "rich_envelope",
  {
    description: "Returns rich envelope with mixed blocks and structured content",
    inputSchema: z.object({
      msg: z.string(),
    }),
  },
  async ({ msg }) => {
    return {
      content: [
        { type: "text", text: `rich:${msg}`, annotations: { priority: 1 } },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///test.txt", name: "test-resource" },
      ],
      structuredContent: { message: msg, status: "ok" },
      isError: false,
      _meta: { traceId: "test-trace" },
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Mock downstream server ready.");
