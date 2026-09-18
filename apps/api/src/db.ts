import { Pool } from "pg";
import { log } from "@rakshak/logger";

// Postgres connectivity. Primary backend when DATABASE_URL is set and
// reachable; the API falls back to the file store otherwise (spec: design
// for failure, keep the call path alive). Tests inject a pg-mem pool.

export interface PoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  end(): Promise<void>;
}

let pool: PoolLike | null = null;
let attempted = false;

/** Per-query timeout (ms). Real PG also enforces statement_timeout=8000 at
 *  the Pool level; this wrapper guarantees a fast 500 (never hang) even if
 *  the driver itself stalls (Neon blip, TCP hang) and gives tests a fast
 *  knob via DB_STATEMENT_TIMEOUT_MS. */
export function queryTimeoutMs(): number {
  const raw = Number(process.env.DB_STATEMENT_TIMEOUT_MS ?? 8000);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 30000);
  return 8000;
}

export class QueryTimeoutError extends Error {
  constructor(ms: number) {
    super(`Database query timed out after ${ms}ms`);
    this.name = "QueryTimeoutError";
  }
}

/** Race a pool query against the statement timeout. Never hangs. */
export async function queryWithTimeout(
  p: PoolLike,
  text: string,
  params?: unknown[],
  timeoutMs?: number,
): Promise<{ rows: any[]; rowCount: number | null }> {
  const ms = timeoutMs ?? queryTimeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.query(text, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new QueryTimeoutError(ms)), ms);
        // Don't pin the process open on a hung DB.
        (timer as unknown as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Lightweight liveness probe. Resolves false (never throws, never hangs)
 *  when the pool is missing, down, or slower than the timeout. */
export async function probePool(p: PoolLike | null, timeoutMs = 2000): Promise<boolean> {
  if (!p) return false;
  try {
    await queryWithTimeout(p, "SELECT 1", [], timeoutMs);
    return true;
  } catch {
    return false;
  }
}

export function injectPool(p: PoolLike | null): void {
  pool = p;
  attempted = p !== null;
}

/** Test seam: forget the cached probe so isPostgresConfigured re-runs. */
export function resetDbForTests(): void {
  pool = null;
  attempted = false;
}

export function selectedPool(): PoolLike | null {
  return pool;
}

export async function isPostgresConfigured(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  if (attempted) return pool !== null;
  attempted = true;
  // One blip must not pin the whole process lifetime to the file store.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const p = new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 8000,
        statement_timeout: 8000,
      });
      await p.query("SELECT 1");
      pool = p as unknown as PoolLike;
      log("info", "postgres backend selected", { attempt });
      return true;
    } catch (err) {
      log("warn", "postgres probe failed", { attempt, err: String(err) });
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  log("warn", "postgres unreachable, using file store");
  pool = null;
  return false;
}
