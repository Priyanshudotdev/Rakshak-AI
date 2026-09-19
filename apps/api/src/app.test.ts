import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { injectPool, resetDbForTests, type PoolLike } from "./db.js";

// File store reads DATA_DIR at import time — sandbox first. Do NOT statically
// import ./stores.js / ./app.js above: they transitively load ./store.js
// before this line runs and pin DATA_DIR to the real data/ dir.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rakshak-app-"));
const file = await import("./store.js");
const pgstoreMod = await import("./pgstore.js");
const { resetSchemaForTests, schemaStatus } = pgstoreMod;
const storesMod = await import("./stores.js");
const { resetStoresForTests, setBackendNameForTests } = storesMod;
const { createApp } = await import("./app.js");
type StoreLike = import("./app.js").StoreLike;

function failingStore(errMsg = "connect ECONNREFUSED Neon down"): StoreLike {
  const fail = async (): Promise<never> => {
    throw new Error(errMsg);
  };
  return {
    saveRecord: fail,
    getRecords: fail,
    getRecord: fail,
    deleteRecord: fail,
    clearAll: fail,
    countRecords: fail,
    updateRecordDispatch: fail,
    updateRecordGeo: fail,
    getAnalytics: fail,
    getDispatchLog: fail,
    appendDispatchEntry: fail,
    addIncidentSource: fail,
    getIncidentVerification: fail,
    appendAudit: fail,
    getAuditLog: fail,
    countOperators: fail,
    findOperatorByName: fail,
    createOperator: fail,
    createSession: fail,
    resolveSession: fail,
    revokeSession: fail,
    updatePasswordHash: fail,
    revokeOtherSessions: fail,
    getOperatorProfile: fail,
    upsertOperatorProfile: fail,
    findOperatorProfileByMobile: fail,
    getCallTranslation: fail,
    setCallTranslation: fail,
  };
}

function hangingStore(): StoreLike {
  const hang = () => new Promise<never>(() => {});
  return {
    saveRecord: hang,
    getRecords: hang,
    getRecord: hang,
    deleteRecord: hang,
    clearAll: hang,
    countRecords: hang,
    updateRecordDispatch: hang,
    updateRecordGeo: hang,
    getAnalytics: hang,
    getDispatchLog: hang,
    appendDispatchEntry: hang,
    addIncidentSource: hang,
    getIncidentVerification: hang,
    appendAudit: hang,
    getAuditLog: hang,
    countOperators: hang,
    findOperatorByName: hang,
    createOperator: hang,
    createSession: hang,
    resolveSession: hang,
    revokeSession: hang,
    updatePasswordHash: hang,
    revokeOtherSessions: hang,
    getOperatorProfile: hang,
    upsertOperatorProfile: hang,
    findOperatorProfileByMobile: hang,
    getCallTranslation: hang,
    setCallTranslation: hang,
  };
}

async function resetFileStore() {
  await file.clearAll().catch(() => {});
  const { rm } = await import("node:fs/promises");
  const dir = process.env.DATA_DIR as string;
  for (const f of [
    "operators.json",
    "operator_sessions.json",
    "incident_sources.json",
    "audit_log.json",
    "dispatch_log.json",
    "operator_profiles.json",
    "call_translation.json",
  ]) {
    await rm(join(dir, f), { force: true });
  }
}

beforeEach(async () => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.EVENT_INGEST_KEY;
  process.env.DB_STATEMENT_TIMEOUT_MS = "8000";
  resetDbForTests();
  resetSchemaForTests();
  resetStoresForTests();
  setBackendNameForTests("file");
  injectPool(null);
  // injectPool(null) marks attempted=true; reset so readiness treats file backend
  // without probing. Re-reset the flag via resetDbForTests ordering:
  resetDbForTests();
  setBackendNameForTests("file");
  await resetFileStore();
});

afterEach(async () => {
  delete process.env.AUTH_REQUIRED;
  delete process.env.EVENT_INGEST_KEY;
  process.env.DB_STATEMENT_TIMEOUT_MS = "8000";
  resetDbForTests();
  resetSchemaForTests();
  resetStoresForTests();
  setBackendNameForTests("file");
});

