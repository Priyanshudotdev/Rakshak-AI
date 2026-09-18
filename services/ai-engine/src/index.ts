import { log } from "@rakshak/logger";

export * from "./pipeline.js";
export * from "./priority.js";
export * from "./fallback.js";
export * from "./correlate.js";
export * from "./geocode.js";
export * from "./embeddings.js";
export * as sarvam from "./sarvam.js";
export * as llm from "./llm.js";

// Library entry — apps/api imports processText/processAudio from here.
// No autonomous dispatch: outputs are structured + validated by callers.
log("debug", "ai-engine loaded");
