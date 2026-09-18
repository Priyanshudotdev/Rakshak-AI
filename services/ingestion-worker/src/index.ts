import { collectReports } from "./sources.js";
import { enqueue, shutdown, startWorkers } from "./queue.js";
import { registerPipeline } from "./pipeline.js";

// Ingestion Worker (spec §17, Phase 5): news/RSS/official/citizen sources
// feed the SAME incident engine via correlation + verification. Latency-safe:
// this path is fully async — never on the live audio/STT critical path.

const POLL_MS = Math.max(15_000, Number(process.env.POLL_MS ?? 300_000));
const RUN_ONCE = (process.env.RUN_ONCE ?? "") === "1";

function log(level: string, msg: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level, msg, at: new Date().toISOString(), ...fields }));
}

async function pollOnce(): Promise<number> {
  const reports = await collectReports();
  for (const report of reports) {
    await enqueue("extraction", "report", { report });
  }
  return reports.length;
}

async function main(): Promise<void> {
  registerPipeline();
  const { mode } = await startWorkers();
  log("info", "ingestion-worker started", { mode, pollMs: POLL_MS });

  if (RUN_ONCE) {
    const n = await pollOnce();
    // Direct mode runs inline; give redis mode a moment to drain.
    await new Promise((r) => setTimeout(r, 3000));
    log("info", "run-once complete", { reports: n });
    await shutdown();
    process.exit(0);
  }

  const timer = setInterval(() => {
    pollOnce()
      .then((n) => {
        if (n) log("info", "poll complete", { reports: n });
      })
      .catch((err) => log("warn", "poll failed", { err: String(err) }));
  }, POLL_MS);
  // NOTE: the interval must stay referenced — unref() would let the event
  // loop drain and the daemon would exit immediately after startup.

  const stop = async () => {
    clearInterval(timer);
    await shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(JSON.stringify({ level: "error", msg: "worker fatal", err: String(err) }));
  process.exit(1);
});
