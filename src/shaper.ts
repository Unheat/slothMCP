/**
 * SlothMCP Output Shaper & Context Guard
 *
 * Implements:
 * 1. Tabular Shape Compression: Converts arrays of uniform objects into typed CSV tables
 *    with a shape header, reducing token usage by 50-70% on JSON payloads.
 * 2. Smart Sandwich Slicing: Preserves 20% head and 80% tail on oversized text/logs (>30KB),
 *    ensuring critical error summaries, stack traces, and exit codes at the bottom are never lost.
 */

/** Default maximum characters before applying sandwich slicing (~7,500 tokens) */
export const DEFAULT_MAX_CHARS = 30_000;

/** Default proportion of character budget reserved for head (20% head / 80% tail) */
export const DEFAULT_HEAD_RATIO = 0.2;

/** Minimum object array length required to qualify for tabularization */
export const MIN_UNIFORM_ARRAY_LENGTH = 3;

/** Maximum items inspected when verifying schema uniformity across rows */
export const MAX_UNIFORMITY_CHECK_ITEMS = 20;
/** Default UTF-8 byte budget for stored-result previews (12 KiB) */
export const DEFAULT_PREVIEW_MAX_BYTES = 12 * 1024;
/** Default proportion of line preview budget reserved for head (30% head / 70% tail) */
export const DEFAULT_PREVIEW_HEAD_RATIO = 0.3;
/** Maximum top-level names included in a structural JSON summary */
export const MAX_JSON_SUMMARY_ITEMS = 20;
/** Default number of head items included in high-signal JSON array previews */
export const DEFAULT_JSON_PREVIEW_HEAD_ITEMS = 3;
/** Default number of tail items included in high-signal JSON array previews */
export const DEFAULT_JSON_PREVIEW_TAIL_ITEMS = 2;
/** Marker used when complete text lines are omitted from a bounded preview */
export const TEXT_PREVIEW_OMISSION_MARKER = "... [SlothMCP: additional complete lines omitted; use read_result to retrieve them] ...";

/** Options for legacy preview shaping; never use to produce authoritative results. */
export interface ShaperOptions {
  maxChars?: number; // Hard character ceiling (default: 30,000 chars ~ 7,500 tokens)
  headRatio?: number; // Ratio of budget for head vs tail (default: 0.2 -> 20% head / 80% tail)
  enableTabularization?: boolean; // Default: true
}

/** Bounded structural description of a JSON value. */
export interface JsonStructuralSummary {
  type: "array" | "object" | "string" | "number" | "boolean" | "null";
  length?: number;
  keys?: string[];
  omittedKeys?: number;
  itemTypes?: string[];
}

/**
 * Escapes a single CSV value following RFC 4180 rules.
 *
 * @param val - Primitive or serializable field value
 * @returns RFC 4180 escaped CSV field string
 */
