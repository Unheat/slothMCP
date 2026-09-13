import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/server";
import {
  InvalidResultIdError,
  InvalidResultReadError,
  ResultExpiredError,
  ResultNotFoundError,
  ResultStore,
  ResultTooLargeError,
  measureCallToolResult,
  recommendResultView,
  serializeCallToolResult,
} from "../src/result-store.js";

const TEST_PAGE_BYTES = 17;
const TEST_TTL_MS = 1_000;
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const MODE_MASK = 0o777;
const stores: ResultStore[] = [];
let previousCacheDirectory: string | undefined;

/** Creates a tracked test store that is cleaned after each test. */
function createStore(options: ConstructorParameters<typeof ResultStore>[0] = {}): ResultStore {
  const store = new ResultStore(options);
  stores.push(store);
  return store;
}

/** Builds a representative CallToolResult with extension fields preserved by serialization. */
function representativeResult(): CallToolResult {
  return {
    content: [
      { type: "text", text: "first 😀 line\nsecond line\nthird" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      { type: "resource_link", uri: "file:///report.json", name: "report" },
    ],
    structuredContent: {
      users: [{ name: "Ada", tags: ["math", "code"] }, { name: "李", tags: ["研究"] }],
      "a/b": { "~key": true },
    },
    isError: false,
    _meta: { traceId: "trace-1" },
    extension: { retained: true },
  } as CallToolResult;
}

/** Configures isolated cache root for each test. */
beforeEach(async () => {
  previousCacheDirectory = process.env.SLOTH_CACHE_DIR;
  process.env.SLOTH_CACHE_DIR = join(
    process.cwd(),
    ".test-result-store",
    `${process.pid}-${Date.now()}-${Math.random()}`,
  );
  await mkdir(process.env.SLOTH_CACHE_DIR, { recursive: true });
});

/** Closes every test store and restores process environment. */
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  if (previousCacheDirectory === undefined) delete process.env.SLOTH_CACHE_DIR;
  else process.env.SLOTH_CACHE_DIR = previousCacheDirectory;
});

