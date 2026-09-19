// Autonomous Option-2 self-test: full AI pipeline, no phones, no humans.
// Exits 0 only if every check passes. Cleans up its own test record.
// Usage: npm run selftest [-- API at :3001]
//        API_URL=http://127.0.0.1:3141 npm run selftest
const B = (process.env.API_URL ?? "http://127.0.0.1:3001").replace(/\/$/, "");
const results = [];
let skipped = 0;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
// SKIP (not FAIL) when the environment lacks live backends: the harness must
// stay green offline and only assert logic. Capabilities come from /api/health.
function skip(name, detail = "") {
  skipped++;
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`SKIP   ${name}${detail ? "  — " + detail : ""}`);
}
const j = async (r) => {
  try {
    return await r.json();
  } catch {
    return null;
  }
};

try {
  // 1. Health (+ capability probe for SKIP decisions below)
  let r = await fetch(`${B}/api/health`);
  let b = await j(r);
  const pg = b?.store === "postgres";
  const sarvam = b?.sarvam === true;
  if (r.status === 200 && b?.status === "ok" && pg) {
    check("health", true, JSON.stringify(b));
  } else if (r.status === 200 && b?.status === "ok") {
    skip("health", `file store (${b?.store}); postgres-only checks still run where backends allow`);
  } else {
    check("health", false, JSON.stringify(b));
  }

  // 2. process-call (Marathi)
  r = await fetch(`${B}/api/process-call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: "Selftest nagar javal ek dukanat aag lagli aahe, 1 kamgar adakla aahe",
      language: "Marathi",
    }),
  });
  b = await j(r);
  const rec = b?.data;
  const okCall =
    r.status === 200 && b?.status === "success" && !!rec?.id && !!rec?.extraction?.incident_type && !!rec?.priority?.level;
  check("process-call", okCall, `${rec?.id} type=${rec?.extraction?.incident_type} pri=${rec?.priority?.level}`);
  const id = rec?.id;
  const callId = rec?.call_id;
  if (!id) throw new Error("no record id, aborting");

  // 3. records round-trip
  r = await fetch(`${B}/api/records/${id}`);
  b = await j(r);
  check("get-record", r.status === 200 && b?.data?.id === id);
  r = await fetch(`${B}/api/analytics`);
  b = await j(r);
  check("analytics", r.status === 200 && typeof b?.data?.total_records === "number");
  r = await fetch(`${B}/api/metrics/latency`);
  check("latency-metrics", r.status === 200);

  // 4. TTS -> STT roundtrip (needs Sarvam credentials)
  if (!sarvam) {
    skip("tts-stt-roundtrip", "no Sarvam key on this backend");
  } else {
    r = await fetch(`${B}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Selftest madat pathva", language_code: "mr-IN" }),
    });
    b = await j(r);
    const audio = (b?.data?.audio_base64 ?? "").split(",", 2)[1] ?? "";
    let stt = "";
    if (audio) {
      const buf = Buffer.from(audio, "base64");
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: "audio/wav" }), "selftest.wav");
      r = await fetch(`${B}/api/process-audio`, { method: "POST", body: fd });
      b = await j(r);
      stt = b?.data?.transcript_original ?? "";
    }
    check("tts-stt-roundtrip", stt.trim().length > 0, stt.slice(0, 60));
  }

  // 5. Verification ledger
  r = await fetch(`${B}/api/incidents/${encodeURIComponent(callId)}/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ report_id: "SELFTEST-R1", source: "selftest", title: "Selftest fire", correlation_score: 0.7, signals: ["t"] }),
  });
  b = await j(r);
  check("ledger-post", r.status === 200 && b?.data?.verification === "multiple_reports", JSON.stringify(b?.data));
  r = await fetch(`${B}/api/incidents/${encodeURIComponent(callId)}/verification`);
  b = await j(r);
  check("ledger-get", r.status === 200 && b?.data?.reports === 2);

  // 6. Audit + translate + nearby (graceful on record-store DBs) + events
  r = await fetch(`${B}/api/audit?limit=3`);
  b = await j(r);
  check("audit", r.status === 200 && Array.isArray(b?.data));
  if (!sarvam) {
    skip("translate", "no Sarvam key on this backend");
  } else {
    r = await fetch(`${B}/api/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "aag lagli aahe", target_language_code: "en-IN" }),
    });
    b = await j(r);
    check("translate", r.status === 200 && (b?.data?.translated_text ?? "").length > 0, b?.data?.translated_text);
  }
  r = await fetch(`${B}/api/incidents/nearby?lat=21.14&lon=79.07&radiusKm=25&limit=3`);
  b = await j(r);
  const nearbyOk =
    (r.status === 200 && Array.isArray(b?.data)) ||
    (r.status === 400 && /PostGIS/.test(b?.message ?? ""));
  check("nearby", nearbyOk, `http=${r.status} count=${b?.count ?? b?.message ?? "?"}`);
  r = await fetch(`${B}/api/events/recent?limit=10`);
  b = await j(r);
  const names = (b?.data ?? []).map((e) => e.name);
  check("event-bus", names.includes("incident.created"), names.slice(0, 4).join(","));

  // 7. Cleanup
  r = await fetch(`${B}/api/records/${id}`, { method: "DELETE" });
  check("cleanup-delete", r.status === 200);
  r = await fetch(`${B}/api/records/${id}`);
  check("cleanup-gone", r.status === 404);
} catch (e) {
  check("harness", false, String(e?.message ?? e));
}

const failed = results.filter((x) => !x.ok);
console.log(`\nSCOREBOARD: ${results.length - failed.length - skipped}/${results.length} passed, ${skipped} skipped`);
process.exit(failed.length ? 1 : 0);
