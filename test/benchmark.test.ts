import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import type { ManifestData } from "../src/config.js";
import { buildTaxonomy, formatCompactSignature, ToolIndex } from "../src/indexer.js";

describe("SlothMCP Automated Benchmarking & Evaluation Suite", () => {
  const enc = getEncoding("cl100k_base");

  // Synthetic corpus: 40 realistic MCP tools across 5 common domains
  const realisticManifests: ManifestData[] = [
    {
      server: "docker",
      fingerprint: "docker-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "ps",
          description: "List all running and stopped docker containers with their status, ports, and names",
          inputSchema: {
            type: "object",
            properties: {
              all: { type: "boolean", description: "Show all containers including stopped ones" },
              filter: { type: "string", description: "Filter output based on conditions provided" },
            },
          },
        },
        {
          name: "logs",
          description: "Fetch stdout and stderr logs from a specified docker container",
          inputSchema: {
            type: "object",
            properties: {
              container: { type: "string", description: "Container name or ID" },
              tail: { type: "number", description: "Number of lines to show from the end of the logs" },
              follow: { type: "boolean", description: "Follow log output in real time" },
            },
            required: ["container"],
          },
        },
        {
          name: "restart",
          description: "Restart one or more running containers",
          inputSchema: {
            type: "object",
            properties: {
              container: { type: "string", description: "Container ID or name" },
              timeout: { type: "number", description: "Seconds to wait for stop before killing the container" },
            },
            required: ["container"],
          },
        },
        {
          name: "exec",
          description: "Run a command in a running container",
          inputSchema: {
            type: "object",
            properties: {
              container: { type: "string", description: "Container ID or name" },
              command: { type: "array", items: { type: "string" }, description: "Command and arguments to execute" },
            },
            required: ["container", "command"],
          },
        },
      ],
    },
    {
      server: "postgres",
      fingerprint: "pg-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "query",
          description: "Execute a read-only or mutating SQL query on the PostgreSQL database",
          inputSchema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "The SQL statement to execute" },
              parameters: { type: "array", items: { type: "string" }, description: "Positional query parameters" },
              transaction: { type: "boolean", description: "Execute inside a transaction block" },
            },
            required: ["sql"],
          },
        },
        {
          name: "inspect_tables",
          description: "List all database tables, columns, indexes, and primary key definitions",
          inputSchema: {
            type: "object",
            properties: {
              schema: { type: "string", description: "Database schema name (default: public)" },
            },
          },
        },
        {
          name: "run_migration",
          description: "Apply pending database schema migrations",
          inputSchema: {
            type: "object",
            properties: {
              target_version: { type: "string", description: "Target migration version tag" },
              dry_run: { type: "boolean", description: "Simulate migration without committing" },
            },
          },
        },
      ],
    },
    {
      server: "github",
      fingerprint: "gh-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "create_pull_request",
          description: "Open a new pull request in a GitHub repository",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string", description: "Repository owner username or organization" },
              repo: { type: "string", description: "Repository name" },
              title: { type: "string", description: "Title of the pull request" },
              body: { type: "string", description: "Markdown description body" },
              head: { type: "string", description: "Name of the branch where your changes are implemented" },
              base: { type: "string", description: "Name of the branch you want to merge into" },
            },
            required: ["owner", "repo", "title", "head", "base"],
          },
        },
        {
          name: "list_issues",
          description: "List issues in a repository with filtering options",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string", description: "Repository owner" },
              repo: { type: "string", description: "Repository name" },
              state: { type: "string", enum: ["open", "closed", "all"] },
              labels: { type: "array", items: { type: "string" } },
            },
            required: ["owner", "repo"],
          },
        },
        {
          name: "get_file_contents",
          description: "Fetch file contents from a specific Git ref or branch in a GitHub repository",
          inputSchema: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              path: { type: "string" },
              ref: { type: "string" },
            },
            required: ["owner", "repo", "path"],
          },
        },
      ],
    },
    {
      server: "slack",
      fingerprint: "slack-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "post_message",
          description: "Send a message to a Slack channel or user thread",
          inputSchema: {
            type: "object",
            properties: {
              channel_id: { type: "string", description: "Target channel ID or user ID" },
              text: { type: "string", description: "Text content of the message" },
              thread_ts: { type: "string", description: "Parent message timestamp for replying in thread" },
            },
            required: ["channel_id", "text"],
          },
        },
      ],
    },
    {
      server: "codebase",
      fingerprint: "code-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "find_symbol",
          description: "Search for class, function, interface, or variable symbol definitions in codebase",
          inputSchema: {
            type: "object",
            properties: {
              symbol: { type: "string", description: "Exact or fuzzy symbol identifier" },
              file_filter: { type: "string", description: "Glob pattern to narrow file paths" },
            },
            required: ["symbol"],
          },
        },
        {
          name: "text_search",
          description: "Full-text regex search across the source code tree",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Text pattern or regular expression" },
            },
            required: ["query"],
          },
        },
      ],
    },
    {
      server: "aws",
      fingerprint: "aws-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "s3_get_object",
          description: "Download an object from an Amazon S3 bucket",
          inputSchema: {
            type: "object",
            properties: {
              bucket: { type: "string", description: "Target bucket name" },
              key: { type: "string", description: "Object key path" },
            },
            required: ["bucket", "key"],
          },
        },
        {
          name: "s3_put_object",
          description: "Upload a file or object to an Amazon S3 bucket",
          inputSchema: {
            type: "object",
            properties: {
              bucket: { type: "string" },
              key: { type: "string" },
              body: { type: "string" },
            },
            required: ["bucket", "key", "body"],
          },
        },
        {
          name: "ec2_describe_instances",
          description: "Describe Amazon EC2 instances, state, tags, and IP addresses",
          inputSchema: {
            type: "object",
            properties: {
              instance_ids: { type: "array", items: { type: "string" } },
              filters: { type: "array", items: { type: "object" } },
            },
          },
        },
        {
          name: "cloudwatch_get_metrics",
          description: "Fetch CloudWatch metric statistics for CPU, Memory, or Network",
          inputSchema: {
            type: "object",
            properties: {
              namespace: { type: "string" },
              metric_name: { type: "string" },
              period: { type: "number" },
            },
            required: ["namespace", "metric_name"],
          },
        },
      ],
    },
    {
      server: "kubernetes",
      fingerprint: "k8s-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "get_pods",
          description: "List all Kubernetes pods in a namespace with container statuses and restart counts",
          inputSchema: {
            type: "object",
            properties: {
              namespace: { type: "string" },
              label_selector: { type: "string" },
            },
          },
        },
        {
          name: "get_logs",
          description: "Get container logs from a running or previous pod instance",
          inputSchema: {
            type: "object",
            properties: {
              pod_name: { type: "string" },
              namespace: { type: "string" },
              container: { type: "string" },
              tail_lines: { type: "number" },
            },
            required: ["pod_name"],
          },
        },
        {
          name: "restart_deployment",
          description: "Trigger a rolling restart of a Kubernetes deployment",
          inputSchema: {
            type: "object",
            properties: {
              deployment: { type: "string" },
              namespace: { type: "string" },
            },
            required: ["deployment"],
          },
        },
      ],
    },
    {
      server: "jira",
      fingerprint: "jira-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "create_ticket",
          description: "Create a new Jira issue ticket with project, summary, description, and issue type",
          inputSchema: {
            type: "object",
            properties: {
              project_key: { type: "string" },
              summary: { type: "string" },
              description: { type: "string" },
              issue_type: { type: "string" },
            },
            required: ["project_key", "summary"],
          },
        },
        {
          name: "search_issues",
          description: "Search Jira issues using JQL (Jira Query Language)",
          inputSchema: {
            type: "object",
            properties: {
              jql: { type: "string" },
              max_results: { type: "number" },
            },
            required: ["jql"],
          },
        },
      ],
    },
    {
      server: "filesystem",
      fingerprint: "fs-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "read_file",
          description: "Read contents of a local file from disk",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              offset: { type: "number" },
              limit: { type: "number" },
            },
            required: ["file_path"],
          },
        },
        {
          name: "write_file",
          description: "Write or overwrite content to a local file",
          inputSchema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
              content: { type: "string" },
            },
            required: ["file_path", "content"],
          },
        },
        {
          name: "list_directory",
          description: "List directory files and subdirectories with sizes and metadata",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string" },
              recursive: { type: "boolean" },
            },
            required: ["path"],
          },
        },
      ],
    },
    {
      server: "sentry",
      fingerprint: "sentry-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "list_issues",
          description: "List Sentry error issues and uncaught exceptions with frequency and event counts",
          inputSchema: {
            type: "object",
            properties: {
              project_slug: { type: "string" },
              query: { type: "string" },
              stats_period: { type: "string" },
            },
            required: ["project_slug"],
          },
        },
        {
          name: "get_issue_details",
          description: "Get stacktrace, tags, and breadcrumbs for a specific Sentry issue ID",
          inputSchema: {
            type: "object",
            properties: {
              issue_id: { type: "string" },
            },
            required: ["issue_id"],
          },
        },
      ],
    },
    {
      server: "redis",
      fingerprint: "redis-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "get",
          description: "Get value of key from Redis in-memory cache",
          inputSchema: {
            type: "object",
            properties: {
              key: { type: "string" },
            },
            required: ["key"],
          },
        },
        {
          name: "set",
          description: "Set key to hold string value with optional TTL expiration in seconds",
          inputSchema: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
              ex_seconds: { type: "number" },
            },
            required: ["key", "value"],
          },
        },
        {
          name: "flush_db",
          description: "Delete all keys from the currently selected database",
          inputSchema: {
            type: "object",
            properties: {
              async: { type: "boolean" },
            },
          },
        },
      ],
    },
    {
      server: "linear",
      fingerprint: "linear-fp",
      indexedAt: Date.now(),
      tools: [
        {
          name: "create_issue",
          description: "Create an issue in Linear project tracker",
          inputSchema: {
            type: "object",
            properties: {
              team_id: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
              priority: { type: "number" },
            },
            required: ["team_id", "title"],
          },
        },
        {
          name: "search_issues",
          description: "Search Linear issues by title, description, or assignee",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
            required: ["query"],
          },
        },
      ],
    },
  ];

  it("proves >= 85% token reduction across a multi-turn conversation", () => {
    // 1. Calculate Baseline Token Load (Static Tool Dump)
    const allToolsRaw: Array<{ name: string; description?: string; inputSchema?: unknown }> = [];
    for (const m of realisticManifests) {
      for (const t of m.tools) {
        allToolsRaw.push({
          name: `${m.server}_${t.name}`,
          description: t.description,
          inputSchema: t.inputSchema,
        });
      }
    }

    const staticSchemaJson = JSON.stringify(allToolsRaw, null, 2);
    const staticTurnTokens = enc.encode(staticSchemaJson).length;

    // 2. Calculate SlothMCP Fixed Meta-Tool Token Load
    const taxonomy = buildTaxonomy(realisticManifests);
    const metaTools = [
      {
        name: "search_tools",
        description: `${taxonomy}\n\nSearch and retrieve compact tool signatures.`,
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            namespace: { type: "string" },
            limit: { type: "number" },
          },
          required: ["query"],
        },
      },
      {
        name: "get_tool_schema",
        description: "Retrieve full JSONSchema for a specific tool.",
        inputSchema: {
          type: "object",
          properties: { server: { type: "string" }, tool: { type: "string" } },
          required: ["server", "tool"],
        },
      },
      {
        name: "execute_tool",
        description: "Execute a downstream tool lazily.",
        inputSchema: {
          type: "object",
          properties: {
            server: { type: "string" },
            tool: { type: "string" },
            arguments: { type: "object" },
          },
          required: ["server", "tool", "arguments"],
        },
      },
    ];

    const slothFixedTokens = enc.encode(JSON.stringify(metaTools, null, 2)).length;

    // Scenario: 10-turn conversation with 2 tool discovery lookups
    const totalTurns = 10;
    const staticTotalTokens = staticTurnTokens * totalTurns;

    // For Sloth: 10 turns of fixed meta-tools + 2 search discovery outputs (approx 3 compact tools each)
    const searchResultSample = [
      formatCompactSignature("docker", realisticManifests[0].tools[0]),
      formatCompactSignature("docker", realisticManifests[0].tools[1]),
      formatCompactSignature("docker", realisticManifests[0].tools[2]),
    ].join("\n");
    const searchOutputTokens = enc.encode(searchResultSample).length;

    const slothTotalTokens = slothFixedTokens * totalTurns + 2 * searchOutputTokens;

    const savingsPercent = ((staticTotalTokens - slothTotalTokens) / staticTotalTokens) * 100;

    console.log(`\n=== Token Efficiency Benchmark ===`);
    console.log(`Static Dump (Per Turn):   ${staticTurnTokens} tokens`);
    console.log(`SlothMCP (Per Turn):      ${slothFixedTokens} tokens`);
    console.log(`10-Turn Static Total:     ${staticTotalTokens} tokens`);
    console.log(`10-Turn SlothMCP Total:   ${slothTotalTokens} tokens`);
    console.log(`Net Token Savings:        ${savingsPercent.toFixed(2)}%\n`);

    expect(savingsPercent).toBeGreaterThanOrEqual(85);
  });

  it("proves P95 search latency is < 1ms across 1,000 queries", () => {
    const index = new ToolIndex();
    index.buildIndex(realisticManifests);

    const testQueries = [
      "restart docker container",
      "execute sql migration",
      "find symbol definition",
      "open pull request github",
      "post slack message",
      "container logs tail",
      "inspect table columns",
      "regex text search",
    ];

    const iterations = 1000;
    const latencies: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const q = testQueries[i % testQueries.length];
      const start = performance.now();
      index.search(q);
      const end = performance.now();
      latencies.push(end - start);
    }

    latencies.sort((a, b) => a - b);
    const p50 = latencies[Math.floor(iterations * 0.5)];
    const p95 = latencies[Math.floor(iterations * 0.95)];
    const p99 = latencies[Math.floor(iterations * 0.99)];

    console.log(`=== MiniSearch BM25 Latency Benchmark (${iterations} runs) ===`);
    console.log(`P50 Latency: ${(p50 * 1000).toFixed(2)} µs (${p50.toFixed(4)} ms)`);
    console.log(`P95 Latency: ${(p95 * 1000).toFixed(2)} µs (${p95.toFixed(4)} ms)`);
    console.log(`P99 Latency: ${(p99 * 1000).toFixed(2)} µs (${p99.toFixed(4)} ms)\n`);

    expect(p95).toBeLessThan(1.0); // Sub-1ms P95 latency
  });

  it("achieves >= 90% Precision@3 on standard developer queries", () => {
    const index = new ToolIndex();
    index.buildIndex(realisticManifests, {
      docker: ["container", "devops"],
      postgres: ["database", "sql"],
      github: ["git", "vcs"],
      slack: ["chat", "notifications"],
      codebase: ["search", "ast"],
    });

    const testCases: Array<{ query: string; expectedTopId: string }> = [
      { query: "restart container", expectedTopId: "docker:restart" },
      { query: "docker logs", expectedTopId: "docker:logs" },
      { query: "run command in container", expectedTopId: "docker:exec" },
      { query: "sql query database", expectedTopId: "postgres:query" },
      { query: "database table columns", expectedTopId: "postgres:inspect_tables" },
      { query: "run database migration", expectedTopId: "postgres:run_migration" },
      { query: "create github pull request", expectedTopId: "github:create_pull_request" },
      { query: "list open issues", expectedTopId: "github:list_issues" },
      { query: "read file contents github", expectedTopId: "github:get_file_contents" },
      { query: "send slack channel message", expectedTopId: "slack:post_message" },
      { query: "find function symbol", expectedTopId: "codebase:find_symbol" },
      { query: "regex text search in code", expectedTopId: "codebase:text_search" },
    ];

    let hits = 0;

    for (const { query, expectedTopId } of testCases) {
      const results = index.search(query, { limit: 3 });
      const foundInTop3 = results.some((r) => r.id === expectedTopId);
      if (foundInTop3) {
        hits++;
      } else {
        console.warn(`Precision Miss for query: "${query}". Expected "${expectedTopId}", got:`, results.map((r) => r.id));
      }
    }

    const precision = (hits / testCases.length) * 100;
    console.log(`=== Retrieval Recall & Precision Benchmark ===`);
    console.log(`Precision@3: ${precision.toFixed(2)}% (${hits}/${testCases.length} correct)\n`);

    expect(precision).toBeGreaterThanOrEqual(90);
  });
});
