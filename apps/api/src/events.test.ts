import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { newDb } from "pg-mem";
import { injectPool, type PoolLike } from "./db.js";

// No route-level tests existed for events/publish — this file adds them while
// following the pgstore.test.ts parity pattern (same migrations, same sandbox).
// File store reads DATA_DIR at import time — point it at a sandbox first.
delete process.env.DATABASE_URL;
delete process.env.EVENT_INGEST_KEY;
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rakshak-events-"));
const file = await import("./store.js");
const pgstore = await import("./pgstore.js");
const events = await import("./events.js");
const { stores } = await import("./stores.js");

// All live migrations, exactly as production applies them in order. No new
// migration: api_audit_log (004) already stores actor/action/entity/entity_id.
const MIGRATION = [
  "002_records_store.sql",
  "003_verification_sources.sql",
  "004_audit_log.sql",
  "005_operator_auth.sql",
  "006_operator_profiles.sql",
]
  .map((f) => readFileSync(fileURLToPath(new URL(`../../../database/migrations/${f}`, import.meta.url)), "utf-8"))
  .join("\n");

let pool: PoolLike;

beforeEach(async () => {
  delete process.env.EVENT_INGEST_KEY;
  const db = newDb();
  for (const stmt of MIGRATION.replace(/--[^\n]*/g, "").split(";")) {
    const trimmed = stmt.replace(/IF NOT EXISTS/gi, " ").trim();
    if (!trimmed) continue;
    try {
      await db.public.query(trimmed);
    } catch (err) {
      if (!/already exists/i.test(String(err))) throw err;
    }
  }
  const { Pool } = db.adapters.createPg();
  pool = new Pool() as unknown as PoolLike;
  injectPool(pool);
  await file.clearAll();
  const { rm } = await import("node:fs/promises");
  const dir = process.env.DATA_DIR as string;
  for (const f of ["operators.json", "operator_sessions.json", "incident_sources.json", "audit_log.json", "operator_profiles.json", "call_translation.json"]) {
    await rm(join(dir, f), { force: true });
  }
});

const CASES = [
  {
    name: "translation.toggled",
    callId: "CALL-T1",
    payload: { call_id: "CALL-T1", enabled: true, by: "op-1" },
    actor: "op-1",
  },
  {
    name: "translation.suggested",
    callId: "CALL-S1",
    payload: { call_id: "CALL-S1", caller_language: "hi-IN", operator_id: "op-2" },
    actor: "op-2",
  },
  {
    name: "call.answered",
    callId: "CALL-A1",
    payload: { role: "operator", operator_id: "op-3", call_id: "CALL-A1" },
    actor: "op-3",
  },
] as const;

/** App under test: live publish routes + a GET /api/audit mirror identical to
 *  index.ts (unfiltered passthrough with the same limit clamp). */
async function buildApp() {
  const app = Fastify();
  await app.register(websocket);
  events.registerEventRoutes(app);
  app.get("/api/audit", async (req) => {
    const q = req.query as { limit?: string };
    const limit = Math.max(1, Math.min(Number(q.limit ?? 50) || 50, 500));
    return { status: "success", data: await (await stores()).getAuditLog(limit) };
  });
  return app;
}

function strip(rows: Array<Record<string, unknown>>) {
  return rows
    .map(({ id: _id, created_at: _at, ...rest }) => rest)
    .sort((a, b) => String(a.action).localeCompare(String(b.action)));
}

describe("event auto-audit predicate", () => {
  it("audits the three gateway events, including operator joins only", () => {
    for (const c of CASES) expect(events.shouldAuditEvent(c.name, c.payload)).toBe(true);
    expect(events.shouldAuditEvent("call.answered", { role: "caller", call_id: "C-1" })).toBe(false);
    expect(events.shouldAuditEvent("call.answered", { role: "operator" })).toBe(false);
    expect(events.shouldAuditEvent("call.answered", "operator")).toBe(false);
    expect(events.shouldAuditEvent("transcript.final", { original_text: "help" })).toBe(false);
    expect(events.shouldAuditEvent("incident.created", { id: "X" })).toBe(false);
  });

  it("builds the audit row with actor priority by > operator_id > gateway", () => {
    for (const c of CASES) {
      expect(events.buildEventAudit(c.name, c.callId, c.payload)).toEqual({
        actor: c.actor,
        action: c.name,
        entity: "call",
        entity_id: c.callId,
        detail: c.payload,
      });
    }
    // by wins over operator_id; gateway is the fallback.
    expect(events.buildEventAudit("call.answered", "C-1", { role: "operator", operator_id: "op-3", by: "op-9" }).actor).toBe("op-9");
    expect(events.buildEventAudit("translation.toggled", "C-1", { enabled: true }).actor).toBe("gateway");
  });
});

