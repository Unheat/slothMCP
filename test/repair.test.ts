import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { repairToolArguments } from "../src/server.js";

describe("Argument Auto-Repair & System Diagnostics", () => {
  const sampleSchema = {
    type: "object",
    properties: {
      container: { type: "string" },
      timeout: { type: "number" },
      force: { type: "boolean" },
    },
    required: ["container"],
  };

  it("fuzzy-matches and remaps parameter keys", () => {
    const provided = {
      container_name: "web-api",
      timeout: "30",
      force: "true",
    };

    const { repaired, remappedKeys } = repairToolArguments(provided, sampleSchema);

    expect(remappedKeys).toHaveProperty("container_name", "container");
    expect(repaired).toHaveProperty("container", "web-api");
    expect(repaired).not.toHaveProperty("container_name");

    // Coerced types
    expect(repaired.timeout).toBe(30);
    expect(typeof repaired.timeout).toBe("number");

    expect(repaired.force).toBe(true);
    expect(typeof repaired.force).toBe("boolean");
  });

  it("handles camelCase and hyphenated keys gracefully", () => {
    const provided = {
      containerId: "redis-cache",
    };

    const { repaired, remappedKeys } = repairToolArguments(provided, sampleSchema);

    expect(remappedKeys).toHaveProperty("containerId", "container");
    expect(repaired.container).toBe("redis-cache");
  });

  it("leaves already valid arguments intact", () => {
    const provided = {
      container: "my-container",
      timeout: 10,
      force: false,
    };

    const { repaired, remappedKeys } = repairToolArguments(provided, sampleSchema);

    expect(remappedKeys).toEqual({});
    expect(repaired).toEqual(provided);
  });

  it("runs system doctor diagnostics without throwing", () => {
    const checks = runDoctor();

    expect(Array.isArray(checks)).toBe(true);
    expect(checks.length).toBeGreaterThanOrEqual(4);

    const nodeCheck = checks.find((c) => c.name === "Node.js Runtime");
    expect(nodeCheck).toBeDefined();
    expect(nodeCheck?.status).toBe("ok");

    const configCheck = checks.find((c) => c.name === "Config Directory");
    expect(configCheck).toBeDefined();
  });
});
