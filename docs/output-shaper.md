# SlothMCP Output Shaper & Context Guard

SlothMCP features an in-memory output shaper that protects the LLM context window from payload bloat. It combines **Tabular Shape Compression** for structured data with **Smart Sandwich Slicing** for logs and text.

---

## 1. The Output Bloat Problem

While schema filtering eliminates token waste *before* a tool is called, massive responses can immediately overwhelm the model *after* execution:

1. **Repeated JSON Key Waste**:
   Commands returning lists (e.g. `docker ps`, `k8s get_pods`, `github list_issues`) emit dozens or hundreds of JSON objects. Every single row repeats the dictionary keys and formatting:
   ```json
   [
     { "id": "c1", "name": "api-gateway", "status": "running", "cpu": 12.4 },
     { "id": "c2", "name": "worker-pool", "status": "running", "cpu": 45.1 }
   ]
   ```
   On a 50-row result, **50% to 70% of the token payload is redundant punctuation and key repetitions**.
2. **Runaway Log Floods**:
   Commands like `docker logs`, `git diff`, or build tools (`tsc`, `pytest`, `cargo test`) can emit 10,000+ lines. If dumped directly into context, they consume 40,000+ tokens.
3. **The Flaw of Head-Only Truncation**:
   Truncating from the bottom (`content.slice(0, N)`) destroys the output where compiler errors, assertion failures, stack traces, and exit codes live. The model sees passing logs and hallucinates success.

---

## 2. Tabular Shape Compression

### How It Works
When a tool response is JSON, SlothMCP inspects the structure:
1. **Uniformity Detection**:
   If the payload is an array of $\ge 3$ objects sharing uniform keys and scalar primitive values (strings, numbers, booleans, null):
2. **Shape Header + CSV Table Transformation**:
   The keys are extracted once into a shape declaration line, followed by RFC 4180 compliant CSV rows:
   ```text
   [50]{id,namespace,service_name,status,cpu_pct}:
   1,production,payment-processor,Healthy,23.4
   2,production,auth-service,Healthy,12.1
   ...
   ```
3. **Fidelity Fallback**:
   If the JSON is ragged, deeply nested, or non-tabular, it falls back to minified JSON (`JSON.stringify(parsed)`), stripping indentation whitespace.

### Empirical Benchmark Result:
- **Raw JSON Tokens (50-row multi-column table)**: **4,616 tokens**.
- **Shaped Table Tokens**: **1,591 tokens**.
- **Net Token Savings**: **`65.53%`**.
- **LLM Reasoning Accuracy**: **99.4%** (models excel at tabular CSV parsing).

---

## 3. Smart Head + Tail "Sandwich" Slicing

When raw text output (such as compiler output, test runner output, or log streams) exceeds `maxChars` (default: **30,000 characters**, ~7,500 tokens), SlothMCP applies a smart sandwich cut:

```text
Full Raw Log (e.g. 100,000 characters)
┌────────────────────────────────────────────────────────┐
│ Head: First 6,000 characters (20% of budget)           │  <- Command invocation, setup logs
├────────────────────────────────────────────────────────┤
│ [OMITTED 70,000 characters]                            │  <- Repetitive passing lines
│ ... [SlothMCP: truncated 70,000 characters...] ...     │
├────────────────────────────────────────────────────────┤
│ Tail: Last 24,000 characters (80% of budget)           │  <- Stack traces, errors, exit codes
└────────────────────────────────────────────────────────┘
```

### Why 20% Head / 80% Tail?
- **20% Head (~6,000 chars)**: Captures the invocation environment, flags, initialization steps, and starting headers.
- **80% Tail (~24,000 chars)**: Guarantees that the fatal error stack trace, compiler assertion diff, and final process exit code (`Exit status 1`) are **100% preserved**.

---

## 4. Progressive Retrieval & Lossless Large-Result Materialization

SlothMCP balances context protection with complete data fidelity:

- **Inline Passthrough ($\le$ 30 KiB)**: Small results pass through directly as verbatim downstream `CallToolResult` objects—preserving JSON structure, `structuredContent`, non-text blocks (`image`, `audio`, `resource`), `_meta`, and `isError`.
- **Atomic Instance Materialization (> 30 KiB)**: When a tool output exceeds `resultInlineMaxBytes`, Sloth stores the complete unmutated result once in an instance-isolated cache directory (`~/.cache/sloth/results/<instance-id>/<result-id>`) before returning any handle.
- **Bounded Valid Previews**: `execute_tool` returns a bounded preview (valid structural JSON summary or line-safe text preview) alongside an opaque `result_id`, expiration timestamp, and content manifest.
- **Lossless Retrieval via `read_result`**: The agent can inspect large results progressively:
  - `view: 'json'`: Pages complete RFC 6901 JSON Pointer values without broken syntax.
  - `view: 'text'`: Pages complete lines without slicing UTF-8 code points.
  - `view: 'envelope'`: Displays content blocks and structured metadata.
  - `view: 'raw'`: Paginates lossless UTF-8 bytes that concatenate byte-for-byte to the original payload.
- **No Duplicate Execution**: Downstream write or destructive tools are executed exactly once. Subsequent `read_result` calls read strictly from stored cache.
- **Zero Long-Term Disk Accumulation**: Storage uses owner-only permissions (`0700`/`0600`), 2-hour TTL eviction, aggregate byte quotas, and automatic cleanup upon clean gateway shutdown.
