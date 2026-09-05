import { createSlothServer } from "./server.js";

export * from "./config.js";
export * from "./doctor.js";
export * from "./harnesses.js";
export * from "./indexer.js";
export * from "./pool.js";
export * from "./server.js";
export * from "./shaper.js";

// If executed directly as main module, start stdio server
const isMain = process.argv[1] && (process.argv[1].endsWith("index.ts") || process.argv[1].endsWith("index.js"));
if (isMain) {
  const sloth = createSlothServer();
  await sloth.start();
}
