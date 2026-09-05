import MiniSearch from "minisearch";
import type { ManifestData, ToolDefinition } from "./config.js";

/** BM25 ranking boost for tool name matches (highest weight) */
export const BOOST_TOOL_NAME = 5.0;

/** BM25 ranking boost for exact canonical ID matches ("server:tool") */
export const BOOST_CANONICAL_ID = 4.0;

/** BM25 ranking boost for input parameter names */
export const BOOST_PARAMS = 2.0;

/** BM25 ranking boost for tool descriptions */
export const BOOST_DESCRIPTION = 1.5;

/** BM25 ranking boost for server tags */
export const BOOST_TAGS = 1.5;

/** Default number of candidate tools returned by search */
export const DEFAULT_SEARCH_LIMIT = 5;

/** MiniSearch fuzzy match tolerance threshold */
export const FUZZY_SEARCH_THRESHOLD = 0.2;

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
 *
 * @param prop - JSONSchema property definition object
 * @returns Concise human-readable TypeScript type identifier string
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
 *
 * @param server - Server namespace identifier
 * @param tool - Tool definition object with inputSchema
 * @returns One-line compact TypeScript function signature string
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
 *
 * @param manifests - Collection of ManifestData objects
 * @returns Multi-line formatted namespace directory tree string
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
          toolName: BOOST_TOOL_NAME,
          id: BOOST_CANONICAL_ID,
          paramsSummary: BOOST_PARAMS,
          description: BOOST_DESCRIPTION,
          tags: BOOST_TAGS,
        },
        prefix: true,
        fuzzy: FUZZY_SEARCH_THRESHOLD,
      },
    });
  }

  /**
   * Rebuilds the search index from a collection of manifests.
   *
   * @param manifests - Iterable collection of ManifestData
   * @param serverTagsMap - Map of server name to search tags
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
   *
   * @param query - Keyword or natural language query string
   * @param options - SearchOptions controlling namespace filter and limit
   * @returns Array of SearchResult objects ordered by relevance
   */
  public search(query: string, options: SearchOptions = {}): SearchResult[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
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

    // Deterministic sorting: score descending, then canonical ID ascending to preserve prompt caching
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
   *
   * @param server - Server namespace identifier
   * @param toolName - Target tool name
   * @returns ToolDefinition object if found, or null
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