describe("ResultStore", () => {
  /** Verifies complete serialization, measurement, hash, atomic publication, and modes. */
  it("materializes a complete result atomically with owner-only permissions", async () => {
    const store = createStore();
    const result = representativeResult();
    const stored = await store.materialize(result);
    const entryDirectory = join(store.directory, stored.id);
    const dataPath = join(entryDirectory, "result.json");

    expect(stored.bytes).toBe(measureCallToolResult(result));
    expect(stored.sha256).toBe(createHash("sha256").update(serializeCallToolResult(result)).digest("hex"));
    expect(JSON.parse(await readFile(dataPath, "utf8"))).toEqual(result);
    expect((await stat(store.directory)).mode & MODE_MASK).toBe(OWNER_DIRECTORY_MODE);
    expect((await stat(entryDirectory)).mode & MODE_MASK).toBe(OWNER_DIRECTORY_MODE);
    expect((await stat(dataPath)).mode & MODE_MASK).toBe(OWNER_FILE_MODE);
    expect((await readdir(store.directory)).every((name) => !name.endsWith(".tmp"))).toBe(true);
  });

  /** Verifies raw pages reconstruct exact stored UTF-8 serialization and digest. */
  it("reconstructs Unicode raw bytes exactly across pages", async () => {
    const store = createStore();
    const result = representativeResult();
    const stored = await store.materialize(result);
    let offset = 0;
    let reconstructed = "";

    while (true) {
      const page = await store.readRaw(stored.id, offset, TEST_PAGE_BYTES);
      expect(page.data).not.toContain("\uFFFD");
      reconstructed += page.data;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }

    expect(Buffer.from(reconstructed, "utf8")).toEqual(serializeCallToolResult(result));
    expect(createHash("sha256").update(reconstructed).digest("hex")).toBe(stored.sha256);
  });

  /** Verifies RFC 6901 object escaping, array traversal, paging, and complete-value summaries. */
  it("reads complete JSON values by pointer and summarizes oversized values", async () => {
    const store = createStore();
    const stored = await store.materialize(representativeResult());

    expect((await store.readJson(stored.id, "/users/1/tags/0")).values).toEqual(["研究"]);
    expect((await store.readJson(stored.id, "/a~1b/~0key")).values).toEqual([true]);
    const users = await store.readJson(stored.id, "/users", 0, 1);
    expect(users.values).toEqual([{ name: "Ada", tags: ["math", "code"] }]);
    expect(users.nextOffset).toBe(1);

    const fromRoot = await store.readJson(stored.id, { source: "root", pointer: "/content/0/text", maxValueBytes: 8 });
    expect(fromRoot.values[0]).toMatchObject({ omitted: true, type: "string", guidance: expect.stringContaining("raw") });
    expect(() => JSON.stringify(fromRoot)).not.toThrow();
    await expect(store.readJson(stored.id, "/missing")).rejects.toBeInstanceOf(InvalidResultReadError);
  });

  /** Verifies selecting structuredContent by default when present and applying pointer relative to it. */
  it("selects structuredContent by default and evaluates relative pointer", async () => {
    const store = createStore();
    const result: CallToolResult = {
      content: [{ type: "text", text: "preview info" }],
      structuredContent: {
        total: 100,
        items: [{ id: 1, label: "alpha" }, { id: 2, label: "beta" }],
      },
    };
    const stored = await store.materialize(result);

    const defaultRead = await store.readJson(stored.id);
    expect(defaultRead.source).toBe("structured");
    expect(defaultRead.values[0]).toMatchObject({ total: 100 });

    const pointerRead = await store.readJson(stored.id, "/items/1/label");
    expect(pointerRead.source).toBe("structured");
    expect(pointerRead.values).toEqual(["beta"]);
  });

  /** Verifies reading JSON from a specified or auto-detected text content block. */
  it("parses and queries JSON within text content blocks", async () => {
    const store = createStore();
    const jsonPayload = JSON.stringify({ database: "users", rows: [{ id: "u1" }, { id: "u2" }] });
    const result: CallToolResult = {
      content: [{ type: "text", text: jsonPayload }],
    };
    const stored = await store.materialize(result);

    const autoRead = await store.readJson(stored.id, "/rows/0/id");
    expect(autoRead.source).toBe(0);
    expect(autoRead.values).toEqual(["u1"]);

    const explicitRead = await store.readJson(stored.id, { source: 0, pointer: "/database" });
    expect(explicitRead.values).toEqual(["users"]);

    const invalidJsonStore = await store.materialize({ content: [{ type: "text", text: "not-json" }] });
    await expect(store.readJson(invalidJsonStore.id, { source: 0 })).rejects.toBeInstanceOf(InvalidResultReadError);
  });

  /** Verifies selecting specific content blocks for text and JSON retrieval. */
  it("supports explicit content block selection", async () => {
    const store = createStore();
    const result: CallToolResult = {
      content: [
        { type: "text", text: "first log block\nwith two lines" },
        { type: "text", text: JSON.stringify({ count: 99 }) },
      ],
    };
    const stored = await store.materialize(result);

    const block0Text = await store.readText(stored.id, { blockIndex: 0 });
    expect(block0Text.blockIndex).toBe(0);
    expect(block0Text.lines).toEqual(["first log block\n", "with two lines"]);

    const block1Json = await store.readJson(stored.id, { source: 1, pointer: "/count" });
    expect(block1Json.source).toBe(1);
    expect(block1Json.values).toEqual([99]);

    await expect(store.readText(stored.id, { blockIndex: 5 })).rejects.toBeInstanceOf(InvalidResultReadError);
  });

  /** Verifies extracting text lines by JSON pointer from structuredContent or JSON text source. */
  it("retrieves complete lines from a nested text path via JSON pointer", async () => {
    const store = createStore();
    const result: CallToolResult = {
      content: [{ type: "text", text: "ignored block" }],
      structuredContent: {
        service: "api",
        stacktrace: "Error: failure\n  at run (app.js:10)\n  at main (app.js:20)",
      },
    };
    const stored = await store.materialize(result);

    const textView = await store.readText(stored.id, { pointer: "/stacktrace" });
    expect(textView.lines).toEqual([
      "Error: failure\n",
      "  at run (app.js:10)\n",
      "  at main (app.js:20)",
    ]);
    expect(textView.totalLines).toBe(3);

    await expect(store.readText(stored.id, { pointer: "/service" })).resolves.toBeDefined();
    await expect(store.readText(stored.id, { pointer: "/nonexistent" })).rejects.toBeInstanceOf(InvalidResultReadError);
  });

  /** Verifies JSON object root provides bounded field summary rather than one collapsed value. */
  it("provides bounded field summary for oversized JSON object root", async () => {
    const store = createStore();
    const largeText = "x".repeat(300);
    const result: CallToolResult = {
      content: [],
      structuredContent: {
        name: "sloth",
        active: true,
        summary: largeText,
        metadata: { tag: "prod" },
      },
    };
    const stored = await store.materialize(result);

    const view = await store.readJson(stored.id, { maxValueBytes: 100 });
    expect(view.values).toHaveLength(1);
    const rootSummary = view.values[0] as Record<string, unknown>;
    expect(rootSummary.name).toBe("sloth");
    expect(rootSummary.active).toBe(true);
    expect(rootSummary.summary).toMatchObject({
      omitted: true,
      type: "string",
      bytes: expect.any(Number),
      guidance: expect.stringContaining("pointer"),
    });
  });

  /** Verifies auto-view inspection logic and recommendations. */
  it("recommends appropriate view and source across diverse result shapes", async () => {
    const store = createStore();

    const withStructured: CallToolResult = {
      content: [{ type: "text", text: "preview" }],
      structuredContent: { ok: true },
    };
    expect(recommendResultView(withStructured)).toMatchObject({ recommendedView: "json", source: "structured" });
    const storedStruct = await store.materialize(withStructured);
    expect(await store.inspect(storedStruct.id)).toMatchObject({ recommendedView: "json", source: "structured" });

    const withJsonText: CallToolResult = {
      content: [{ type: "text", text: '{"key": "value"}' }],
    };
    expect(recommendResultView(withJsonText)).toMatchObject({ recommendedView: "json", source: 0, blockIndex: 0 });

    const withPlainText: CallToolResult = {
      content: [{ type: "text", text: "plain log line 1\nline 2" }],
    };
    expect(recommendResultView(withPlainText)).toMatchObject({ recommendedView: "text", source: 0, blockIndex: 0 });

    const withMultipleBlocks: CallToolResult = {
      content: [
        { type: "text", text: "block 1" },
        { type: "text", text: "block 2" },
      ],
    };
    expect(recommendResultView(withMultipleBlocks)).toMatchObject({ recommendedView: "envelope", source: "root" });

    const withImageOnly: CallToolResult = {
      content: [{ type: "image", data: "abcd", mimeType: "image/png" }],
    };
    expect(recommendResultView(withImageOnly)).toMatchObject({ recommendedView: "envelope", source: "root" });
  });

  /** Verifies text pagination keeps terminators and requires selector when multiple text blocks exist. */
  it("reads complete text lines and enforces blockIndex when multiple text blocks exist", async () => {
    const store = createStore();
    const stored = await store.materialize(representativeResult());

    const firstPage = await store.readText(stored.id, 0, 2);
    expect(firstPage.lines).toEqual(["first 😀 line\n", "second line\n"]);
    expect(firstPage.nextOffset).toBe(2);
    expect((await store.readText(stored.id, 2, 2)).lines).toEqual(["third"]);

    const multiTextBlockStore = await store.materialize({
      content: [
        { type: "text", text: "text a" },
        { type: "text", text: "text b" },
      ],
    });
    await expect(multiTextBlockStore ? store.readText(multiTextBlockStore.id) : Promise.reject()).rejects.toBeInstanceOf(
      InvalidResultReadError,
    );
  });

  /** Verifies envelope metadata is bounded and describes stored structure. */
  it("returns structural envelope metadata", async () => {
    const store = createStore();
    const stored = await store.materialize(representativeResult());
    const envelope = await store.readEnvelope(stored.id);

    expect(envelope).toMatchObject({
      id: stored.id,
      bytes: stored.bytes,
      contentBlocks: 3,
      hasStructuredContent: true,
      hasMeta: true,
    });
    expect(envelope.contentTypes).toEqual(["text", "image", "resource_link"]);
  });

  /** Verifies malformed, traversal, missing, and expired IDs use stable errors. */
  it("rejects invalid, missing, and expired IDs", async () => {
    let now = 10_000;
    const store = createStore({ ttlMs: TEST_TTL_MS, now: () => now });
    const stored = await store.materialize(representativeResult());

    await expect(store.readEnvelope("../../etc/passwd")).rejects.toBeInstanceOf(InvalidResultIdError);
    await expect(store.readEnvelope("00000000-0000-4000-8000-000000000000")).rejects.toBeInstanceOf(
      ResultNotFoundError,
    );
    now += TEST_TTL_MS;
    await expect(store.readEnvelope(stored.id)).rejects.toBeInstanceOf(ResultExpiredError);
  });

  /** Verifies per-entry, count, and aggregate quotas evict oldest complete entries. */
  it("enforces entry, aggregate, and count quotas", async () => {
    let now = 1;
    const sample = { content: [{ type: "text", text: "1234567890" }] } as CallToolResult;
    const bytes = measureCallToolResult(sample);
    const store = createStore({ maxEntryBytes: bytes, maxTotalBytes: bytes * 2, maxEntries: 2, now: () => now++ });
    const first = await store.materialize(sample);
    await store.materialize(sample);
    const third = await store.materialize(sample);

    await expect(store.readEnvelope(first.id)).rejects.toBeInstanceOf(ResultNotFoundError);
    expect((await store.readEnvelope(third.id)).id).toBe(third.id);
    await expect(
      store.materialize({ content: [{ type: "text", text: "x".repeat(bytes) }] } as CallToolResult),
    ).rejects.toBeInstanceOf(ResultTooLargeError);
  });

  /** Verifies concurrent materialization obeys count quota without partial files. */
  it("serializes concurrent writes and retains only configured entry count", async () => {
    const store = createStore({ maxEntries: 3, maxEntryBytes: 1_024, maxTotalBytes: 3_072 });
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        store.materialize({ content: [{ type: "text", text: `result-${index}` }] } as CallToolResult),
      ),
    );

    const names = await readdir(store.directory);
    expect(names).toHaveLength(3);
    expect(names.every((name) => /^[0-9a-f-]{36}$/u.test(name))).toBe(true);
  });

  /** Verifies abandoned temporary directories are never exposed and are cleaned on next mutation. */
  it("cleans abandoned temporary entries", async () => {
    const store = createStore();
    await store.materialize(representativeResult());
    const temporary = join(store.directory, ".abandoned.tmp");
    await mkdir(temporary);
    await writeFile(join(temporary, "result.json"), "partial");

    await store.materialize(representativeResult());
    await expect(access(temporary)).rejects.toThrow();
  });

  /** Verifies close removes instance state and blocks later use. */
  it("cleans its isolated instance directory on close", async () => {
    const store = createStore();
    await store.materialize(representativeResult());
    await store.close();

    await expect(access(store.directory)).rejects.toThrow();
    await expect(store.materialize(representativeResult())).rejects.toMatchObject({ code: "CLOSED" });
  });
});