export function escapeCsvField(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean" || typeof val === "number") return String(val);

  const str = typeof val === "object" ? JSON.stringify(val) : String(val);

  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Checks if a parsed JSON value is a uniform array of objects suitable for tabularization.
 *
 * @param arr - Any parsed JavaScript value
 * @returns True if value is a uniform object array
 */
export function isUniformObjectArray(arr: unknown): arr is Record<string, unknown>[] {
  if (!Array.isArray(arr) || arr.length < MIN_UNIFORM_ARRAY_LENGTH) {
    return false;
  }

  // Check first item
  const first = arr[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) {
    return false;
  }

  const keys = Object.keys(first);
  if (keys.length === 0) return false;

  // Check uniformity and scalar values
  const keySet = new Set(keys);

  for (let i = 0; i < Math.min(arr.length, MAX_UNIFORMITY_CHECK_ITEMS); i++) {
    const item = arr[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }

    const itemKeys = Object.keys(item);
    if (itemKeys.length !== keys.length) return false;

    for (const k of itemKeys) {
      if (!keySet.has(k)) return false;
      const v = (item as Record<string, unknown>)[k];
      // Disallow deep complex nested objects (arrays of primitives are okay)
      if (v !== null && typeof v === "object" && !Array.isArray(v)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Converts a uniform JSON array of objects into a compact tabular representation
 * with a shape header: [N]{col1,col2,...}:\n...
 *
 * @param arr - Array of uniform objects
 * @returns Formatted compact shape-header CSV string
 */
export function tabularizeJsonArray(arr: Record<string, unknown>[]): string {
  const keys = Object.keys(arr[0]);
  const header = `[${arr.length}]{${keys.join(",")}}:`;

  const rows: string[] = [header];

  for (const item of arr) {
    const rowFields = keys.map((k) => escapeCsvField(item[k]));
    rows.push(rowFields.join(","));
  }

  return rows.join("\n");
}

/**
 * Performs Head + Tail "Sandwich" truncation, preserving 20% head and 80% tail.
 * Critical for developer tools where compiler errors, test assertions, and stack traces
 * appear at the end of the output.
 *
 * @param content - Input raw text or log content
 * @param maxChars - Budget limit in characters (default: 30,000)
 * @param headRatio - Fraction of budget reserved for head (default: 0.2)
 * @returns Sandwich-sliced output with clear omitted character notice
 */
export function sandwichSlice(
  content: string,
  maxChars = DEFAULT_MAX_CHARS,
  headRatio = DEFAULT_HEAD_RATIO
): string {
  if (!content || content.length <= maxChars) {
    return content;
  }

  const headChars = Math.floor(maxChars * headRatio);
  const tailChars = maxChars - headChars;
  const omitted = content.length - (headChars + tailChars);

  if (omitted <= 0) {
    return content;
  }

  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);

  const banner = `\n\n... [SlothMCP: truncated ${omitted} characters. Preserved first ${headChars} and last ${tailChars} chars. Use specific query filters if intermediate output is needed] ...\n\n`;

  return `${head}${banner}${tail}`;
}

/**
 * Returns stable JSON type name for structural preview metadata.
 *
 * @param value - JSON-compatible value to classify
 * @returns JSON type name, distinguishing arrays and null from objects
 */
function getJsonType(value: unknown): JsonStructuralSummary["type"] {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as JsonStructuralSummary["type"];
}

/**
 * Builds bounded structural metadata without serializing partial JSON values.
 *
 * @param value - JSON-compatible value to summarize
 * @param maxItems - Maximum keys or array items inspected and reported
 * @returns JSON-serializable structural summary
 */
export function summarizeJsonStructure(value: unknown, maxItems = MAX_JSON_SUMMARY_ITEMS): JsonStructuralSummary {
  const itemLimit = Math.max(0, Math.floor(maxItems));
  const type = getJsonType(value);

  if (Array.isArray(value)) {
    return {
      type,
      length: value.length,
      itemTypes: [...new Set(value.slice(0, itemLimit).map(getJsonType))],
    };
  }

  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    return {
      type,
      keys: keys.slice(0, itemLimit),
      omittedKeys: Math.max(0, keys.length - itemLimit),
    };
  }

  if (typeof value === "string") return { type, length: value.length };
  return { type };
}

/**
 * Returns longest prefix whose UTF-8 encoding fits a byte budget without splitting Unicode.
 *
 * @param text - Source text to bound
 * @param maxBytes - Maximum UTF-8 bytes returned
 * @returns Unicode-safe prefix within byte budget
 */
export function utf8SafePrefix(text: string, maxBytes: number): string {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(text, "utf8") <= byteLimit) return text;

  let usedBytes = 0;
  let prefix = "";
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (usedBytes + characterBytes > byteLimit) break;
    prefix += character;
    usedBytes += characterBytes;
  }
  return prefix;
}

/**
 * Creates a bounded line-based head + tail sandwich preview.
 * Preserves top lines (head) and bottom lines (tail) without cutting mid-line,
 * inserting an omission banner in the middle.
 *
 * @param text - Source text to preview
 * @param maxBytes - Maximum UTF-8 bytes allowed (default: 12 KiB)
 * @param headRatio - Proportion of line budget reserved for head (default: 0.3)
 * @returns Line-safe, Unicode-safe head + tail preview within byte budget
 */
export function createLineSandwichPreview(
  text: string,
  maxBytes = DEFAULT_PREVIEW_MAX_BYTES,
  headRatio = DEFAULT_PREVIEW_HEAD_RATIO
): string {
  const byteLimit = Math.max(0, Math.floor(maxBytes));
  if (Buffer.byteLength(text, "utf8") <= byteLimit) {
    return text;
  }

  // Split into lines preserving line terminators
  const lines = text.match(/.*(?:\r\n|\n|\r|$)/gu)?.filter((l) => l.length > 0) ?? [];
  if (lines.length === 0) {
    return utf8SafePrefix(text, byteLimit);
  }

  const defaultMarker = TEXT_PREVIEW_OMISSION_MARKER;
  const markerEstBytes = Buffer.byteLength(defaultMarker, "utf8");
  if (byteLimit <= markerEstBytes) {
    return utf8SafePrefix(defaultMarker, byteLimit);
  }

  const lineBudget = byteLimit - markerEstBytes;
  const headBudget = Math.max(0, Math.floor(lineBudget * headRatio));

  // Collect head lines
  const headLines: string[] = [];
  let headBytes = 0;
  let headIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i], "utf8");
    if (headBytes + lineBytes <= headBudget) {
      headLines.push(lines[i]);
      headBytes += lineBytes;
      headIndex = i + 1;
    } else {
      break;
    }
  }

  // If head is completely empty but line 0 fits within total line budget, give line 0 to head
  if (headLines.length === 0 && lines.length > 0) {
    const line0Bytes = Buffer.byteLength(lines[0], "utf8");
    if (line0Bytes <= lineBudget) {
      headLines.push(lines[0]);
      headBytes += line0Bytes;
      headIndex = 1;
    }
  }

  // Collect tail lines from bottom up using remaining budget
  const tailLines: string[] = [];
  let tailBytes = 0;
  const remainingForTail = Math.max(0, lineBudget - headBytes);

  for (let i = lines.length - 1; i >= headIndex; i--) {
    const lineBytes = Buffer.byteLength(lines[i], "utf8");
    if (tailBytes + lineBytes <= remainingForTail) {
      tailLines.unshift(lines[i]);
      tailBytes += lineBytes;
    } else {
      break;
    }
  }

  // If all lines fit without omission
  if (headLines.length + tailLines.length >= lines.length) {
    return text;
  }

  const omittedLines = lines.length - headLines.length - tailLines.length;

  // Format banner: if tail is present, format as sandwich with newlines; if tail is empty, match default marker
  let banner =
    tailLines.length > 0
      ? `\n... [SlothMCP: ${omittedLines} complete lines omitted; use read_result to retrieve them] ...\n`
      : defaultMarker;

  let headText = headLines.join("");
  let tailText = tailLines.join("");

  // Ensure total bytes does not exceed byteLimit
  while (tailLines.length > 0 && Buffer.byteLength(headText + banner + tailText, "utf8") > byteLimit) {
    tailLines.shift();
    tailText = tailLines.join("");
    const curOmitted = lines.length - headLines.length - tailLines.length;
    banner =
      tailLines.length > 0
        ? `\n... [SlothMCP: ${curOmitted} complete lines omitted; use read_result to retrieve them] ...\n`
        : defaultMarker;
  }

  while (headLines.length > 1 && Buffer.byteLength(headText + banner + tailText, "utf8") > byteLimit) {
    headLines.pop();
    headText = headLines.join("");
  }

  const combined = `${headText}${banner}${tailText}`;
  if (Buffer.byteLength(combined, "utf8") <= byteLimit) {
    return combined;
  }

  return utf8SafePrefix(combined, byteLimit);
}

