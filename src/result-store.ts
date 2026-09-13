import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { getCacheDir } from "./config.js";

/** Default byte budget for one raw page (24 KiB) */
export const DEFAULT_RAW_PAGE_BYTES = 24 * 1024;
/** Maximum byte budget for one raw page (30 KiB) */
export const MAX_RAW_PAGE_BYTES = 30 * 1024;
/** Default number of items returned in one JSON page */
export const DEFAULT_JSON_PAGE_VALUES = 20;
/** Maximum number of items returned in one JSON page */
export const MAX_JSON_PAGE_VALUES = 100;
/** Default number of lines returned in one text page */
export const DEFAULT_TEXT_PAGE_LINES = 200;
/** Maximum number of lines returned in one text page */
export const MAX_TEXT_PAGE_LINES = 500;
/** Default stored result lifetime in milliseconds (two hours) */
export const DEFAULT_RESULT_TTL_MS = 2 * 60 * 60 * 1000;
/** Default maximum byte size of a single stored result (64 MiB) */
export const DEFAULT_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** Default maximum aggregate byte size of stored results (256 MiB) */
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
/** Default maximum number of stored entries per instance */
export const DEFAULT_MAX_ENTRIES = 128;
/** Default maximum byte size for an individual complete JSON value or text line (24 KiB) */
export const DEFAULT_JSON_VALUE_BYTES = 24 * 1024;

/** Owner-only directory permissions (rwx------) */
const DIRECTORY_MODE = 0o700;
/** Owner-only file permissions (rw-------) */
const FILE_MODE = 0o600;
/** Maximum byte length of a single UTF-8 code point */
const MAX_UTF8_CODE_POINT_BYTES = 4;
/** Canonical UUIDv4 validation pattern */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** Serialized data file name */
const DATA_FILE = "result.json";
/** Serialized metadata file name */
const META_FILE = "meta.json";

/** Source target for JSON or text retrieval operations. */
export type ResultSourceSelector = "auto" | "structured" | "root" | number;

/** Recommended retrieval view name. */
export type RecommendedView = "json" | "text" | "envelope" | "raw";

/** Options for configuring an instance-scoped ResultStore. */
export interface ResultStoreOptions {
  ttlMs?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Basic stored result metadata. */
export interface StoredResultInfo {
  id: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
}

/** Complete stored metadata with epoch millisecond timestamps. */
interface StoredMetadata extends StoredResultInfo {
  createdAtMs: number;
  expiresAtMs: number;
}

/** Structural envelope view describing stored result attributes. */
export interface EnvelopeView extends StoredResultInfo {
  contentBlocks: number;
  contentTypes: string[];
  hasStructuredContent: boolean;
  isError: boolean;
  hasMeta: boolean;
  topLevelKeys: string[];
}

/** UTF-8 raw view fragment. */
export interface RawView {
  data: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
  sha256: string;
}

/** Bounded summary of a value that exceeds the per-value byte budget. */
export interface JsonValueSummary {
  omitted: true;
  type: string;
  bytes: number;
  length?: number;
  keys?: number;
  guidance: string;
}

/** JSON view containing complete values or bounded object summaries. */
export interface JsonView {
  source: "structured" | "root" | number;
  pointer: string;
  values: unknown[];
  offset: number;
  nextOffset: number | null;
  totalValues: number;
}

/** Options for JSON retrieval operations. */
export interface JsonReadOptions {
  source?: ResultSourceSelector;
  pointer?: string;
  offset?: number;
  limit?: number;
  maxValueBytes?: number;
}

/** Text view containing complete logical lines. */
export interface TextView {
  source?: "structured" | "root" | number;
  blockIndex?: number;
  pointer?: string;
  lines: Array<string | JsonValueSummary>;
  offset: number;
  nextOffset: number | null;
  totalLines: number;
}

/** Options for text retrieval operations. */
export interface TextReadOptions {
  source?: ResultSourceSelector;
  blockIndex?: number;
  pointer?: string;
  offset?: number;
  limit?: number;
  maxLineBytes?: number;
}

/** Result inspection recommendation for callers. */
export interface AutoViewRecommendation {
  recommendedView: RecommendedView;
  source?: "structured" | "root" | number;
  blockIndex?: number;
  reason: string;
}

/** Base error class for ResultStore operations. */
export class ResultStoreError extends Error {
  /** Creates stable store error without exposing filesystem paths. */
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ResultStoreError";
  }
}

