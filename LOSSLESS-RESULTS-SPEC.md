# Lossless Large Results Specification

## Goal

SlothMCP must preserve downstream `CallToolResult` semantics while keeping oversized results out of the agent context until requested. Small results pass through unchanged. Oversized results execute once, are stored atomically, and return a valid preview plus an opaque identifier. `read_result` provides JSON-value, text-line, envelope, and exact raw retrieval views.

## Required behavior

- Measure the UTF-8 serialization of the complete downstream result.
- Return results at or below `resultInlineMaxBytes` (30 KiB) unchanged.
- Store complete oversized results before returning a handle.
- Return high-signal bounded previews: line-based head + tail sandwich for text (preserving headers, errors, and bottom summaries without breaking lines), high-signal samples or tabular CSV for JSON, and block manifest + primary text preview for envelopes.
- Preserve ordered content blocks, `structuredContent`, `isError`, `_meta`, annotations, resources, images, audio, and compatible extension fields.
- Never slice JSON and present the fragment as complete JSON.
- JSON view returns complete values selected by RFC 6901 JSON Pointer.
- Text view returns complete lines.
- Envelope view reports bounded structural metadata.
- Raw view returns UTF-8-safe fragments that reassemble to the exact stored serialization.
- Retrieval never invokes the downstream tool again.
- Storage uses opaque IDs, atomic writes, TTL, entry/byte quotas, owner-only permissions, and instance isolation.

## Defaults

- Inline result: 30 KiB (`resultInlineMaxBytes: 30720`).
- Preview: 12 KiB (`DEFAULT_PREVIEW_MAX_BYTES: 12288`), using line-based head (30%) + tail (70%) sandwich slicing for text and high-signal sample records or tabular CSV for JSON.
- Raw page: 24 KiB default, 30 KiB maximum.
- JSON page: 20 values default, 100 maximum.
- Text page: 200 lines default, 500 maximum.
- TTL: 2 hours (`resultTtlMs: 7200000`).
- Single result: 64 MiB maximum (`resultMaxEntryBytes: 67108864`).
- Instance aggregate: 256 MiB maximum (`resultMaxTotalBytes: 268435456`).
- Instance entries: 128 maximum (`DEFAULT_MAX_ENTRIES: 128`).

## Failure behavior

- Materialization failure returns a bounded `isError: true` result without a handle.
- Invalid, missing, expired, or inaccessible IDs return stable errors without filesystem disclosure.
- Large individual JSON values or text lines return metadata and deeper/raw retrieval guidance rather than sliced content.

## Donor code provenance

| Local symbol | Reuse type | Exact donor location | Deliberate changes |
| --- | --- | --- | --- |
| `src.server.execute_tool` envelope forwarding | adapted | `reference/mcpproxy-go/internal/server/content_forward.go:39-138`, `forwardContentResult` | Preserve the complete `CallToolResult`; return small results unchanged and materialize the full envelope when oversized. |
| `src.result-store.ResultStore` lifecycle | adapted | `reference/mcpproxy-go/internal/cache/manager.go:17-22,108-190`, cache manager lifecycle | Use Node filesystem storage, instance isolation, atomic files, and bounded quotas instead of bbolt. |
| `src.result-store.ResultStore.readJson` and retrieval views | adapted | `reference/mcpproxy-go/internal/cache/manager.go:192-242`, `GetRecords` | Support caller-selected JSON Pointer, text, envelope, and exact raw views; never guess one primary array as the only recovery path. |
| `src.server.read_result` | adapted | `reference/mcpproxy-go/internal/server/mcp.go:1105-1123`, `read_cache` registration | Expose one strict retrieval tool with explicit views and hard output limits. |

## Acceptance criteria

- Small result deep-equals the downstream result.
- Oversized result is completely recoverable without re-execution.
- JSON responses remain valid and JSON pages contain complete values.
- Raw pages preserve Unicode and verify against SHA-256.
- Storage is atomic, expiring, bounded, and path-safe.
- Full build, tests, benchmarks, and a real Sloth smoke test pass before merge.
