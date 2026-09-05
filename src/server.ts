import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { loadAllManifests, loadConfig, type SlothConfig } from "./config.js";
import { buildTaxonomy, formatCompactSignature, ToolIndex } from "./indexer.js";
import { ProcessPool } from "./pool.js";
import { shapeToolOutput } from "./shaper.js";

/**
 * Normalizes a parameter key string for fuzzy comparison (e.g. container_name -> containername)
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, "");
}

/**
 * Speculative argument repair:
 * 1. Fuzzy key matching (e.g. container_name or containerId -> container)
 * 2. Type coercion (string numbers -> numbers, string booleans -> booleans)
 */
export function repairToolArguments(
  providedArgs: Record<string, unknown>,
  schema: Record<string, unknown> | undefined
): { repaired: Record<string, unknown>; remappedKeys: Record<string, string> } {
  if (!schema || typeof schema !== "object") {
    return { repaired: { ...providedArgs }, remappedKeys: {} };
  }

  const properties = (schema.properties || {}) as Record<string, Record<string, unknown>>;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const propertyKeys = Object.keys(properties);

  const repaired: Record<string, unknown> = { ...providedArgs };
  const remappedKeys: Record<string, string> = {};

  // 1. Key remapping for expected properties
  for (const expectedKey of propertyKeys) {
    if (repaired[expectedKey] !== undefined) continue;

    const normExpected = normalizeKey(expectedKey);

    // Look for matching key in providedArgs
    for (const providedKey of Object.keys(repaired)) {
      if (properties[providedKey] !== undefined) continue; // Do not steal valid expected keys

      const normProvided = normalizeKey(providedKey);

      // Match conditions: identical normalized, or contains (e.g. container_name vs container)
      if (
        normProvided === normExpected ||
        normProvided === `${normExpected}name` ||
        normProvided === `${normExpected}id` ||
        normProvided === `target${normExpected}`
      ) {
        repaired[expectedKey] = repaired[providedKey];
        delete repaired[providedKey];
        remappedKeys[providedKey] = expectedKey;
        break;
      }
    }
  }

  // 2. Type coercion for mapped properties
  for (const [key, propDef] of Object.entries(properties)) {
    const val = repaired[key];
    if (val === undefined || val === null) continue;

    const expectedType = propDef.type;

    // String to number coercion
    if ((expectedType === "number" || expectedType === "integer") && typeof val === "string") {
      const num = Number(val);
      if (!Number.isNaN(num)) {
        repaired[key] = num;
      }
    }

    // String to boolean coercion
    if (expectedType === "boolean" && typeof val === "string") {
      if (val.toLowerCase() === "true") repaired[key] = true;
      if (val.toLowerCase() === "false") repaired[key] = false;
    }
  }

  return { repaired, remappedKeys };
}