/** Error thrown when an opaque result ID is malformed or invalid. */
export class InvalidResultIdError extends ResultStoreError {
  /** Creates error for malformed opaque result IDs. */
  public constructor() {
    super("INVALID_ID", "Invalid result ID");
  }
}

/** Error thrown when a result cannot be found or has been removed. */
export class ResultNotFoundError extends ResultStoreError {
  /** Creates error for absent or inaccessible stored results. */
  public constructor() {
    super("NOT_FOUND", "Stored result not found");
  }
}

/** Error thrown when a stored result has exceeded its TTL. */
export class ResultExpiredError extends ResultStoreError {
  /** Creates error for results whose TTL elapsed. */
  public constructor() {
    super("EXPIRED", "Stored result expired");
  }
}

/** Error thrown when a result exceeds the maximum single-entry size quota. */
export class ResultTooLargeError extends ResultStoreError {
  /** Creates error for entries exceeding configured per-entry quota. */
  public constructor() {
    super("ENTRY_TOO_LARGE", "Result exceeds maximum entry size");
  }
}

/** Error thrown when a retrieval view parameter, pointer, or source selector is invalid. */
export class InvalidResultReadError extends ResultStoreError {
  /** Creates error for invalid view parameters or JSON pointers. */
  public constructor(message: string) {
    super("INVALID_READ", message);
  }
}

/**
 * Serializes a complete CallToolResult to canonical stored UTF-8 JSON.
 *
 * @param result - Downstream CallToolResult to serialize
 * @returns UTF-8 Buffer containing canonical JSON
 */
export function serializeCallToolResult(result: CallToolResult): Buffer {
  try {
    const serialized = JSON.stringify(result);
    if (serialized === undefined) throw new Error("undefined serialization");
    return Buffer.from(serialized, "utf8");
  } catch {
    throw new ResultStoreError("SERIALIZATION_FAILED", "Result is not JSON serializable");
  }
}

/**
 * Measures the complete CallToolResult serialized UTF-8 byte length.
 *
 * @param result - Downstream CallToolResult to measure
 * @returns Serialized byte length
 */
export function measureCallToolResult(result: CallToolResult): number {
  return serializeCallToolResult(result).byteLength;
}

/**
 * Validates and returns an opaque UUID result ID.
 *
 * @param id - Candidate result ID string
 * @returns Validated UUID string
 */
export function validateResultId(id: string): string {
  if (!UUID_PATTERN.test(id)) throw new InvalidResultIdError();
  return id;
}

/**
 * Resolves an RFC 6901 JSON Pointer against a JSON value.
 *
 * @param root - Root JSON value to evaluate pointer against
 * @param pointer - RFC 6901 JSON Pointer string
 * @returns Resolved value at pointer location
 */
export function resolveJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) {
    throw new InvalidResultReadError("JSON pointer must be empty or start with '/'");
  }
  let value: unknown = root;
  for (const rawToken of pointer.slice(1).split("/")) {
    if (/~(?:[^01]|$)/u.test(rawToken)) {
      throw new InvalidResultReadError("JSON pointer contains invalid escape");
    }
    const token = rawToken.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9]\d*)$/u.test(token)) {
        throw new InvalidResultReadError("JSON pointer array token is invalid");
      }
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length) {
        throw new InvalidResultReadError("JSON pointer does not exist");
      }
      value = value[index];
    } else if (value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, token)) {
      value = (value as Record<string, unknown>)[token];
    } else {
      throw new InvalidResultReadError("JSON pointer does not exist");
    }
  }
  return value;
}

/**
 * Resolves the JSON root based on source selector and CallToolResult contents.
 *
 * @param result - CallToolResult to extract root from
 * @param source - Source selector ("auto", "structured", "root", or content block index)
 * @returns Resolved root value and the resolved source tag
 */
