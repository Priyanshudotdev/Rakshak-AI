import { Queue, Worker, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

// Queue layer (spec §14): extraction, classification, location-resolution,
// incident-correlation, enrichment, notification.
//
// Needs Redis in production (docker-compose provides it). Without a reachable
// Redis the worker runs in DIRECT mode: jobs execute inline in registration
// order. Same pipeline, zero infrastructure — honest degradation, and the
// smoke test exercises exactly this path.

export const QUEUE_NAMES = [
  "extraction",
  "classification",
  "location-resolution",
  "incident-correlation",
  "enrichment",
  "notification",
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];
export type Handler = (job: { name: string; data: any }) => Promise<unknown>;

const handlers = new Map<QueueName, Handler[]>();
let redis: Redis | null = null;
let redisChecked = false;
const queues = new Map<string, Queue>();

function redisUrl(): string {
  return process.env.REDIS_URL ?? "redis://localhost:6379";
}

async function redisUp(): Promise<boolean> {
  if (redisChecked) return redis !== null;
  redisChecked = true;
  try {
    const client = new Redis(redisUrl(), {
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    // Swallow connection errors: absence of Redis selects direct mode, not a crash.
    client.on("error", () => {});
    await Promise.race([
      client.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("redis timeout")), 2000)),
    ]);
    redis = client;
    return true;
  } catch {
    redis = null;
    return false;
  }
}

export function onQueue(name: QueueName, handler: Handler): void {
  const list = handlers.get(name) ?? [];
  list.push(handler);
  handlers.set(name, list);
}

async function runInline(name: QueueName, jobName: string, data: unknown): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const handler of handlers.get(name) ?? []) {
    out.push(await handler({ name: jobName, data }));
  }
  return out;
}

export async function enqueue(name: QueueName, jobName: string, data: unknown, opts?: JobsOptions): Promise<{ mode: "redis" | "direct" }> {
  if (await redisUp()) {
    let queue = queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: redis! });
      queues.set(name, queue);
    }
    await queue.add(jobName, data as Record<string, unknown>, opts);
    return { mode: "redis" };
  }
  await runInline(name, jobName, data);
  return { mode: "direct" };
}

/** Start BullMQ workers when Redis is up; no-op in direct mode (handlers run inline). */
export async function startWorkers(concurrency = 2): Promise<{ mode: "redis" | "direct" }> {
  if (!(await redisUp())) return { mode: "direct" };
  for (const name of QUEUE_NAMES) {
    const fns = handlers.get(name) ?? [];
    if (!fns.length) continue;
    new Worker(
      name,
      async (job) => {
        for (const fn of fns) await fn({ name: job.name, data: job.data });
      },
      { connection: redis!.duplicate(), concurrency },
    );
  }
  return { mode: "redis" };
}

export async function shutdown(): Promise<void> {
  for (const queue of queues.values()) {
    try {
      await queue.close();
    } catch {
      /* ignore */
    }
  }
  if (redis) {
    try {
      await redis.quit();
    } catch {
      /* ignore */
    }
  }
}