export interface SlothServerInstance {
  server: McpServer;
  toolIndex: ToolIndex;
  pool: ProcessPool;
  reload: () => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface CreateServerOptions {
  config?: SlothConfig;
  customManifests?: ReturnType<typeof loadAllManifests>;
}

/**
 * Creates and configures the SlothMCP Gateway Server.
 */
export function createSlothServer(options: CreateServerOptions = {}): SlothServerInstance {
  let config = options.config || loadConfig();
  const toolIndex = new ToolIndex();
  const pool = new ProcessPool({
    idleTimeoutMs: config.idleTimeoutMs,
    defaultOnDemand: config.defaultOnDemand,
    onToolsChanged: () => {
      reload();
    },
  });

  const reload = () => {
    config = options.config || loadConfig();
    const manifests = options.customManifests || loadAllManifests();

    // Map tags from config
    const tagsMap: Record<string, string[]> = {};
    for (const [serverName, srvConfig] of Object.entries(config.servers)) {
      if (srvConfig.tags) {
        tagsMap[serverName] = srvConfig.tags;
      }
    }

    // Filter enabled manifests
    const enabledManifests = Array.from(manifests.values()).filter((m) => {
      const srv = config.servers[m.server];
      return srv ? !srv.disabled : true;
    });

    toolIndex.buildIndex(enabledManifests, tagsMap);
    pool.updateServerConfigs(config.servers, config.idleTimeoutMs, config.defaultOnDemand);
  };

  // Initial load
  reload();

  const mcpServer = new McpServer({
    name: "sloth-gateway",
    version: "1.0.0",
  });

  const taxonomy = buildTaxonomy(
    Array.from((options.customManifests || loadAllManifests()).values()).filter((m) => {
      const srv = config.servers[m.server];
      return srv ? !srv.disabled : true;
    })
  );

  // 1. Register search_tools meta-tool
  mcpServer.registerTool(
    "search_tools",
    {
      description: `${taxonomy}\n\nSearch and retrieve compact tool signatures by natural language intent, keywords, or namespace.`,
      inputSchema: z.object({
        query: z.string().describe("Search query (e.g. 'restart container', 'sql query')"),
        namespace: z.string().optional().describe("Optional namespace filter (e.g. 'docker', 'database')"),
        limit: z.number().int().positive().optional().describe("Max candidate tools to return (default: 5)"),
      }),
    },
    async ({ query, namespace, limit }) => {
      const results = toolIndex.search(query, { namespace, limit: limit ?? 5 });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No tools found matching '${query}'${namespace ? ` in namespace '${namespace}'` : ""}.`,
            },
          ],
        };
      }

      const formatted = results.map((r) => r.signature).join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} candidate tool(s):\n\n${formatted}`,
          },
        ],
      };
    }
  );

  // 2. Register get_tool_schema meta-tool (Progressive Disclosure)
  mcpServer.registerTool(
    "get_tool_schema",
    {
      description: "Progressive disclosure: retrieve the full original JSONSchema for a tool when handling complex or nested parameters.",
      inputSchema: z.object({
        server: z.string().describe("Downstream server name (e.g. 'docker')"),
        tool: z.string().describe("Tool name (e.g. 'restart')"),
      }),
    },
    async ({ server, tool }) => {
      const def = toolIndex.getTool(server, tool);
      if (!def) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Tool '${server}:${tool}' not found in cached registry.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                name: def.name,
                server,
                description: def.description || "",
                inputSchema: def.inputSchema || {},
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // 3. Register execute_tool meta-tool
  mcpServer.registerTool(
    "execute_tool",
    {
      description: "Execute a downstream MCP tool. Lazily spawns the downstream server if dormant.",
      inputSchema: z.object({
        server: z.string().describe("Downstream server name (e.g. 'docker')"),
        tool: z.string().describe("Tool name to execute (e.g. 'restart')"),
        arguments: z.record(z.string(), z.unknown()).optional().describe("Tool arguments matching the schema"),
      }),
    },
    async ({ server, tool, arguments: args }) => {
      const toolDef = toolIndex.getTool(server, tool);
      const { repaired: finalArgs, remappedKeys } = repairToolArguments(
        args || {},
        toolDef?.inputSchema as Record<string, unknown> | undefined
      );

      if (Object.keys(remappedKeys).length > 0) {
        console.error(`[SlothServer] Auto-repaired arguments for '${server}:${tool}':`, remappedKeys);
      }

      try {
        const result = await pool.executeTool(server, tool, finalArgs);
        const callResult = result as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;

        if (callResult && Array.isArray(callResult.content) && callResult.content.length > 0) {
          const textItems = callResult.content.map((item) => {
            if (item.type === "text") {
              return {
                type: "text" as const,
                text: shapeToolOutput(item.text ?? ""),
              };
            }
            return item as { type: "text"; text: string };
          });

          return {
            isError: callResult.isError,
            content: textItems,
          };
        }

        const rawText = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return {
          isError: false,
          content: [
            {
              type: "text" as const,
              text: shapeToolOutput(rawText),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stderrLines = pool.getStderr(server);
        const stderrDetails = stderrLines.length > 0 ? `\n\nRecent stderr:\n${stderrLines.join("\n")}` : "";

        // Provide self-correcting signature if tool definition is known
        const signatureHint = toolDef
          ? `\n\nExpected Tool Signature:\n${formatCompactSignature(server, toolDef)}`
          : "";

        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `Execution failed for '${server}:${tool}': ${message}${signatureHint}${stderrDetails}`,
            },
          ],
        };
      }
    }
  );

  const start = async () => {
    // Pre-warm any persistent servers (onDemand: false)
    const booted = await pool.bootPersistentServers();
    if (booted.length > 0) {
      console.error(`[SlothMCP] Booted ${booted.length} persistent server(s): ${booted.join(", ")}`);
    }

    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
    console.error("[SlothMCP] Gateway started on stdio.");
  };

  const stop = async () => {
    await pool.stopAll();
  };

  return {
    server: mcpServer,
    toolIndex,
    pool,
    reload,
    start,
    stop,
  };
}

// Default executable entrypoint
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const instance = createSlothServer();
  void instance.start();
}
