import { config } from "@rakshak/config";
import { log } from "@rakshak/logger";
import { createApp } from "./app.js";
import { stores } from "./stores.js";

// Thin bootstrap: all routes live in app.ts behind createApp(store) so vitest
// can inject file / pg-mem / failing backends. Production resolves the backend
// once at startup (postgres when DATABASE_URL works, else file) and listens.
//
// Readiness contract (dashboard header):
//   GET /api/health -> {status: ok|degraded, sarvam, gemini, store, db, migrations}
//     (store kept for backward compat; db = postgres|file|down)
//   GET /api/ready  -> {api: "up", db, migrations}
// Both never hang (2s DB probe cap); degraded (not 500) when DB down or
// migrations pending so the header can show "API up, DB down".

// Resolve once at startup: postgres when DATABASE_URL works, else file store.
const store = await stores();
const app = await createApp(store);

const port = config.port;
try {
  await app.listen({ port, host: "0.0.0.0" });
  log("info", `rakshak-api listening on :${port}`);
} catch (err) {
  log("error", "api failed to start", { err: String(err) });
  process.exit(1);
}
