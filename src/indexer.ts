import MiniSearch from "minisearch";
import type { ManifestData, ToolDefinition } from "./config.js";

/**
 * Internal index document representation
 */
export interface IndexedToolDoc {
  id: string; // "server:toolName"
  server: string;
  toolName: string;
  description: string;
  paramsSummary: string;
  tags: string[];
  toolDefinition: ToolDefinition;
}

/**
 * Formats a JSONSchema parameter property into a compact TypeScript-like type string.
 */
export function formatParamType(prop: Record<string, unknown> | undefined): string {
  if (!prop || typeof prop !== "object") return "unknown";

  if (prop.enum && Array.isArray(prop.enum)) {
    return prop.enum.map((v) => JSON.stringify(v)).join(" | ");
  }

  const type = prop.type;
  if (type === "string") return "string";
  if (type === "number" || type === "integer") return "number";
  if (type === "boolean") return "boolean";
  if (type === "array") {
    const items = prop.items as Record<string, unknown> | undefined;
    const itemType = items ? formatParamType(items) : "unknown";
    return `${itemType}[]`;
  }
  if (type === "object") return "object";

  return "any";
}

/**
 * Converts a verbose ToolDefinition with JSONSchema into a compact 1-line TypeScript AST signature.
 * Example: docker.restart(container: string, timeout?: number): Restart a container
 */
export function formatCompactSignature(server: string, tool: ToolDefinition): string {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  const properties = (schema?.properties || {}) as Record<string, Record<string, unknown>>;
  const requiredList = Array.isArray(schema?.required) ? (schema.required as string[]) : [];
  const requiredSet = new Set(requiredList);

  const paramSignatures: string[] = [];

  for (const [paramName, propDef] of Object.entries(properties)) {
    const isRequired = requiredSet.has(paramName);
    const paramType = formatParamType(propDef);
    paramSignatures.push(`${paramName}${isRequired ? "" : "?"}: ${paramType}`);
  }

  const paramsStr = paramSignatures.join(", ");
  const desc = tool.description ? `: ${tool.description.trim().replace(/\s+/g, " ")}` : "";

  return `${server}.${tool.name}(${paramsStr})${desc}`;
}

/**
 * Generates a deterministic hierarchical namespace directory tree from manifest definitions.
 * Sorted alphabetically by server and tool names to ensure 100% prompt-caching stability.
 */
export function buildTaxonomy(manifests: Iterable<ManifestData>): string {
  const serverMap = new Map<string, string[]>();

  for (const manifest of manifests) {
    const toolNames = manifest.tools.map((t) => t.name).sort();
    if (toolNames.length > 0) {
      serverMap.set(manifest.server, toolNames);
    }
  }

  const sortedServers = Array.from(serverMap.keys()).sort();
  if (sortedServers.length === 0) {
    return "No downstream tools currently registered.";
  }

  const lines = [
    "Dynamic MCP Registry. MANDATORY: Search here before running raw terminal scripts or manual workarounds.",
    "Available Namespaces & Tools:",
  ];

  for (const server of sortedServers) {
    const tools = serverMap.get(server)!;
    lines.push(`• /${server}/* -> [${tools.join(", ")}]`);
  }

  return lines.join("\n");
}

export interface SearchOptions {
  namespace?: string;
  limit?: number;
}

export interface SearchResult {
  id: string; // "server:tool"
  server: string;
  toolName: string;
  signature: string;
  description: string;
  score: number;
}

/**
 * High-performance, in-memory BM25 tool search index using MiniSearch.
 */
export class ToolIndex {
  private miniSearch: MiniSearch<IndexedToolDoc>;
  private docMap = new Map<string, IndexedToolDoc>();

  constructor() {
    this.miniSearch = new MiniSearch<IndexedToolDoc>({
      fields: ["id", "server", "toolName", "description", "paramsSummary", "tags"],
      storeFields: ["id", "server", "toolName", "description"],
      searchOptions: {
        boost: {
          toolName: 5.0,
          id: 4.0,
          paramsSummary: 2.0,
          description: 1.5,
          tags: 1.5,
        },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }

  /**
   * Rebuilds the index from a collection of manifests.
   */
  public buildIndex(manifests: Iterable<ManifestData>, serverTagsMap: Record<string, string[]> = {}): void {
    this.miniSearch.removeAll();
    this.docMap.clear();

    const docs: IndexedToolDoc[] = [];

    for (const manifest of manifests) {
      const serverTags = serverTagsMap[manifest.server] || [];

      for (const tool of manifest.tools) {
        const id = `${manifest.server}:${tool.name}`;
        const schema = tool.inputSchema as Record<string, unknown> | undefined;
        const properties = (schema?.properties || {}) as Record<string, unknown>;
        const paramKeys = Object.keys(properties).join(" ");

        const doc: IndexedToolDoc = {
          id,
          server: manifest.server,
          toolName: tool.name,
          description: tool.description || "",
          paramsSummary: paramKeys,
          tags: serverTags,
          toolDefinition: tool,
        };

        docs.push(doc);
        this.docMap.set(id, doc);
      }
    }

    if (docs.length > 0) {
      this.miniSearch.addAll(docs);
    }
  }

  /**
   * Searches tools using BM25 ranking and returns compact signatures with deterministic tie-breaking.
   */
  public search(query: string, options: SearchOptions = {}): SearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options.limit ?? 5;
    const filterNamespace = options.namespace?.toLowerCase();

    // Query MiniSearch
    const searchResults = this.miniSearch.search(trimmed, {
      filter: filterNamespace ? (result) => (result.server as string).toLowerCase() === filterNamespace : undefined,
    });

    // Map to SearchResult objects
    const results: SearchResult[] = [];
    for (const res of searchResults) {
      const doc = this.docMap.get(res.id);
      if (!doc) continue;

      results.push({
        id: doc.id,
        server: doc.server,
        toolName: doc.toolName,
        signature: formatCompactSignature(doc.server, doc.toolDefinition),
        description: doc.description,
        score: res.score,
      });
    }

    // Deterministic sorting: score descending, then canonical ID ascending
    results.sort((a, b) => {
      if (Math.abs(b.score - a.score) > 0.0001) {
        return b.score - a.score;
      }
      return a.id.localeCompare(b.id);
    });

    return results.slice(0, limit);
  }

  /**
   * Fast O(1) lookup for raw tool definition (used by get_tool_schema and execute_tool).
   */
  public getTool(server: string, toolName: string): ToolDefinition | null {
    const id = `${server}:${toolName}`;
    const doc = this.docMap.get(id);
    return doc ? doc.toolDefinition : null;
  }

  /**
   * Returns total count of indexed tools.
   */
  public get size(): number {
    return this.docMap.size;
  }

  /**
   * Returns all indexed document records.
   */
  public getAllDocs(): IndexedToolDoc[] {
    return Array.from(this.docMap.values());
  }
}