export function resolveJsonRoot(
  result: CallToolResult,
  source: ResultSourceSelector = "auto",
): { root: unknown; resolvedSource: "structured" | "root" | number } {
  if (source === "structured") {
    if (result.structuredContent === undefined) {
      throw new InvalidResultReadError("Result does not contain structuredContent");
    }
    return { root: result.structuredContent, resolvedSource: "structured" };
  }

  if (source === "root") {
    return { root: result, resolvedSource: "root" };
  }

  if (typeof source === "number") {
    if (!Number.isInteger(source) || source < 0) {
      throw new InvalidResultReadError("Content block index must be a non-negative integer");
    }
    const content = Array.isArray(result.content) ? result.content : [];
    if (source >= content.length) {
      throw new InvalidResultReadError(`Content block index ${source} out of bounds`);
    }
    const block = content[source];
    if (
      typeof block !== "object" ||
      block === null ||
      !("type" in block) ||
      block.type !== "text" ||
      !("text" in block) ||
      typeof block.text !== "string"
    ) {
      throw new InvalidResultReadError(`Content block ${source} is not a text block`);
    }
    try {
      return { root: JSON.parse(block.text), resolvedSource: source };
    } catch {
      throw new InvalidResultReadError(`Content block ${source} text is not valid JSON`);
    }
  }

  // source === "auto"
  if (result.structuredContent !== undefined) {
    return { root: result.structuredContent, resolvedSource: "structured" };
  }

  const content = Array.isArray(result.content) ? result.content : [];
  if (
    content.length === 1 &&
    typeof content[0] === "object" &&
    content[0] !== null &&
    "type" in content[0] &&
    content[0].type === "text" &&
    "text" in content[0] &&
    typeof content[0].text === "string"
  ) {
    try {
      return { root: JSON.parse(content[0].text), resolvedSource: 0 };
    } catch {
      // not JSON text, fall through to root
    }
  }

  return { root: result, resolvedSource: "root" };
}

/**
 * Inspects a CallToolResult and recommends the best retrieval view and source selector.
 *
 * @param result - CallToolResult to inspect
 * @returns Recommended view, source selector, and explanation
 */
export function recommendResultView(result: CallToolResult): AutoViewRecommendation {
  if (result.structuredContent !== undefined) {
    return {
      recommendedView: "json",
      source: "structured",
      reason: "Result contains structuredContent",
    };
  }

  const content = Array.isArray(result.content) ? result.content : [];
  if (content.length === 1) {
    const single = content[0];
    if (
      typeof single === "object" &&
      single !== null &&
      "type" in single &&
      single.type === "text" &&
      "text" in single &&
      typeof single.text === "string"
    ) {
      try {
        JSON.parse(single.text);
        return {
          recommendedView: "json",
          source: 0,
          blockIndex: 0,
          reason: "Single text content block contains valid JSON",
        };
      } catch {
        return {
          recommendedView: "text",
          source: 0,
          blockIndex: 0,
          reason: "Single plain text content block",
        };
      }
    }
    return {
      recommendedView: "envelope",
      source: "root",
      reason: "Single non-text content block",
    };
  }

  if (content.length === 0) {
    return {
      recommendedView: "envelope",
      source: "root",
      reason: "Result has no content blocks",
    };
  }

  return {
    recommendedView: "envelope",
    source: "root",
    reason: "Result contains multiple content blocks; inspect envelope to select block",
  };
}

/**
 * Summarizes a complete JSON value that cannot fit the bounded view.
 *
 * @param value - Value to summarize
 * @param bytes - Measured UTF-8 byte length
 * @returns Structured summary metadata with guidance
 */
function summarizeValue(value: unknown, bytes: number): JsonValueSummary {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return {
    omitted: true,
    type,
    bytes,
    ...(typeof value === "string" ? { length: value.length } : {}),
    ...(Array.isArray(value) ? { length: value.length } : {}),
    ...(value !== null && typeof value === "object" && !Array.isArray(value)
      ? { keys: Object.keys(value).length }
      : {}),
    guidance: "Select a deeper JSON pointer or use raw view",
  };
}