describe("event auto-audit dual-store parity", () => {
  it("writes each gateway event to api_audit_log in both backends", async () => {
    for (const c of CASES) {
      await file.appendAudit(events.buildEventAudit(c.name, c.callId, { ...c.payload }));
      await pgstore.appendAudit(events.buildEventAudit(c.name, c.callId, { ...c.payload }));
    }
    const fRows = await file.getAuditLog(50);
    const pRows = await pgstore.getAuditLog(50);
    for (const c of CASES) {
      expect(fRows.find((r) => r.action === c.name && r.entity_id === c.callId)).toMatchObject({
        actor: c.actor,
        entity: "call",
        detail: c.payload,
      });
      expect(pRows.find((r) => r.action === c.name && r.entity_id === c.callId)).toMatchObject({
        actor: c.actor,
        entity: "call",
        detail: c.payload,
      });
    }
    expect(strip(pRows)).toEqual(strip(fRows));
  });

  it("leaves no audit row for caller legs or unrelated events", async () => {
    await events.auditPublishedEvent("call.answered", "C-1", { role: "caller", call_id: "C-1" });
    await events.auditPublishedEvent("transcript.final", "C-1", { original_text: "help" });
    expect(await file.getAuditLog(50)).toEqual([]);
  });

  it("never throws, even when the audit store is down", async () => {
    await expect(
      events.auditPublishedEvent("translation.toggled", "C-1", { call_id: "C-1", enabled: true, by: "op-1" }, {
        appendAudit: async () => {
          throw new Error("audit store down");
        },
      }),
    ).resolves.toBeUndefined();
  });
});

describe("POST /api/events/publish", () => {
  it("audits each gateway event and GET /api/audit surfaces them", async () => {
    const app = await buildApp();
    for (const c of CASES) {
      const res = await app.inject({
        method: "POST",
        url: "/api/events/publish",
        payload: { name: c.name, callId: c.callId, payload: c.payload },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("success");
    }
    // Postgres table accepts the new actions too (004 has no action whitelist).
    for (const c of CASES) {
      await pgstore.appendAudit(events.buildEventAudit(c.name, c.callId, { ...c.payload }));
      expect(await pgstore.getAuditLog(50)).toContainEqual(expect.objectContaining({ action: c.name, entity_id: c.callId }));
    }
    const audit = await app.inject({ method: "GET", url: "/api/audit" });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().status).toBe("success");
    const rows = audit.json().data as Array<Record<string, unknown>>;
    for (const c of CASES) {
      const hit = rows.find((r) => r.action === c.name && r.entity_id === c.callId);
      expect(hit).toMatchObject({ actor: c.actor, entity: "call", detail: c.payload });
    }
  });

  it("publishes caller legs and unrelated events without auditing", async () => {
    const app = await buildApp();
    for (const body of [
      { name: "call.answered", callId: "C-1", payload: { role: "caller", call_id: "C-1" } },
      { name: "transcript.final", callId: "C-1", payload: { original_text: "help" } },
    ]) {
      const res = await app.inject({ method: "POST", url: "/api/events/publish", payload: body });
      expect(res.statusCode).toBe(200);
    }
    expect(await file.getAuditLog(50)).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/audit" })).json().data).toEqual([]);
  });

  it("still publishes when the audit write fails", async () => {
    // Helper-level: a throwing audit backend resolves instead of rejecting.
    await expect(
      events.auditPublishedEvent("translation.suggested", "C-2", { call_id: "C-2", caller_language: "mr-IN" }, {
        appendAudit: async () => {
          throw new Error("audit store down");
        },
      }),
    ).resolves.toBeUndefined();
    // Route-level: the healthy path still returns the event with audit attached.
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/events/publish",
      payload: { name: "translation.toggled", callId: "C-9", payload: { call_id: "C-9", enabled: false, by: "op-9" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ name: "translation.toggled", callId: "C-9" });
    expect(await file.getAuditLog(50)).toContainEqual(
      expect.objectContaining({ action: "translation.toggled", entity_id: "C-9", actor: "op-9" }),
    );
  });

  it("still rejects unknown events and bad bodies", async () => {
    const app = await buildApp();
    const unknown = await app.inject({
      method: "POST",
      url: "/api/events/publish",
      payload: { name: "nope.unknown", callId: "C-1", payload: {} },
    });
    expect(unknown.statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/api/events/publish", payload: { name: "call.answered" } });
    expect(bad.statusCode).toBe(400);
  });
});
