import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new McpServer({
  name: "mock-downstream-server",
  version: "1.0.0",
});

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

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Mock downstream server ready.");