/**
 * Formats values for a JSON view page, summarizing oversized fields or items.
 *
 * @param selected - Resolved JSON target (array, object, or primitive)
 * @param offset - Offset index for arrays or keys
 * @param limit - Max number of array items or object keys
 * @param maxValueBytes - Max byte budget before individual value is summarized
 * @returns Formatted values array, nextOffset, and totalValues count
 */
function formatJsonViewValues(
  selected: unknown,
  offset: number,
  limit: number,
  maxValueBytes: number,
): { values: unknown[]; nextOffset: number | null; totalValues: number } {
  if (Array.isArray(selected)) {
    const page = selected.slice(offset, offset + limit).map((item) => {
      try {
        const serialized = JSON.stringify(item);
        const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
        return bytes <= maxValueBytes ? item : summarizeValue(item, bytes);
      } catch {
        return summarizeValue(item, 0);
      }
    });
    const nextOffset = offset + page.length < selected.length ? offset + page.length : null;
    return { values: page, nextOffset, totalValues: selected.length };
  }

  if (selected !== null && typeof selected === "object") {
    const record = selected as Record<string, unknown>;
    const keys = Object.keys(record);
    const totalValues = keys.length;

    let entireBytes = 0;
    let isEntireSerializable = true;
    try {
      const fullSerialized = JSON.stringify(record);
      entireBytes = fullSerialized === undefined ? 0 : Buffer.byteLength(fullSerialized, "utf8");
    } catch {
      isEntireSerializable = false;
    }

    if (isEntireSerializable && entireBytes <= maxValueBytes && offset === 0 && limit >= keys.length) {
      return { values: [record], nextOffset: null, totalValues: 1 };
    }

    const pageKeys = keys.slice(offset, offset + limit);
    const summaryObject: Record<string, unknown> = {};
    for (const key of pageKeys) {
      const val = record[key];
      try {
        const serialized = JSON.stringify(val);
        const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
        summaryObject[key] = bytes <= maxValueBytes ? val : summarizeValue(val, bytes);
      } catch {
        summaryObject[key] = summarizeValue(val, 0);
      }
    }
    const nextOffset = offset + pageKeys.length < keys.length ? offset + pageKeys.length : null;
    return { values: [summaryObject], nextOffset, totalValues };
  }

  try {
    const serialized = JSON.stringify(selected);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
    const val = bytes <= maxValueBytes ? selected : summarizeValue(selected, bytes);
    return { values: [val], nextOffset: null, totalValues: 1 };
  } catch {
    return { values: [summarizeValue(selected, 0)], nextOffset: null, totalValues: 1 };
  }
}

/**
 * Validates and returns a bounded integer view parameter.
 *
 * @param value - Candidate parameter value
 * @param fallback - Default fallback value
 * @param maximum - Maximum allowed value
 * @param name - Name of parameter for error messages
 * @param allowZero - Whether zero is an acceptable value
 * @returns Validated integer within bounds
 */
function boundedInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string,
  allowZero = false,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < (allowZero ? 0 : 1) || selected > maximum) {
    throw new InvalidResultReadError(`${name} must be an integer between ${allowZero ? 0 : 1} and ${maximum}`);
  }
  return selected;
}

/**
 * Splits text while retaining complete logical lines and line terminators.
 *
 * @param text - Text to split into lines
 * @returns Array of individual lines with preserved line endings
 */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/.*?(?:\r\n|\n|\r|$)/gu)?.filter((line) => line.length > 0) ?? [];
}

/**
 * Stores and retrieves complete MCP tool results within an isolated instance directory.
 */
