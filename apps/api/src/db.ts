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

export function injectPool(p: PoolLike | null): void {
  pool = p;
  attempted = p !== null;
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
