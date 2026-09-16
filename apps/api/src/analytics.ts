// Shared analytics computation — both persistence backends (file, Postgres)
// must report identical numbers. Tested by pgstore/file equivalence in
// pgstore.test.ts. Pure function: rows in, summary out.

export type Rec = { [key: string]: any };

export type VerificationStatus = "unverified" | "multiple_reports" | "corroborated";

/** Verification ladder (§19): total includes the original call report, so the
 *  first external source already means multiple_reports. officially_confirmed
 *  is never derived here — operators set it through dispatch only. */
export function verificationStatus(totalReports: number): VerificationStatus {
  if (totalReports >= 4) return "corroborated";
  if (totalReports >= 2) return "multiple_reports";
  return "unverified";
}

export function computeAnalytics(records: Rec[]): Rec {
  if (!records.length) {
    return {
      total_records: 0,
      priority_breakdown: { HIGH: 0, MEDIUM: 0, LOW: 0 },
      language_distribution: {},
      incident_types: {},
      location_distribution: {},
      weapon_stats: { present: 0, not_present: 0, types: {} },
      immediate_danger_count: 0,
      dispatched_count: 0,
      average_latencies: { speech_ms: 0, translate_ms: 0, extract_ms: 0, tts_ms: 0, total_ms: 0 },
      caller_states: {},
    };
  }
  const prio: Record<string, number> = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  const langs: Record<string, number> = {};
  const incidents: Record<string, number> = {};
  const locs: Record<string, number> = {};
  const states: Record<string, number> = {};
  const wtypes: Record<string, number> = {};
  let weaponPresent = 0,
    danger = 0,
    dispatched = 0;
  let speech = 0,
    speechN = 0,
    trans = 0,
    transN = 0,
    ext = 0,
    extN = 0,
    tts = 0,
    ttsN = 0,
    total = 0,
    totalN = 0;
  for (const r of records) {
    const p = String(r.priority?.level ?? "MEDIUM").toUpperCase();
    prio[p] = (prio[p] ?? 0) + 1;
    const lang = r.original_language ?? "Unknown";
    langs[lang] = (langs[lang] ?? 0) + 1;
    const inc = r.extraction?.incident_type;
    if (inc && inc !== "Unknown") incidents[inc] = (incidents[inc] ?? 0) + 1;
    const loc = r.extraction?.location;
    if (loc && loc !== "Not identified") locs[loc] = (locs[loc] ?? 0) + 1;
    const st = r.extraction?.caller_state ?? "unknown";
    states[st] = (states[st] ?? 0) + 1;
    if (r.extraction?.weapon_mentioned) {
      weaponPresent += 1;
      const wt = r.extraction?.weapon_type ?? "unspecified";
      wtypes[wt] = (wtypes[wt] ?? 0) + 1;
    }
    if (r.extraction?.immediate_danger) danger += 1;
    if (r.dispatched) dispatched += 1;
    const t = r.timings ?? {};
    if (t.speech_ms) {
      speech += t.speech_ms;
      speechN += 1;
    }
    if (t.translate_ms) {
      trans += t.translate_ms;
      transN += 1;
    }
    if (t.extract_ms) {
      ext += t.extract_ms;
      extN += 1;
    }
    if (t.tts_ms) {
      tts += t.tts_ms;
      ttsN += 1;
    }
    if (t.total_ms) {
      total += t.total_ms;
      totalN += 1;
    }
  }
  return {
    total_records: records.length,
    priority_breakdown: prio,
    language_distribution: langs,
    incident_types: incidents,
    location_distribution: locs,
    weapon_stats: { present: weaponPresent, not_present: records.length - weaponPresent, types: wtypes },
    immediate_danger_count: danger,
    dispatched_count: dispatched,
    caller_states: states,
    average_latencies: {
      speech_ms: speechN ? Math.round(speech / speechN) : 0,
      translate_ms: transN ? Math.round(trans / transN) : 0,
      extract_ms: extN ? Math.round(ext / extN) : 0,
      tts_ms: ttsN ? Math.round(tts / ttsN) : 0,
      total_ms: totalN ? Math.round(total / totalN) : 0,
    },
  };
}
