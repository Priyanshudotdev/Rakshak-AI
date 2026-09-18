import { describe, expect, it, vi } from "vitest";
import { buildNormalizedRows, syncAll, syncRecord } from "./sync.js";

const RECORD = {
  id: "REC-1",
  call_id: "LIVE-1",
  created_at: "2026-09-16T12:00:00.000Z",
  original_language: "Marathi",
  language_code: "mr-IN",
  language_confidence: 0.9,
  transcript_original: "aag lagli",
  transcript_english: "fire broke out",
  transcript_marathi: "आग लागली",
  extraction: {
    incident_type: "Fire",
    location: "Sitabuldi",
    summary: "Shop fire",
    geo: { lat: 21.1484, lon: 79.084 },
  },
  priority: { level: "HIGH", confidence: 0.85, reasoning: "trapped" },
  llm_used: "gemini",
  dispatched: true,
};

function fakePool() {
  const queries: Array<{ text: string; params: unknown[] }> = [];
  // First SELECT returns no existing incident; later ones return a fake id.
  let selects = 0;
  const pool = {
    query: vi.fn(async (text: string, params: unknown[] = []) => {
      queries.push({ text, params });
      if (text.startsWith("SELECT id FROM incidents")) {
        selects += 1;
        return { rows: selects > 1 ? [{ id: "uuid-1" }] : [], rowCount: selects > 1 ? 1 : 0 };
      }
      if (text.includes("RETURNING id")) return { rows: [{ id: "uuid-1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
    end: vi.fn(async () => {}),
  };
  return { pool, queries };
}

describe("buildNormalizedRows", () => {
  it("maps the record blob to normalized rows", () => {
    const row = buildNormalizedRows(RECORD);
    expect(row).toMatchObject({
      callId: "LIVE-1",
      callStatus: "dispatched",
      incidentType: "Fire",
      priority: "HIGH",
      locationRaw: "Sitabuldi",
      lat: 21.1484,
      lon: 79.084,
      model: "gemini",
    });
  });

  it("nulls invalid coordinates instead of writing NaN", () => {
    const row = buildNormalizedRows({ ...RECORD, extraction: { location: "X" } });
    expect(row.lat).toBeNull();
    expect(row.lon).toBeNull();
  });
});

describe("syncRecord", () => {
  it("writes calls, transcripts, incidents, assessments and explanations", async () => {
    const { pool, queries } = fakePool();
    const out = await syncRecord(pool, RECORD, { embed: async () => null });
    expect(out).toEqual({ incidentId: "uuid-1", skipped: false });
    const tables = queries.map((q) => q.text);
    expect(tables.some((t) => t.includes("INSERT INTO calls"))).toBe(true);
    expect(tables.some((t) => t.includes("INSERT INTO transcripts"))).toBe(true);
    expect(tables.some((t) => t.includes("INSERT INTO incidents"))).toBe(true);
    expect(tables.some((t) => t.includes("INSERT INTO priority_assessments"))).toBe(true);
    expect(tables.some((t) => t.includes("INSERT INTO ai_explanations"))).toBe(true);
    // Geom built lon-first from the record geo.
    const incident = queries.find((q) => q.text.includes("INSERT INTO incidents"));
    expect(incident?.params).toContain(21.1484);
    expect(incident?.params).toContain(79.084);
  });

  it("writes the embedding vector when the embedder returns one", async () => {
    const { pool, queries } = fakePool();
    await syncRecord(pool, RECORD, { embed: async () => "[0.1,0.2]" });
    const vec = queries.find((q) => q.text.includes("SET embedding"));
    expect(vec?.params).toEqual(["uuid-1", "[0.1,0.2]"]);
  });

  it("skips the vector silently when embeddings are unavailable", async () => {
    const { pool, queries } = fakePool();
    await syncRecord(pool, RECORD, {
      embed: async () => {
        throw new Error("no key");
      },
    });
    expect(queries.some((q) => q.text.includes("SET embedding"))).toBe(false);
  });

  it("skips records without a call id", async () => {
    const { pool } = fakePool();
    expect(await syncRecord(pool, { transcript_original: "x" })).toEqual({ incidentId: null, skipped: true });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("re-syncs update instead of duplicating incidents", async () => {
    const { pool, queries } = fakePool();
    // Second syncRecord call on the same pool sees the "existing" incident.
    await syncRecord(pool, RECORD);
    const second = await syncRecord(pool, RECORD);
    expect(second).toEqual({ incidentId: "uuid-1", skipped: false });
    expect(queries.filter((q) => q.text.includes("UPDATE incidents SET"))).toHaveLength(1);
    expect(queries.filter((q) => q.text.includes("INSERT INTO incidents"))).toHaveLength(1);
  });
});

describe("syncAll", () => {
  it("syncs every record and reports counts", async () => {
    const { pool } = fakePool();
    const store = { getRecords: async () => [RECORD, { transcript_original: "orphan" }] };
    const out = await syncAll(pool, store);
    expect(out.synced).toBe(1);
    expect(out.skipped).toBe(1);
    expect(out.errors).toEqual([]);
  });

  it("continues past single-record failures", async () => {
    const { pool } = fakePool();
    pool.query.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ rows: [], rowCount: 0 });
    const store = { getRecords: async () => [RECORD] };
    const out = await syncAll(pool, store);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("LIVE-1");
  });
});