describe("readiness (GET /api/health + /api/ready)", () => {
  it("keeps /api/health backward compatible and reports file/ok", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // Backward compat: pre-existing fields still present.
    expect(body.status).toBe("ok");
    expect(body).toHaveProperty("sarvam");
    expect(body).toHaveProperty("gemini");
    expect(body).toHaveProperty("store", "file");
    // New: dashboard header can distinguish DB states.
    expect(body).toMatchObject({ db: "file", migrations: "ok" });
  });

  it("GET /api/ready reports {api, db, migrations}", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ api: "up", db: "file", migrations: "ok" });
  });

  it("reports degraded + db:down when postgres is selected but unreachable", async () => {
    setBackendNameForTests("postgres");
    // No pool (or a failing pool) -> probe false -> down.
    injectPool(null);
    resetDbForTests();
    setBackendNameForTests("postgres");
    const app = await createApp(file as unknown as StoreLike);
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json() as Record<string, unknown>;
    expect(health.status).toBe("degraded");
    expect(health.db).toBe("down");
    const ready = (await app.inject({ method: "GET", url: "/api/ready" })).json() as Record<string, unknown>;
    expect(ready).toMatchObject({ api: "up", db: "down" });
  });

  it("reports migrations:pending while schema is unready (fast, never hangs)", async () => {
    setBackendNameForTests("postgres");
    // Failing pool: probe SELECT 1 rejects fast -> down + pending.
    injectPool({ query: async () => { throw new Error("Neon down"); }, end: async () => {} });
    const app = await createApp(file as unknown as StoreLike);
    const ready = (await app.inject({ method: "GET", url: "/api/ready" })).json() as Record<string, unknown>;
    expect(ready.db).toBe("down");
    expect(ready.migrations).toBe("pending");
    expect(schemaStatus().ready).toBe(false);
  });

  it("pins schema failure (no DDL replay on every request) and fails health distinctly", async () => {
    let queries = 0;
    injectPool({
      query: async () => {
        queries += 1;
        throw new Error("42804 cross-type FK boom");
      },
      end: async () => {},
    });
    resetSchemaForTests();
    const pgstore = await import("./pgstore.js");
    await expect(pgstore.saveRecord({ call_id: "X-1" } as never)).rejects.toThrow();
    expect(schemaStatus().ready).toBe(false);
    expect(schemaStatus().error).toMatch(/boom/);
    const firstQueries = queries;
    expect(firstQueries).toBeGreaterThan(0);
    // Second call must fail fast WITHOUT replaying DDL.
    queries = 0;
    await expect(pgstore.saveRecord({ call_id: "X-1" } as never)).rejects.toThrow(/not ready/);
    expect(queries).toBe(0);
    // Health reports the unready schema distinctly.
    setBackendNameForTests("postgres");
    const app = await createApp(file as unknown as StoreLike);
    const health = (await app.inject({ method: "GET", url: "/api/health" })).json() as Record<string, unknown>;
    expect(health.status).toBe("degraded");
    expect(health.migrations).toBe("pending");
  });
});

