# SlothMCP Benchmark Methodology & Evaluation Results

This document details the automated benchmark methodology, test fixtures, mathematical proofs, and empirical latency distributions measured in `test/benchmark.test.ts`.

---

## 1. Benchmark Corpus & Fixtures

The benchmark corpus simulates a real-world enterprise development environment containing **32 tools** across **12 downstream servers**:

| Server Domain | Tool Count | Sample Tools Included |
| :--- | :---: | :--- |
| **docker** | 4 | `ps`, `logs`, `restart`, `exec` |
| **postgres** | 3 | `query`, `inspect_tables`, `run_migration` |
| **github** | 3 | `create_pull_request`, `list_issues`, `get_file_contents` |
| **aws** | 4 | `s3_get_object`, `s3_put_object`, `ec2_describe_instances`, `cloudwatch_get_metrics` |
| **kubernetes**| 3 | `get_pods`, `get_logs`, `restart_deployment` |
| **filesystem**| 3 | `read_file`, `write_file`, `list_directory` |
| **codebase** | 2 | `find_symbol`, `text_search` |
| **redis** | 3 | `get`, `set`, `flush_db` |
| **sentry** | 2 | `list_issues`, `get_issue_details` |
| **linear** | 2 | `create_issue`, `search_issues` |
| **jira** | 2 | `create_ticket`, `search_issues` |
| **slack** | 1 | `post_message` |

---

## 2. Input Token Efficiency Benchmark

Measured using `js-tiktoken` and the official OpenAI/Anthropic BPE tokenizer `cl100k_base`.

### A. Static Declaration Baseline (Direct MCP Setup)
In a standard IDE setup, every tool schema is declared in full JSONSchema format on every conversation turn:
- **Average Schema Size**: ~110 tokens per tool.
- **Single Turn Schema Dump (32 tools)**: **3,613 tokens / turn**.
- **10-Turn Conversation Total**: $10 \times 3,613 = \mathbf{36,130\text{ tokens}}$.

### B. SlothMCP Dynamic Meta-Tool Architecture
SlothMCP exposes only the 3 meta-tools and the 40-token directory tree:
- **Fixed Meta-Tools + Taxonomy**: **521 tokens / turn**.
- **10 Turns of Fixed Meta-Tools**: $10 \times 521 = 5,210\text{ tokens}$.
- **2 Tool Discovery Lookups**: The model invokes `search_tools` twice, each returning 3 compact 1-line TypeScript signatures: $2 \times 67 = 134\text{ tokens}$.
- **10-Turn SlothMCP Total**: $5,210 + 134 = \mathbf{5,344\text{ tokens}}$.

### C. Net Token Savings Calculation
$$\text{Net Token Savings} = \frac{36,130 - 5,344}{36,130} \times 100 = \mathbf{85.21\%}$$

Across an average 10-turn conversation, SlothMCP eliminates **30,786 wasted prompt tokens**.

---

## 3. MiniSearch BM25 Latency Benchmark

Measured by executing **1,000 search queries** over the indexed tool corpus on an Apple M-series processor using `performance.now()` high-resolution timers:

| Percentile | Latency (µs) | Latency (ms) | Target Ceiling |
| :--- | :---: | :---: | :---: |
| **P50 (Median)** | **56 µs** | 0.056 ms | $< 1.0\text{ ms}$ |
| **P95** | **267 µs** | 0.267 ms | $< 1.0\text{ ms}$ |
| **P99** | **888 µs** | 0.888 ms | $< 5.0\text{ ms}$ |

**Conclusion:** In-memory MiniSearch BM25 search overhead is imperceptible to users and models, completing in less than one-third of a single millisecond at P95.

---

## 4. Retrieval Precision@3 Benchmark

Evaluated across 12 diverse natural-language developer intent queries to verify that BM25 field boosting (`name: 5.0`, `params: 2.0`, `description: 1.5`) reliably ranks the target tool in the top 3 candidates:

| Test Query | Target Tool ID | Rank in Results |
| :--- | :--- | :---: |
| `"restart container"` | `docker:restart` | 1 |
| `"docker logs"` | `docker:logs` | 1 |
| `"run command in container"` | `docker:exec` | 1 |
| `"sql query database"` | `postgres:query` | 1 |
| `"database table columns"` | `postgres:inspect_tables` | 1 |
| `"run database migration"` | `postgres:run_migration` | 1 |
| `"create github pull request"` | `github:create_pull_request` | 1 |
| `"list open issues"` | `github:list_issues` | 1 |
| `"read file contents github"` | `github:get_file_contents` | 1 |
| `"send slack channel message"` | `slack:post_message` | 1 |
| `"find function symbol"` | `codebase:find_symbol` | 1 |
| `"regex text search in code"` | `codebase:text_search` | 1 |

**Precision@3 Score:** **`100.00% (12/12 correct)`**.

---

## 5. Memory Footprint & Lifecycle Benchmark

Measured in `test/pool.test.ts`:
- **Cold Boot Resident Set Size (RSS)**: Starts with 0 child processes running, consuming **~18 MB RAM** (standard base Node.js process).
- **Concurrency Single-Flight Test**: 5 simultaneous calls to a dormant server resulted in exactly **1 child process** being spawned.
- **Inactivity Auto-Reap**: Once active calls finish and the inactivity timer expires, the child process is terminated via `SIGTERM`, returning gateway memory back to the baseline ~18 MB footprint.
