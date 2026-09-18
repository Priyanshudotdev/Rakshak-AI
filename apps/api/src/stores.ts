import { isPostgresConfigured } from "./db.js";
import * as file from "./store.js";
import * as pgstore from "./pgstore.js";

// Backend selector: Postgres when DATABASE_URL is set and reachable,
// otherwise the file store. Resolved once at startup; both backends share
// identical function names and semantics (locked by pgstore.test.ts).

export type Backend = typeof file;

let backend: Backend | null = null;
let backendName = "file";

export async function stores(): Promise<Backend> {
  if (!backend) {
    backend = (await isPostgresConfigured()) ? (pgstore as unknown as Backend) : file;
    backendName = backend === (file as unknown as Backend) ? "file" : "postgres";
  }
  return backend;
}

export function backendNameSync(): string {
  return backendName;
}

/** Test seam: forget the cached backend so the next stores() re-probes. */
export function resetStoresForTests(): void {
  backend = null;
  backendName = "file";
}

/** Test seam: force the readiness banner (file|postgres) without probing. */
export function setBackendNameForTests(name: string): void {
  backendName = name;
}