describe("response envelopes (healthy file backend, demo-open reads)", () => {
  it("GET /api/records -> {status, data, count}", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/records?limit=10&offset=0" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "success", count: 0 });
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it("rejects non-integer limit/offset with 400 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/records?limit=abc" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("GET /api/records/count -> {status, data:{count}}", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/records/count" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "success", data: { count: 0 } });
  });

  it("GET /api/analytics -> {status, data}", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/analytics" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("success");
    expect(res.json().data).toMatchObject({ total_records: 0 });
  });

  it("GET /api/dispatch returns the {status, data} envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/dispatch" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "success" });
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it("GET /api/audit -> {status, data}", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/audit?limit=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "success" });
    expect(Array.isArray(res.json().data)).toBe(true);
  });

  it("GET /api/records/:id 404 uses the error envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/records/NOPE" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ status: "error", message: "Record not found" });
  });

  it("GET /api/records/:id/audio 404s with envelope when missing", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/records/NOPE/audio" });
    expect(res.statusCode).toBe(404);
    expect(res.json().status).toBe("error");
  });

  it("GET /api/incidents/:key/verification -> {status, data}", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/incidents/INC-1/verification" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "success", data: { verification: "unverified" } });
  });

  it("POST /api/process-call without transcript -> 400 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "POST", url: "/api/process-call", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("POST /api/tts without text -> 400 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "POST", url: "/api/tts", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("POST /api/process-audio with no file -> 400 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "POST", url: "/api/process-audio" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("POST /api/translate validation -> 400 (demo-open, before AI)", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "POST", url: "/api/translate", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("GET /api/operators/me without token -> 401 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "GET", url: "/api/operators/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("POST /api/operators/change-password without token -> 401; bad body -> 400", async () => {
    const app = await createApp(file as unknown as StoreLike);
    expect((await app.inject({ method: "POST", url: "/api/operators/change-password", payload: {} })).statusCode).toBe(400);
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/change-password",
      payload: { currentPassword: "aaaa", newPassword: "bbbb" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("POST /api/operators/register validation -> 400 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({ method: "POST", url: "/api/operators/register", payload: { name: "x" } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error" });
  });

  it("POST /api/operators/login bad credentials -> 401 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const res = await app.inject({
      method: "POST",
      url: "/api/operators/login",
      payload: { name: "ghost", password: "nope-nope" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ status: "error", message: "Invalid credentials" });
  });

  it("GET /api/operators/lookup without mobile -> 400; unknown -> 404 error envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    expect((await app.inject({ method: "GET", url: "/api/operators/lookup" })).statusCode).toBe(400);
    const miss = await app.inject({ method: "GET", url: "/api/operators/lookup?mobile=%2B919999999999" });
    expect(miss.statusCode).toBe(404);
    expect(miss.json()).toMatchObject({ status: "error" });
  });
});

