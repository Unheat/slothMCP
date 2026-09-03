import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessPool, StderrRingBuffer } from "../src/pool.js";

describe("ProcessPool & StderrRingBuffer", () => {
  const mockServerScript = join(__dirname, "mock-server.ts");
  let pool: ProcessPool;

  beforeEach(() => {
    pool = new ProcessPool({ idleTimeoutMs: 500 });
    pool.updateServerConfigs({
      mock: {
        command: "npx",
        args: ["tsx", mockServerScript],
        disabled: false,
        tags: [],
      },
      disabledMock: {
        command: "npx",
        args: ["tsx", mockServerScript],
        disabled: true,
        tags: [],
      },
    });
  });

  afterEach(async () => {
    if (pool) {
      await pool.stopAll();
    }
  });

  it("manages stderr ring buffer capacity properly", () => {
    const buffer = new StderrRingBuffer(3);
    buffer.push("line 1");
    buffer.push("line 2");
    buffer.push("line 3");
    buffer.push("line 4");

    expect(buffer.getLines()).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("starts in dormant state with 0 active child processes", () => {
    expect(pool.activeCount).toBe(0);
    expect(pool.isRunning("mock")).toBe(false);
  });

  it("refuses to acquire disabled or unregistered servers", async () => {
    await expect(pool.acquire("nonexistent")).rejects.toThrow("not registered");
    await expect(pool.acquire("disabledMock")).rejects.toThrow("disabled");
  });

  it("spawns lazily on-demand and executes tool calls successfully", async () => {
    expect(pool.activeCount).toBe(0);

    const result = (await pool.executeTool("mock", "echo", { msg: "hello-sloth" })) as {
      content: Array<{ text: string }>;
    };

    expect(pool.activeCount).toBe(1);
    expect(pool.isRunning("mock")).toBe(true);
    expect(result.content[0].text).toBe("echo:hello-sloth");
  });

  it("deduplicates parallel calls with single-flight initialization lock", async () => {
    expect(pool.activeCount).toBe(0);

    // Call 5 requests in parallel simultaneously while server is dormant
    const promises = Array.from({ length: 5 }, (_, i) =>
      pool.executeTool("mock", "echo", { msg: `req-${i}` })
    );

    const results = (await Promise.all(promises)) as Array<{
      content: Array<{ text: string }>;
    }>;

    expect(results).toHaveLength(5);
    expect(pool.activeCount).toBe(1); // exactly 1 process spawned

    for (let i = 0; i < 5; i++) {
      expect(results[i].content[0].text).toBe(`echo:req-${i}`);
    }
  });

  it("introspects tools and stops temporary process when requested", async () => {
    const tools = (await pool.introspectTools("mock", true)) as Array<{ name: string }>;
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0].name).toBe("echo");

    // Process should be stopped immediately
    expect(pool.isRunning("mock")).toBe(false);
    expect(pool.activeCount).toBe(0);
  });
});