/**
 * Creates a bounded high-signal preview for structured JSON data.
 * Uniform object arrays are formatted as compact CSV tables with head + tail rows.
 * Arbitrary JSON arrays or objects return valid sample structures with omission metadata.
 *
 * @param value - Any parsed JSON value
 * @param maxBytes - Maximum UTF-8 bytes allowed (default: 12 KiB)
 * @returns Bounded string representation of JSON data
 */
export function createHighSignalJsonPreview(
  value: unknown,
  maxBytes = DEFAULT_PREVIEW_MAX_BYTES
): string {
  // Case 1: Uniform object array -> Tabular CSV with head + tail rows (50-70% token savings)
  if (isUniformObjectArray(value)) {
    const csv = tabularizeJsonArray(value);
    return createLineSandwichPreview(csv, maxBytes, DEFAULT_PREVIEW_HEAD_RATIO);
  }

  // Case 2: Generic Array -> Sample head items + tail items with explicit metadata
  if (Array.isArray(value)) {
    const total = value.length;
    if (total === 0) return "[]";

    let headCount = Math.min(DEFAULT_JSON_PREVIEW_HEAD_ITEMS, total);
    let tailCount = Math.min(DEFAULT_JSON_PREVIEW_TAIL_ITEMS, Math.max(0, total - headCount));

    while (headCount > 0 || tailCount > 0) {
      const headItems = value.slice(0, headCount);
      const tailItems = tailCount > 0 ? value.slice(total - tailCount) : [];
      const omitted = total - headCount - tailCount;

      const sampleObj = {
        _sloth_preview: {
          type: "array",
          totalItems: total,
          headCount,
          tailCount,
          omittedCount: omitted,
        },
        head: headItems,
        ...(tailCount > 0 ? { tail: tailItems } : {}),
      };

      const serialized = JSON.stringify(sampleObj, null, 2);
      if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
        return serialized;
      }

      if (tailCount > 0) {
        tailCount--;
      } else if (headCount > 1) {
        headCount--;
      } else {
        break;
      }
    }

    return JSON.stringify(summarizeJsonStructure(value), null, 2);
  }

  // Case 3: Object with potential large array or many keys
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);

    const previewObj: Record<string, unknown> = {};
    for (const k of keys.slice(0, 10)) {
      const v = obj[k];
      if (Array.isArray(v) && v.length > 5) {
        if (isUniformObjectArray(v)) {
          previewObj[k] = `[${v.length} items tabular preview]:\n` + createHighSignalJsonPreview(v, Math.floor(maxBytes / 2));
        } else {
          previewObj[k] = {
            _sloth_preview: { totalItems: v.length, omitted: v.length - 3 },
            sample: v.slice(0, 3),
          };
        }
      } else {
        previewObj[k] = v;
      }
    }

    const serialized = JSON.stringify(previewObj, null, 2);
    if (Buffer.byteLength(serialized, "utf8") <= maxBytes) {
      return serialized;
    }

    return createLineSandwichPreview(JSON.stringify(value, null, 2), maxBytes, DEFAULT_PREVIEW_HEAD_RATIO);
  }

  // Fallback for primitives
  return createLineSandwichPreview(String(value), maxBytes, DEFAULT_PREVIEW_HEAD_RATIO);
}

