import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import {
  escapeCsvField,
  isUniformObjectArray,
  sandwichSlice,
  shapeToolOutput,
  tabularizeJsonArray,
} from "../src/shaper.js";

describe("Output Shaper & Context Guard", () => {
  const enc = getEncoding("cl100k_base");

  it("escapes CSV fields following RFC 4180", () => {
    expect(escapeCsvField("simple")).toBe("simple");
    expect(escapeCsvField("has,comma")).toBe('"has,comma"');
    expect(escapeCsvField('has"quote')).toBe('"has""quote"');
    expect(escapeCsvField("has\nnewline")).toBe('"has\nnewline"');
    expect(escapeCsvField(123)).toBe("123");
    expect(escapeCsvField(true)).toBe("true");
    expect(escapeCsvField(null)).toBe("");
  });

  it("identifies uniform object arrays for tabularization", () => {
    const uniform = [
      { id: "c1", name: "web", status: "running" },
      { id: "c2", name: "db", status: "running" },
      { id: "c3", name: "cache", status: "stopped" },
    ];
    expect(isUniformObjectArray(uniform)).toBe(true);

    // Too few elements (< 3)
    expect(isUniformObjectArray([{ a: 1 }, { a: 2 }])).toBe(false);

    // Primitive array
    expect(isUniformObjectArray(["a", "b", "c"])).toBe(false);

    // Non-uniform keys
    const nonUniform = [
      { id: "c1", name: "web" },
      { id: "c2", differentKey: "val" },
      { id: "c3", name: "cache" },
    ];
    expect(isUniformObjectArray(nonUniform)).toBe(false);

    // Deep nested objects (not flat)
    const nested = [
      { id: "c1", details: { deep: true } },
      { id: "c2", details: { deep: false } },
      { id: "c3", details: { deep: true } },
    ];
    expect(isUniformObjectArray(nested)).toBe(false);
  });

  it("tabularizes uniform arrays with typed shape header", () => {
    const data = [
      { id: "a1", name: "api-server", port: 8080, active: true },
      { id: "b2", name: "worker-pool", port: 0, active: false },
      { id: "c3", name: "cache-redis", port: 6379, active: true },
    ];

    const result = tabularizeJsonArray(data);
    const lines = result.split("\n");

    expect(lines[0]).toBe("[3]{id,name,port,active}:");
    expect(lines[1]).toBe("a1,api-server,8080,true");
    expect(lines[2]).toBe("b2,worker-pool,0,false");
    expect(lines[3]).toBe("c3,cache-redis,6379,true");
  });

  it("preserves small content untouched and applies sandwich slicing to oversized logs", () => {
    const shortText = "Normal short tool output";
    expect(sandwichSlice(shortText, 1000)).toBe(shortText);

    // Construct 50KB log with critical compiler error at the tail
    const headPart = "Compiling project v1.0.0...\n" + "Info: loading module A...\n".repeat(200);
    const middlePart = "Info: passing test case step...\n".repeat(1500);
    const tailPart = "FAIL src/server.ts:42 - SyntaxError: Unexpected token\nProcess exited with status 1";

    const hugeLog = `${headPart}${middlePart}${tailPart}`;
    expect(hugeLog.length).toBeGreaterThan(40_000);

    // Apply sandwich slicing with budget = 5,000 chars (20% head = 1,000 chars / 80% tail = 4,000 chars)
    const sliced = sandwichSlice(hugeLog, 5_000, 0.2);

    expect(sliced.length).toBeLessThanOrEqual(5_500); // within budget + banner
    expect(sliced).toContain("Compiling project v1.0.0"); // head preserved!
    expect(sliced).toContain("... [SlothMCP: truncated"); // banner present!
    expect(sliced).toContain("FAIL src/server.ts:42 - SyntaxError"); // tail preserved!
    expect(sliced).toContain("Process exited with status 1"); // exit code preserved!
  });

  it("proves >= 50% token reduction on realistic multi-column tabular tool output", () => {
    // Generate realistic 50-row database/Kubernetes status payload with typical column headers
    const records: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 50; i++) {
      records.push({
        id: i,
        namespace: "production-apps",
        service_name: `payment-processor-worker-${i}`,
        environment: "production",
        region: "us-east-1",
        status: i % 7 === 0 ? "Degraded" : "Healthy",
        restarts: i % 7 === 0 ? 3 : 0,
        cpu_usage_pct: 23.4,
        memory_usage_mb: 512,
        is_active: true,
      });
    }

    const rawJson = JSON.stringify(records, null, 2);
    const rawTokens = enc.encode(rawJson).length;

    const shaped = shapeToolOutput(rawJson);
    const shapedTokens = enc.encode(shaped).length;

    const savingsPct = ((rawTokens - shapedTokens) / rawTokens) * 100;

    console.log(`\n=== Multi-Column Tabular Shaping Benchmark ===`);
    console.log(`Raw JSON Tokens:     ${rawTokens} tokens`);
    console.log(`Shaped Table Tokens: ${shapedTokens} tokens`);
    console.log(`Net Output Savings:  ${savingsPct.toFixed(2)}%\n`);

    expect(shaped).toContain("[50]{id,namespace,service_name,environment,region,status,restarts,cpu_usage_pct,memory_usage_mb,is_active}:");
    expect(savingsPct).toBeGreaterThanOrEqual(50); // Proves >= 50% reduction on tabular records
  });

  it("reduces tokens on standard container lists and preserves structure", () => {
    const containers: Array<{ id: string; name: string; image: string; status: string; ports: string }> = [];
    for (let i = 1; i <= 30; i++) {
      containers.push({
        id: `cid-${i}`,
        name: `web-server-${i}`,
        image: "nginx:alpine",
        status: "running",
        ports: "80/tcp",
      });
    }

    const rawJson = JSON.stringify(containers, null, 2);
    const rawTokens = enc.encode(rawJson).length;

    const shaped = shapeToolOutput(rawJson);
    const shapedTokens = enc.encode(shaped).length;

    const savingsPct = ((rawTokens - shapedTokens) / rawTokens) * 100;
    expect(savingsPct).toBeGreaterThan(30);
    expect(shaped).toContain("[30]{id,name,image,status,ports}:");
  });
});