export class ResultStore {
  public readonly directory: string;
  private readonly ttlMs: number;
  private readonly maxEntryBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private ready: Promise<void>;
  private mutation: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * Creates an instance-scoped result store and schedules secure directory initialization.
   *
   * @param options - Store configuration options
   */
  public constructor(options: ResultStoreOptions = {}) {
    this.ttlMs = this.positiveOption(options.ttlMs, DEFAULT_RESULT_TTL_MS, "ttlMs");
    this.maxEntryBytes = this.positiveOption(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES, "maxEntryBytes");
    this.maxTotalBytes = this.positiveOption(options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes");
    this.maxEntries = this.positiveOption(options.maxEntries, DEFAULT_MAX_ENTRIES, "maxEntries");
    if (this.maxEntryBytes > this.maxTotalBytes) {
      throw new InvalidResultReadError("maxEntryBytes cannot exceed maxTotalBytes");
    }
    this.now = options.now ?? Date.now;
    this.directory = join(getCacheDir(), "results", randomUUID());
    this.ready = mkdir(this.directory, { recursive: true, mode: DIRECTORY_MODE }).then(() => undefined);
  }

  /**
   * Validates a positive integer constructor option and returns its selected value.
   *
   * @param value - Candidate numeric option
   * @param fallback - Default fallback value
   * @param name - Option name for error reporting
   * @returns Positive integer
   */
  private positiveOption(value: number | undefined, fallback: number, name: string): number {
    const selected = value ?? fallback;
    if (!Number.isInteger(selected) || selected <= 0) {
      throw new InvalidResultReadError(`${name} must be a positive integer`);
    }
    return selected;
  }

  /**
   * Asserts that the store has not been closed.
   */
  private assertOpen(): void {
    if (this.closed) throw new ResultStoreError("CLOSED", "Result store is closed");
  }

  /**
   * Serializes mutations to ensure deterministic quota accounting.
   *
   * @param operation - Async operation to execute exclusively
   * @returns Result of the operation
   */
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutation;
    let release!: () => void;
    this.mutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  /**
   * Materializes a complete result using owner-only atomic temp-file renames.
   *
   * @param result - Complete CallToolResult to store
   * @returns Stored result metadata and digest
   */
  public async materialize(result: CallToolResult): Promise<StoredResultInfo> {
    this.assertOpen();
    const data = serializeCallToolResult(result);
    if (data.byteLength > this.maxEntryBytes) throw new ResultTooLargeError();
    return this.mutate(async () => {
      await this.ready;
      this.assertOpen();
      await this.evictFor(data.byteLength);
      const id = randomUUID();
      const entryDirectory = join(this.directory, id);
      const temporaryDirectory = join(this.directory, `.${id}.tmp`);
      const createdAtMs = this.now();
      const metadata: StoredMetadata = {
        id,
        bytes: data.byteLength,
        sha256: createHash("sha256").update(data).digest("hex"),
        createdAt: new Date(createdAtMs).toISOString(),
        expiresAt: new Date(createdAtMs + this.ttlMs).toISOString(),
        createdAtMs,
        expiresAtMs: createdAtMs + this.ttlMs,
      };
      try {
        await mkdir(temporaryDirectory, { mode: DIRECTORY_MODE });
        await this.writeFileDurable(join(temporaryDirectory, DATA_FILE), data);
        await this.writeFileDurable(join(temporaryDirectory, META_FILE), Buffer.from(JSON.stringify(metadata), "utf8"));
        await rename(temporaryDirectory, entryDirectory);
      } catch {
        await rm(temporaryDirectory, { recursive: true, force: true });
        throw new ResultStoreError("MATERIALIZATION_FAILED", "Failed to store result");
      }
      return metadata;
    });
  }

  /**
   * Writes and fsyncs one owner-readable file before publication.
   *
   * @param path - Destination file path
   * @param data - Buffer to write
   */
  private async writeFileDurable(path: string, data: Buffer): Promise<void> {
    const handle = await open(path, "wx", FILE_MODE);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /**
   * Lists valid entry metadata and cleans expired or abandoned temporary entries.
   *
   * @returns Array of active stored metadata
   */
  private async listMetadata(): Promise<StoredMetadata[]> {
    const names = await readdir(this.directory).catch(() => [] as string[]);
    const entries: StoredMetadata[] = [];
    for (const name of names) {
      if (name.startsWith(".") && name.endsWith(".tmp")) {
        await rm(join(this.directory, name), { recursive: true, force: true });
        continue;
      }
      if (!UUID_PATTERN.test(name)) continue;
      try {
        const metadata = JSON.parse(await readFile(join(this.directory, name, META_FILE), "utf8")) as StoredMetadata;
        if (metadata.id !== name || !Number.isSafeInteger(metadata.bytes)) throw new Error("invalid metadata");
        if (metadata.expiresAtMs <= this.now()) {
          await rm(join(this.directory, name), { recursive: true, force: true });
        } else {
          entries.push(metadata);
        }
      } catch {
        await rm(join(this.directory, name), { recursive: true, force: true });
      }
    }
    return entries;
  }

  /**
   * Evicts expired then oldest entries until count and aggregate quotas admit incoming bytes.
   *
   * @param incomingBytes - Size of upcoming new entry in bytes
   */
  private async evictFor(incomingBytes: number): Promise<void> {
    const entries = (await this.listMetadata()).sort((left, right) => left.createdAtMs - right.createdAtMs);
    let totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    while (entries.length >= this.maxEntries || totalBytes + incomingBytes > this.maxTotalBytes) {
      const oldest = entries.shift();
      if (!oldest) throw new ResultStoreError("QUOTA_EXCEEDED", "Result storage quota exceeded");
      await rm(join(this.directory, oldest.id), { recursive: true, force: true });
      totalBytes -= oldest.bytes;
    }
  }

  /**
   * Loads, validates, and integrity-checks one complete stored serialization.
   *
   * @param id - Opaque result ID
   * @returns Loaded metadata, raw buffer, and parsed CallToolResult
   */
  private async load(id: string): Promise<{ metadata: StoredMetadata; data: Buffer; result: CallToolResult }> {
    this.assertOpen();
    validateResultId(id);
    await this.ready;
    try {
      const metadata = JSON.parse(await readFile(join(this.directory, id, META_FILE), "utf8")) as StoredMetadata;
      if (metadata.id !== id) throw new ResultNotFoundError();
      if (metadata.expiresAtMs <= this.now()) {
        await rm(join(this.directory, id), { recursive: true, force: true });
        throw new ResultExpiredError();
      }
      const data = await readFile(join(this.directory, id, DATA_FILE));
      const digest = createHash("sha256").update(data).digest("hex");
      if (data.byteLength !== metadata.bytes || digest !== metadata.sha256) throw new ResultNotFoundError();
      return { metadata, data, result: JSON.parse(data.toString("utf8")) as CallToolResult };
    } catch (error) {
      if (error instanceof ResultStoreError) throw error;
      throw new ResultNotFoundError();
    }
  }

  /**
   * Inspects a stored result and returns the recommended retrieval view and source selector.
   *
   * @param id - Opaque result ID
   * @returns Recommendation including view, source selector, and explanation
   */
  public async inspect(id: string): Promise<AutoViewRecommendation> {
    const { result } = await this.load(id);
    return recommendResultView(result);
  }

  /**
   * Reads bounded structural metadata for a stored result.
   *
   * @param id - Opaque result ID
   * @returns Envelope view metadata
   */
  public async readEnvelope(id: string): Promise<EnvelopeView> {
    const { metadata, result } = await this.load(id);
    const content = Array.isArray(result.content) ? result.content : [];
    return {
      id: metadata.id,
      bytes: metadata.bytes,
      sha256: metadata.sha256,
      createdAt: metadata.createdAt,
      expiresAt: metadata.expiresAt,
      contentBlocks: content.length,
      contentTypes: [
        ...new Set(
          content.map((block) =>
            typeof block === "object" && block !== null && "type" in block ? String(block.type) : "unknown",
          ),
        ),
      ],
      hasStructuredContent: "structuredContent" in result,
      isError: result.isError === true,
      hasMeta: "_meta" in result,
      topLevelKeys: Object.keys(result).slice(0, DEFAULT_JSON_PAGE_VALUES),
    };
  }

  /**
   * Reads complete JSON values selected by source, RFC 6901 pointer, and pagination.
   *
   * @param id - Opaque result ID
   * @param pointerOrOptions - JSON pointer string or JSON read options
   * @param offset - Item offset for arrays or object keys
   * @param limit - Maximum items or keys returned in page
   * @param maxValueBytes - Maximum byte threshold before individual value is summarized
   * @param source - Source selector ("auto", "structured", "root", or content block index)
   * @returns Paged JSON view with complete values or bounded field summaries
   */
  public async readJson(
    id: string,
    pointerOrOptions?: string | JsonReadOptions,
    offset = 0,
    limit = DEFAULT_JSON_PAGE_VALUES,
    maxValueBytes = DEFAULT_JSON_VALUE_BYTES,
    source: ResultSourceSelector = "auto",
  ): Promise<JsonView> {
    const options: JsonReadOptions =
      typeof pointerOrOptions === "object" && pointerOrOptions !== null
        ? pointerOrOptions
        : {
            pointer: pointerOrOptions,
            offset,
            limit,
            maxValueBytes,
            source,
          };

    const selectedPointer = options.pointer ?? "";
    const selectedOffset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, "offset", true);
    const selectedLimit = boundedInteger(options.limit, DEFAULT_JSON_PAGE_VALUES, MAX_JSON_PAGE_VALUES, "limit");
    const selectedMaxBytes = boundedInteger(
      options.maxValueBytes,
      DEFAULT_JSON_VALUE_BYTES,
      MAX_RAW_PAGE_BYTES,
      "maxValueBytes",
    );
    const selectedSource = options.source ?? "auto";

    const { result } = await this.load(id);
    const { root, resolvedSource } = resolveJsonRoot(result, selectedSource);
    const selected = resolveJsonPointer(root, selectedPointer);
    const formatted = formatJsonViewValues(selected, selectedOffset, selectedLimit, selectedMaxBytes);

    return {
      source: resolvedSource,
      pointer: selectedPointer,
      values: formatted.values,
      offset: selectedOffset,
      nextOffset: formatted.nextOffset,
      totalValues: formatted.totalValues,
    };
  }

  /**
   * Reads complete text lines from selected content block or JSON pointer.
   *
   * @param id - Opaque result ID
   * @param offsetOrOptions - Line offset or text read options
   * @param limit - Maximum lines returned in page
   * @param maxLineBytes - Maximum byte threshold before a single line is summarized
   * @param blockIndex - Target content block index
   * @param pointer - Optional JSON pointer to a string value
   * @param source - Source selector ("auto", "structured", "root", or block index)
   * @returns Paged text view with complete logical lines
   */
  public async readText(
    id: string,
    offsetOrOptions?: number | TextReadOptions,
    limit = DEFAULT_TEXT_PAGE_LINES,
    maxLineBytes = DEFAULT_JSON_VALUE_BYTES,
    blockIndex?: number,
    pointer?: string,
    source: ResultSourceSelector = "auto",
  ): Promise<TextView> {
    const options: TextReadOptions =
      typeof offsetOrOptions === "object" && offsetOrOptions !== null
        ? offsetOrOptions
        : {
            offset: offsetOrOptions,
            limit,
            maxLineBytes,
            blockIndex,
            pointer,
            source,
          };

    const selectedOffset = boundedInteger(options.offset, 0, Number.MAX_SAFE_INTEGER, "offset", true);
    const selectedLimit = boundedInteger(options.limit, DEFAULT_TEXT_PAGE_LINES, MAX_TEXT_PAGE_LINES, "limit");
    const selectedMaxBytes = boundedInteger(
      options.maxLineBytes,
      DEFAULT_JSON_VALUE_BYTES,
      MAX_RAW_PAGE_BYTES,
      "maxLineBytes",
    );

    const { result } = await this.load(id);
    let rawText: string;
    let resolvedSource: "structured" | "root" | number | undefined;
    let resolvedBlockIndex: number | undefined;

    if (options.pointer !== undefined) {
      const sourceSelector = options.blockIndex !== undefined ? options.blockIndex : (options.source ?? "auto");
      const { root, resolvedSource: src } = resolveJsonRoot(result, sourceSelector);
      resolvedSource = src;
      const target = resolveJsonPointer(root, options.pointer);
      if (typeof target !== "string") {
        throw new InvalidResultReadError("Resolved JSON pointer does not target a string value");
      }
      rawText = target;
    } else if (options.blockIndex !== undefined) {
      const content = Array.isArray(result.content) ? result.content : [];
      if (options.blockIndex < 0 || options.blockIndex >= content.length) {
        throw new InvalidResultReadError(`Content block index ${options.blockIndex} out of bounds`);
      }
      const block = content[options.blockIndex];
      if (
        typeof block !== "object" ||
        block === null ||
        !("type" in block) ||
        block.type !== "text" ||
        !("text" in block) ||
        typeof block.text !== "string"
      ) {
        throw new InvalidResultReadError(`Content block ${options.blockIndex} is not a text block`);
      }
      rawText = block.text;
      resolvedBlockIndex = options.blockIndex;
      resolvedSource = options.blockIndex;
    } else {
      const content = Array.isArray(result.content) ? result.content : [];
      const textBlocks = content.filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          "type" in block &&
          block.type === "text" &&
          "text" in block &&
          typeof block.text === "string",
      );

      if (textBlocks.length === 1) {
        rawText = textBlocks[0].text;
        resolvedBlockIndex = content.indexOf(textBlocks[0]);
        resolvedSource = resolvedBlockIndex;
      } else if (textBlocks.length === 0) {
        if (typeof result.structuredContent === "string") {
          rawText = result.structuredContent;
          resolvedSource = "structured";
        } else {
          throw new InvalidResultReadError("Result contains no text content blocks");
        }
      } else {
        throw new InvalidResultReadError("Result has multiple text blocks; specify blockIndex or pointer");
      }
    }

    const lines = splitLines(rawText);
    const page = lines.slice(selectedOffset, selectedOffset + selectedLimit).map((line) => {
      const bytes = Buffer.byteLength(line, "utf8");
      return bytes <= selectedMaxBytes ? line : summarizeValue(line, bytes);
    });
    const nextOffset = selectedOffset + page.length < lines.length ? selectedOffset + page.length : null;

    return {
      source: resolvedSource,
      blockIndex: resolvedBlockIndex,
      pointer: options.pointer,
      lines: page,
      offset: selectedOffset,
      nextOffset,
      totalLines: lines.length,
    };
  }

