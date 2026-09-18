import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { injectPool, type PoolLike } from "./db.js";

// File store reads DATA_DIR at import time — point it at a sandbox first.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "rakshak-file-"));
const file = await import("./store.js");
const pgstore = await import("./pgstore.js");
const { computeAnalytics } = await import("./analytics.js");

// All live migrations, exactly as production applies them in order.
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
  const db = newDb();
  // One statement at a time: pg-mem silently drops trailing statements of a
  // large multi-migration batch (005 tables went missing).
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
  // Operator/auth files are global to the sandbox: reset for determinism.
  const { rm } = await import("node:fs/promises");
  const dir = process.env.DATA_DIR as string;
  for (const f of ["operators.json", "operator_sessions.json", "incident_sources.json", "audit_log.json", "operator_profiles.json", "call_translation.json"]) {
    await rm(join(dir, f), { force: true });
  }
});

function seedInput(overrides: Record<string, unknown> = {}) {
  return {
    call_id: "CALL-1",
    scenario: "Test",
    source: "text",
    original_language: "Hindi",
    transcript_original: "Sadar me chori",
    transcript_english: "Theft in Sadar",
    extraction: { incident_type: "Theft", location: "Sadar", weapon_mentioned: false },
    priority: { level: "MEDIUM" },
    timings: { total_ms: 100 },
    ...overrides,
  };
}

