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

export interface ShaperOptions {
  maxChars?: number; // Hard character ceiling (default: 30,000 chars ~ 7,500 tokens)
  headRatio?: number; // Ratio of budget for head vs tail (default: 0.2 -> 20% head / 80% tail)
  enableTabularization?: boolean; // Default: true
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
 * Main output shaper entrypoint for tool responses.
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