/**
 * Creates a bounded preview containing complete text lines only.
 * Preserves top lines and bottom lines using line sandwich slicing.
 *
 * @param text - Source text to preview
 * @param maxBytes - Maximum UTF-8 bytes returned, including omission marker
 * @returns Line-safe, Unicode-safe preview within byte budget
 */
export function createTextPreview(text: string, maxBytes = DEFAULT_PREVIEW_MAX_BYTES): string {
  return createLineSandwichPreview(text, maxBytes, DEFAULT_PREVIEW_HEAD_RATIO);
}

/**
 * Legacy preview-only output shaper. Never use transformed output as authoritative tool result.
 * 1. Detects JSON payloads and tabularizes uniform arrays (saving 50-70% tokens).
 * 2. Minifies generic JSON objects (stripping redundant whitespace).
 * 3. Enforces the hard character ceiling using Smart Sandwich Slicing.
 *
 * @param rawContent - Raw text output from downstream tool execution
 * @param options - ShaperOptions controlling limits and tabularization
 * @returns Shaped output string
 */
export function shapeToolOutput(rawContent: string, options: ShaperOptions = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const headRatio = options.headRatio ?? DEFAULT_HEAD_RATIO;
  const enableTabular = options.enableTabularization ?? true;

  let processed = rawContent;

  const trimmed = rawContent.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      const parsed = JSON.parse(trimmed);

      if (enableTabular && isUniformObjectArray(parsed)) {
        processed = tabularizeJsonArray(parsed);
      } else {
        // Minify generic JSON (removes indentation whitespace bloat)
        processed = JSON.stringify(parsed);
      }
    } catch {
      // Not valid JSON, keep as plain text
      processed = rawContent;
    }
  }

  return sandwichSlice(processed, maxChars, headRatio);
}