describe("pgstore (Postgres backend)", () => {
  it("round-trips a record with audio and timings intact", async () => {
    const saved = await pgstore.saveRecord(
      seedInput({ original_audio_base64: "data:audio/wav;base64,AAA", timings: { speech_ms: 50, total_ms: 200 } }),
    );
    // call_id without the CALL_ prefix is kept as the record id (file-store parity).
    expect(saved.id).toBe("CALL-1");
    const got = await pgstore.getRecord(saved.id);
    expect(got?.original_audio_base64).toBe("data:audio/wav;base64,AAA");
    expect(got?.timings).toEqual({ speech_ms: 50, total_ms: 200 });
  });

  it("finds records by call_id as well as id", async () => {
    const saved = await pgstore.saveRecord(seedInput({ call_id: "CALL-XYZ" }));
    expect((await pgstore.getRecord("CALL-XYZ"))?.id).toBe(saved.id);
    expect(await pgstore.getRecord("NOPE")).toBeNull();
  });

  it("replaces on duplicate transcript instead of duplicating", async () => {
    const first = await pgstore.saveRecord(seedInput({ transcript_original: "same words" }));
    const second = await pgstore.saveRecord(seedInput({ transcript_original: "same words" }));
    expect(second.id).toBe(first.id);
    expect(await pgstore.countRecords()).toBe(1);
  });

  it("filters by text, priority and language with limit/offset", async () => {
    await pgstore.saveRecord(seedInput({ call_id: "A", transcript_original: "fire in sitabuldi", priority: { level: "HIGH" }, original_language: "Marathi" }));
    await pgstore.saveRecord(seedInput({ call_id: "B", transcript_original: "theft in sadar", priority: { level: "LOW" }, original_language: "Hindi" }));
    expect((await pgstore.getRecords({ q: "sitabuldi" })).map((r) => r.call_id)).toEqual(["A"]);
    expect((await pgstore.getRecords({ priority: "LOW" })).map((r) => r.call_id)).toEqual(["B"]);
    expect((await pgstore.getRecords({ language: "marathi" })).map((r) => r.call_id)).toEqual(["A"]);
    expect(await pgstore.getRecords({ limit: 1, offset: 1 })).toHaveLength(1);
  });

  it("deletes by id or call_id and reports accurately", async () => {
    await pgstore.saveRecord(seedInput({ call_id: "GONE" }));
    expect(await pgstore.deleteRecord("NOPE")).toBe(false);
    expect(await pgstore.deleteRecord("GONE")).toBe(true);
    expect(await pgstore.countRecords()).toBe(0);
  });

  it("clears all and counts", async () => {
    await pgstore.saveRecord(seedInput({ call_id: "A" }));
    await pgstore.saveRecord(seedInput({ call_id: "B", transcript_original: "different words" }));
    expect(await pgstore.countRecords()).toBe(2);
    expect(await pgstore.clearAll()).toBe(2);
    expect(await pgstore.countRecords()).toBe(0);
  });

  it(
    "numbers dispatch entries and caps the log at 200",
    async () => {
      for (let i = 0; i < 205; i++) {
        await pgstore.appendDispatchEntry({ call_id: `C-${i}` });
      }
      const log = await pgstore.getDispatchLog();
      expect(log).toHaveLength(200);
      expect(log[0].id).toBe("DSP-205");
      // Post-cap appends must keep unique, monotonic ids (no count-based reuse).
      await pgstore.appendDispatchEntry({ call_id: "C-206" });
      await pgstore.appendDispatchEntry({ call_id: "C-207" });
      const again = await pgstore.getDispatchLog();
      expect(again).toHaveLength(200);
      expect(again[0].id).toBe("DSP-207");
      expect(new Set(again.map((e) => e.id)).size).toBe(200);
    },
    // 207 sequential pg-mem round-trips; marginal on loaded machines.
    90_000,
  );

  it("ledgers corroborating sources with file-store parity", async () => {
    const src = { report_id: "R-1", source: "fixture", title: "Fire at Sitabuldi", correlation_score: 0.63, signals: ["location-match"] };
    const [a, b] = [
      await file.addIncidentSource("INC-9", structuredClone(src)),
      await pgstore.addIncidentSource("INC-9", structuredClone(src)),
    ];
    expect(b).toEqual(a);
    expect(b.verification).toBe("multiple_reports");
    expect(b.reports).toBe(2);
    expect(b.evidence[0]).toMatchObject({ report_id: "R-1", report_source: "fixture" });
    // Idempotent re-post of the same report: no double count.
    expect((await pgstore.addIncidentSource("INC-9", structuredClone(src))).reports).toBe(2);
    expect((await file.addIncidentSource("INC-9", structuredClone(src))).reports).toBe(2);
  });

  it("climbs the verification ladder identically in both backends", async () => {
    for (const [store, key] of [[file, "F-LADDER"], [pgstore, "P-LADDER"]] as const) {
      expect((await store.getIncidentVerification(key)).verification).toBe("unverified");
      await store.addIncidentSource(key, { report_id: "R-1" });
      await store.addIncidentSource(key, { report_id: "R-2" });
      await store.addIncidentSource(key, { report_id: "R-3" });
      const v = await store.getIncidentVerification(key);
      expect(v.reports).toBe(4);
      expect(v.verification).toBe("corroborated");
    }
  });

  it("trails operator actions with file-store parity", async () => {
    const input = { actor: "ops-test", action: "dispatch", entity: "incident", entity_id: "LIVE-1", detail: { units: "P-1" } };
    const [a, b] = [await file.appendAudit(input), await pgstore.appendAudit(input)];
    expect(b.map(({ id: _a, created_at: _b, ...rest }) => rest)).toEqual(
      a.map(({ id: _c, created_at: _d, ...rest }) => rest),
    );
    expect(b[0]).toMatchObject({ actor: "ops-test", action: "dispatch", entity_id: "LIVE-1" });
    expect((await pgstore.getAuditLog(1))).toHaveLength(1);
    // Actor defaults to operator when omitted.
    const anon = await file.appendAudit({ action: "record.delete", entity_id: "X" });
    expect(anon[0].actor).toBe("operator");
  });

  it("patches geo onto records identically in both backends", async () => {
    await file.saveRecord(seedInput({ call_id: "GEO-F" }));
    await pgstore.saveRecord(seedInput({ call_id: "GEO-P" }));
    const geo = { lat: 21.1495, lon: 79.08, display: "Sitabuldi, Nagpur" };
    expect(await file.updateRecordGeo("GEO-F", geo)).toBe(true);
    expect(await pgstore.updateRecordGeo("GEO-P", geo)).toBe(true);
    expect((await file.getRecord("GEO-F"))?.extraction?.geo).toEqual(geo);
    expect((await pgstore.getRecord("GEO-P"))?.extraction?.geo).toEqual(geo);
    expect(await pgstore.updateRecordGeo("GHOST", geo)).toBe(false);
  });

  it("registers operators first-is-admin with session lifecycle in both backends", async () => {
    for (const s of [file, pgstore]) {
      const admin = await s.createOperator({ name: "Ops Admin", passwordHash: "h1" });
      expect(admin.role).toBe("admin");
      expect(admin).not.toHaveProperty("password_hash");
      const op = await s.createOperator({ name: "Ops Other", passwordHash: "h2" });
      expect(op.role).toBe("operator");
      expect((await s.findOperatorByName("ops admin"))?.id).toBe(admin.id);
      expect(await s.findOperatorByName("ghost")).toBeNull();
      const future = new Date(Date.now() + 3600_000).toISOString();
      await s.createSession(admin.id, "tok-live", future);
      expect((await s.resolveSession("tok-live"))?.name).toBe("Ops Admin");
      await s.revokeSession("tok-live");
      expect(await s.resolveSession("tok-live")).toBeNull();
      await s.createSession(admin.id, "tok-dead", new Date(Date.now() - 1000).toISOString());
      expect(await s.resolveSession("tok-dead")).toBeNull();
    }
  });

  it("rotates password hashes and revokes other sessions in both backends", async () => {
    for (const s of [file, pgstore]) {
      const op = await s.createOperator({ name: "Ops Rotate", passwordHash: "old-hash" });
      expect(await s.updatePasswordHash(op.id, "new-hash")).toBe(true);
      expect(await s.updatePasswordHash("ghost-id", "x")).toBe(false);
      expect((await s.findOperatorByName("Ops Rotate"))?.password_hash).toBe("new-hash");
      const future = new Date(Date.now() + 3600_000).toISOString();
      await s.createSession(op.id, "tok-keep", future);
      await s.createSession(op.id, "tok-drop", future);
      await s.revokeOtherSessions(op.id, "tok-keep");
      expect((await s.resolveSession("tok-keep"))?.name).toBe("Ops Rotate");
      expect(await s.resolveSession("tok-drop")).toBeNull();
    }
  });

  it("stamps the returned entry with its dispatch id (file-store parity)", async () => {
    const entry: Record<string, unknown> = { call_id: "E-1" };
    await pgstore.appendDispatchEntry(entry);
    expect(entry.id).toMatch(/^DSP-/);
  });

  it("marks dispatch on the matching record", async () => {
    await pgstore.saveRecord(seedInput({ call_id: "D-1" }));
    expect(await pgstore.updateRecordDispatch("D-1", { id: "DSP-001" })).toBe(true);
    expect(await pgstore.updateRecordDispatch("GHOST", {})).toBe(false);
    const rec = await pgstore.getRecord("D-1");
    expect(rec?.dispatched).toBe(true);
    expect(rec?.dispatch_info).toEqual({ id: "DSP-001" });
  });

  it("computes analytics identical to the file store on the same data", async () => {
    const inputs = [
      seedInput({ call_id: "H", priority: { level: "HIGH" }, extraction: { incident_type: "Fire", location: "Sadar", weapon_mentioned: true, weapon_type: "knife", immediate_danger: true, caller_state: "panicked" }, timings: { speech_ms: 100, total_ms: 500 } }),
      seedInput({ call_id: "M", transcript_original: "other words", priority: { level: "MEDIUM" }, extraction: { incident_type: "Theft", location: "Sadar", weapon_mentioned: false, immediate_danger: false, caller_state: "calm" }, timings: { total_ms: 300 } }),
      seedInput({ call_id: "L", transcript_original: "third words", priority: { level: "LOW" }, extraction: { incident_type: "Unknown", location: "Not identified", weapon_mentioned: false, immediate_danger: false, caller_state: "unknown" }, timings: {} }),
    ];
    for (const input of inputs) {
      await file.saveRecord(structuredClone(input));
      await pgstore.saveRecord(structuredClone(input));
    }
    const [a, b] = [await file.getAnalytics(), await pgstore.getAnalytics()];
    expect(b).toEqual(a);
    expect(b.total_records).toBe(3);
    expect(b.priority_breakdown).toMatchObject({ HIGH: 1, MEDIUM: 1, LOW: 1 });
    expect(b.weapon_stats.present).toBe(1);
    expect(b.immediate_danger_count).toBe(1);
    expect(b.average_latencies.total_ms).toBe(400);
    expect(computeAnalytics(await pgstore.getRecords({ limit: 500 }))).toEqual(b);
  });

  it("upserts operator profiles with file-store parity and mobile lookup", async () => {
    for (const [s, tag] of [[file, "F"], [pgstore, "P"]] as const) {
      const op = await s.createOperator({ name: `Prof ${tag}`, passwordHash: "h" });
      const oid = String(op.id);
      expect(await s.getOperatorProfile(oid)).toBeNull();
      const created = await s.upsertOperatorProfile(oid, {
        known_languages: ["hi-IN", "en-IN"],
        default_language: "hi-IN",
        mobile_e164: "91 98765 43210",
      });
      expect(created).toMatchObject({
        operator_id: oid,
        known_languages: ["hi-IN", "en-IN"],
        default_language: "hi-IN",
        mobile_e164: "+919876543210",
        active: true,
      });
      // Partial patch keeps existing fields.
      const patched = await s.upsertOperatorProfile(oid, { default_language: "mr-IN" });
      expect(patched).toMatchObject({ default_language: "mr-IN", known_languages: ["hi-IN", "en-IN"] });
      expect(await s.getOperatorProfile(oid)).toEqual(patched);
      // Lookup normalizes spaces + missing plus on both write and query.
      const hit = await s.findOperatorProfileByMobile("+91 98765 43210");
      expect(hit?.operator_id).toBe(oid);
      expect(hit).toMatchObject({ default_language: "mr-IN" });
      expect(await s.findOperatorProfileByMobile("+910000000000")).toBeNull();
    }
    // Same semantics in both backends (ids differ — operators are per-backend).
    const [a, b] = [await file.findOperatorProfileByMobile("+919876543210"), await pgstore.findOperatorProfileByMobile("91 98765 43210")];
    expect(a).toMatchObject({ known_languages: ["hi-IN", "en-IN"], default_language: "mr-IN" });
    expect(b).toMatchObject({ known_languages: ["hi-IN", "en-IN"], default_language: "mr-IN" });
  });

  it("toggles per-call translation with file-store parity and false default", async () => {
    for (const s of [file, pgstore]) {
      expect(await s.getCallTranslation("CALL-T1")).toEqual({ call_id: "CALL-T1", enabled: false });
      expect(await s.setCallTranslation("CALL-T1", true)).toEqual({ call_id: "CALL-T1", enabled: true });
      expect(await s.getCallTranslation("CALL-T1")).toEqual({ call_id: "CALL-T1", enabled: true });
      expect(await s.setCallTranslation("CALL-T1", false)).toEqual({ call_id: "CALL-T1", enabled: false });
    }
    expect(await pgstore.getCallTranslation("CALL-T1")).toEqual(await file.getCallTranslation("CALL-T1"));
  });
});