  /**
   * Reads a UTF-8-safe raw page whose bytes concatenate to exact stored serialization.
   *
   * @param id - Opaque result ID
   * @param offset - Byte offset
   * @param maxBytes - Maximum byte budget for the page
   * @returns Raw UTF-8 fragment, nextOffset, totalBytes, and SHA-256
   */
  public async readRaw(id: string, offset = 0, maxBytes = DEFAULT_RAW_PAGE_BYTES): Promise<RawView> {
    const selectedOffset = boundedInteger(offset, 0, Number.MAX_SAFE_INTEGER, "offset", true);
    const selectedMaxBytes = boundedInteger(maxBytes, DEFAULT_RAW_PAGE_BYTES, MAX_RAW_PAGE_BYTES, "maxBytes");
    const { metadata, data } = await this.load(id);
    if (selectedOffset > data.byteLength) throw new InvalidResultReadError("offset exceeds result size");
    if (selectedOffset < data.byteLength && (data[selectedOffset] & 0xc0) === 0x80) {
      throw new InvalidResultReadError("offset must be a UTF-8 boundary returned by nextOffset");
    }
    let end = Math.min(data.byteLength, selectedOffset + selectedMaxBytes);
    while (end > selectedOffset && end < data.byteLength && (data[end] & 0xc0) === 0x80) end--;
    if (end === selectedOffset && end < data.byteLength) {
      end = Math.min(data.byteLength, selectedOffset + MAX_UTF8_CODE_POINT_BYTES);
      while (end < data.byteLength && (data[end] & 0xc0) === 0x80) end++;
    }
    const nextOffset = end < data.byteLength ? end : null;
    return {
      data: data.subarray(selectedOffset, end).toString("utf8"),
      offset: selectedOffset,
      nextOffset,
      totalBytes: data.byteLength,
      sha256: metadata.sha256,
    };
  }

  /**
   * Removes the instance directory and marks this store closed.
   */
  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.mutation;
    await this.ready;
    await rm(this.directory, { recursive: true, force: true });
  }
}