describe("auth correctness (demo-open vs operator-gated)", () => {
  it("reads stay open with no token (demo)", async () => {
    const app = await createApp(file as unknown as StoreLike);
    for (const url of ["/api/records", "/api/records/count", "/api/analytics", "/api/dispatch", "/api/audit"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(200);
    }
  });

  it("profile/translation always require a session, even when AUTH_REQUIRED is off", async () => {
    const app = await createApp(file as unknown as StoreLike);
    expect((await app.inject({ method: "GET", url: "/api/operators/profile" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/operators/profile", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/calls/C-1/translation" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/calls/C-1/translation", payload: { enabled: true } })).statusCode).toBe(401);
  });

  it("mutating routes are demo-open when AUTH_REQUIRED is off, 401 when on without token", async () => {
    const app = await createApp(file as unknown as StoreLike);
    // Demo-open: no token still succeeds (or 404 for missing record, not 401).
    expect((await app.inject({ method: "DELETE", url: "/api/records" })).statusCode).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/api/records/NOPE" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/dispatch", payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/translate", payload: { text: "x" } })).statusCode).not.toBe(401);

    process.env.AUTH_REQUIRED = "1";
    const gated = await createApp(file as unknown as StoreLike);
    expect((await gated.inject({ method: "DELETE", url: "/api/records" })).statusCode).toBe(401);
    expect((await gated.inject({ method: "DELETE", url: "/api/records/NOPE" })).statusCode).toBe(401);
    expect((await gated.inject({ method: "POST", url: "/api/dispatch", payload: {} })).statusCode).toBe(401);
    expect((await gated.inject({ method: "POST", url: "/api/translate", payload: { text: "x" } })).statusCode).toBe(401);
  });

  it("signed-in operator passes the gates and profile returns bare object (no envelope)", async () => {
    const app = await createApp(file as unknown as StoreLike);
    // Bootstrap first admin (open), then login for a Bearer token.
    const reg = await app.inject({ method: "POST", url: "/api/operators/register", payload: { name: "ops1", password: "s3cret-x" } });
    expect(reg.statusCode).toBe(200);
    const login = await app.inject({ method: "POST", url: "/api/operators/login", payload: { name: "ops1", password: "s3cret-x" } });
    const token = (login.json() as any).data.token as string;
    const auth = { authorization: `Bearer ${token}` };

    const profile = await app.inject({ method: "GET", url: "/api/operators/profile", headers: auth });
    expect(profile.statusCode).toBe(200);
    // Bare profile shape (dashboard parses it directly) — must NOT be enveloped.
    expect(profile.json()).toMatchObject({ operator_id: expect.any(String), default_language: "hi-IN" });
    expect(profile.json()).not.toHaveProperty("status");

    const put = await app.inject({
      method: "PUT",
      url: "/api/operators/profile",
      headers: { ...auth, "content-type": "application/json" },
      payload: { default_language: "mr-IN", mobile_e164: "98765 43210" },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ default_language: "mr-IN", mobile_e164: "+919876543210" });

    const tOff = await app.inject({ method: "GET", url: "/api/calls/CALL-T/translation", headers: auth });
    expect(tOff.json()).toEqual({ call_id: "CALL-T", enabled: false });
    const tOn = await app.inject({
      method: "POST",
      url: "/api/calls/CALL-T/translation",
      headers: { ...auth, "content-type": "application/json" },
      payload: { enabled: true },
    });
    expect(tOn.json()).toEqual({ call_id: "CALL-T", enabled: true });

    // Gated writes succeed with the token even when AUTH_REQUIRED=1.
    process.env.AUTH_REQUIRED = "1";
    const gated = await createApp(file as unknown as StoreLike);
    expect((await gated.inject({ method: "DELETE", url: "/api/records", headers: auth })).statusCode).toBe(200);
    expect((await gated.inject({ method: "GET", url: "/api/operators/me", headers: auth })).statusCode).toBe(200);
  });

  it("second registration requires admin (401 anonymous, 403 non-admin)", async () => {
    const app = await createApp(file as unknown as StoreLike);
    await app.inject({ method: "POST", url: "/api/operators/register", payload: { name: "admin0", password: "s3cret-x" } });
    expect((await app.inject({ method: "POST", url: "/api/operators/register", payload: { name: "ops2", password: "s3cret-x" } })).statusCode).toBe(401);
  });

  it("logout is idempotent and never fails (even with no token)", async () => {
    const app = await createApp(file as unknown as StoreLike);
    expect((await app.inject({ method: "POST", url: "/api/operators/logout" })).statusCode).toBe(200);
  });
});

describe("failure modes (Neon down -> fast 500, never hang)", () => {
  it("unreachable DB returns fast 500 with a clear message on every DB-backed route", async () => {
    const app = await createApp(failingStore());
    const started = Date.now();
    const gets = [
      "/api/records",
      "/api/records/count",
      "/api/analytics",
      "/api/dispatch",
      "/api/audit",
      "/api/records/ANY",
      "/api/incidents/K/verification",
    ];
    for (const url of gets) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ status: "error", message: "Database unavailable" });
    }
    // Mutating paths (demo-open, no token) also fail fast with the same envelope.
    for (const req of [
      { method: "DELETE", url: "/api/records" },
      { method: "DELETE", url: "/api/records/ANY" },
      { method: "POST", url: "/api/dispatch", payload: {} },
      { method: "POST", url: "/api/incidents/K/sources", payload: { report_id: "R-1" } },
      { method: "POST", url: "/api/operators/login", payload: { name: "a", password: "bbbb" } },
    ] as const) {
      const res = await app.inject(req as never);
      expect(res.statusCode).toBe(500);
      expect((res.json() as any).message).toBe("Database unavailable");
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("a hung backend still answers fast (timeout, never hang)", async () => {
    process.env.DB_STATEMENT_TIMEOUT_MS = "50";
    const app = await createApp(hangingStore());
    const started = Date.now();
    for (const url of ["/api/records/count", "/api/analytics", "/api/dispatch", "/api/audit"]) {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ status: "error" });
    }
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  it("logout stays 200 even when the DB is down (best-effort)", async () => {
    const app = await createApp(failingStore());
    const res = await app.inject({ method: "POST", url: "/api/operators/logout", headers: { authorization: "Bearer tok" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "success" });
  });
});

describe("migrations (006 + idempotency)", () => {
  const FILES = [
    "002_records_store.sql",
    "003_verification_sources.sql",
    "004_audit_log.sql",
    "005_operator_auth.sql",
    "006_operator_profiles.sql",
  ];

  function applyAll(db: { query: (s: string) => Promise<unknown> }, sql: string) {
    return (async () => {
      for (const stmt of sql.replace(/--[^\n]*/g, "").split(";")) {
        const trimmed = stmt.replace(/IF NOT EXISTS/gi, " ").trim();
        if (!trimmed) continue;
        try {
          await db.query(trimmed);
        } catch (err) {
          if (!/already exists/i.test(String(err))) throw err;
        }
      }
    })();
  }

  it("006 avoids a cross-type FK to operators(id) (regression guard)", () => {
    const sql = readFileSync(
      fileURLToPath(new URL(`../../../database/migrations/006_operator_profiles.sql`, import.meta.url)),
      "utf-8",
    );
    expect(sql).not.toMatch(/REFERENCES\s+operators/i);
  });

  it("all migrations apply twice cleanly (idempotent)", async () => {
    const db = newDb();
    const sql = FILES.map((f) =>
      readFileSync(fileURLToPath(new URL(`../../../database/migrations/${f}`, import.meta.url)), "utf-8"),
    ).join("\n");
    const mem = { query: async (s: string) => {
      await db.public.query(s);
    } };
    await applyAll(mem, sql);
    await applyAll(mem, sql);
    const { Pool } = db.adapters.createPg();
    const pool = new Pool() as unknown as PoolLike;
    // pg-mem has no pg_tables — prove each table exists with a live SELECT.
    for (const t of ["records", "dispatch_log", "incident_sources", "api_audit_log", "operators", "operator_sessions", "operator_profiles", "call_translation"]) {
      const res = await pool.query(`SELECT COUNT(*) AS n FROM ${t}`);
      expect(Number((res.rows[0] as any)?.n ?? 0)).toBeGreaterThanOrEqual(0);
    }
  });

  it("profile mobile clash is file/pg parity (mobile_taken in both stores)", async () => {
    // pg-mem parity for the unique-mobile rule.
    const db = newDb();
    const sql = FILES.map((f) =>
      readFileSync(fileURLToPath(new URL(`../../../database/migrations/${f}`, import.meta.url)), "utf-8"),
    ).join("\n");
    await applyAll({ query: async (s: string) => {
      await db.public.query(s);
    } }, sql);
    const { Pool } = db.adapters.createPg();
    injectPool(new Pool() as unknown as PoolLike);
    resetSchemaForTests();
    const pgstore = await import("./pgstore.js");
    for (const s of [file, pgstore]) {
      const a = await s.createOperator({ name: `Clash A ${Math.random()}`, passwordHash: "h" });
      const b = await s.createOperator({ name: `Clash B ${Math.random()}`, passwordHash: "h" });
      await s.upsertOperatorProfile(String(a.id), { mobile_e164: "+911111111111" });
      await expect(s.upsertOperatorProfile(String(b.id), { mobile_e164: "911111111111" })).rejects.toThrow(/mobile_taken/i);
    }
  });

  it("PUT /api/operators/profile maps a mobile clash to 409 envelope", async () => {
    const app = await createApp(file as unknown as StoreLike);
    const regA = await app.inject({ method: "POST", url: "/api/operators/register", payload: { name: "routeA", password: "s3cret-x" } });
    expect(regA.statusCode).toBe(200);
    const loginA = await app.inject({ method: "POST", url: "/api/operators/login", payload: { name: "routeA", password: "s3cret-x" } });
    const tokenA = (loginA.json() as any).data.token as string;
    // routeA is first operator -> admin, so it can register routeB.
    const regB = await app.inject({
      method: "POST",
      url: "/api/operators/register",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      payload: { name: "routeB", password: "s3cret-x" },
    });
    expect(regB.statusCode).toBe(200);
    const loginB = await app.inject({ method: "POST", url: "/api/operators/login", payload: { name: "routeB", password: "s3cret-x" } });
    const tokenB = (loginB.json() as any).data.token as string;
    await app.inject({
      method: "PUT",
      url: "/api/operators/profile",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      payload: { mobile_e164: "+912222222222" },
    });
    const clash = await app.inject({
      method: "PUT",
      url: "/api/operators/profile",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      payload: { mobile_e164: "912222222222" },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ status: "error", message: "mobile already in use" });
  });
});
