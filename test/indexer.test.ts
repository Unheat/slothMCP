import { describe, expect, it } from "vitest";
import type { ManifestData } from "../src/config.js";
import { buildTaxonomy, formatCompactSignature, formatParamType, ToolIndex } from "../src/indexer.js";

describe("ToolIndex & Taxonomy Formatter", () => {
  const mockManifests: ManifestData[] = [
    {
      server: "docker",
      fingerprint: "hash-docker",
      indexedAt: Date.now(),
      tools: [
        {
          name: "restart",
          description: "Restart a container",
          inputSchema: {
            type: "object",
            properties: {
              container: { type: "string", description: "Container name or ID" },
              timeout: { type: "number", description: "Grace period before kill" },
              mode: { type: "string", enum: ["graceful", "force"] },
            },
            required: ["container"],
          },
        },
        {
          name: "logs",
          description: "Fetch container logs",
          inputSchema: {
            type: "object",
            properties: {
              container: { type: "string" },
              tail: { type: "number" },
            },
            required: ["container"],
          },
        },
      ],
    },
    {
      server: "database",
      fingerprint: "hash-db",
      indexedAt: Date.now(),
      tools: [
        {
          name: "query",
          description: "Execute SQL query on database",
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string" },
              readOnly: { type: "boolean" },
            },
            required: ["sql"],
          },
        },
      ],
    },
  ];

  it("formats parameter types correctly", () => {
    expect(formatParamType({ type: "string" })).toBe("string");
    expect(formatParamType({ type: "number" })).toBe("number");
    expect(formatParamType({ type: "boolean" })).toBe("boolean");
    expect(formatParamType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(formatParamType({ enum: ["json", "text"] })).toBe('"json" | "text"');
    expect(formatParamType(undefined)).toBe("unknown");
  });

  it("generates compact 1-line TypeScript signatures", () => {
    const restartTool = mockManifests[0].tools[0];
    const sig = formatCompactSignature("docker", restartTool);

    expect(sig).toBe('docker.restart(container: string, timeout?: number, mode?: "graceful" | "force"): Restart a container');
  });

  it("generates deterministic alphabetically sorted taxonomy tree", () => {
    const taxonomy = buildTaxonomy(mockManifests);

    const expected = [
      "Dynamic MCP Registry. MANDATORY: Search here before running raw terminal scripts or manual workarounds.",
      "Available Namespaces & Tools:",
      "• /database/* -> [query]",
      "• /docker/* -> [logs, restart]",
    ].join("\n");

    expect(taxonomy).toBe(expected);
  });

  it("indexes and performs BM25 ranking on tool names and keywords", () => {
    const index = new ToolIndex();
    index.buildIndex(mockManifests, { docker: ["containers"], database: ["sql", "postgres"] });

    expect(index.size).toBe(3);

    // Exact query for restart
    const resultsRestart = index.search("restart");
    expect(resultsRestart.length).toBeGreaterThan(0);
    expect(resultsRestart[0].id).toBe("docker:restart");
    expect(resultsRestart[0].signature).toContain("docker.restart");

    // Keyword search for SQL database query
    const resultsSql = index.search("execute sql query");
    expect(resultsSql.length).toBeGreaterThan(0);
    expect(resultsSql[0].id).toBe("database:query");

    // Namespace filtering
    const resultsFiltered = index.search("logs", { namespace: "docker" });
    expect(resultsFiltered.length).toBe(1);
    expect(resultsFiltered[0].id).toBe("docker:logs");

    const resultsFilteredEmpty = index.search("logs", { namespace: "database" });
    expect(resultsFilteredEmpty.length).toBe(0);
  });

  it("retrieves raw tool schema with O(1) getTool lookup", () => {
    const index = new ToolIndex();
    index.buildIndex(mockManifests);

    const tool = index.getTool("docker", "restart");
    expect(tool).not.toBeNull();
    expect(tool?.name).toBe("restart");
    expect(tool?.inputSchema).toHaveProperty("required", ["container"]);

    const notFound = index.getTool("docker", "nonexistent");
    expect(notFound).toBeNull();
  });
});
