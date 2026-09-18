"use client";

import { useCallback, useEffect, useState } from "react";
import { getRecord, listRecords } from "@/lib/api";
import type { IncidentRecord } from "@/lib/types";

export interface IncidentSignal {
  /** Record id returned by POST /api/process-call (Create incident). */
  id: string;
  at: string;
}

interface BriefPanelProps {
  callId: string;
  /** Bumped by the parent after Create incident so the brief refetches. */
  incidentSignal: IncidentSignal | null;
  onRecordChange: (record: IncidentRecord | null) => void;
}

const FIELDS = [
  { key: "summary", label: "Summary", multiline: true },
  { key: "incidentType", label: "Incident type", multiline: false },
  { key: "priority", label: "Priority", multiline: false },
  { key: "callerName", label: "Caller name", multiline: false },
  { key: "people", label: "People involved", multiline: false },
  { key: "injuries", label: "Injuries", multiline: false },
  { key: "threats", label: "Threats / weapons", multiline: false },
  { key: "location", label: "Location", multiline: false },
  { key: "landmark", label: "Landmark", multiline: false },
  { key: "suspect", label: "Suspect", multiline: false },
  { key: "vehicle", label: "Vehicle", multiline: false },
  { key: "risks", label: "Risks", multiline: false },
  { key: "recommendedAction", label: "Recommended action", multiline: true },
  { key: "confidence", label: "Confidence", multiline: false },
  { key: "updatedAt", label: "Updated at", multiline: false },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type BriefValues = Record<FieldKey, string>;

/** AI-sourced values from a record (+ process-call fetch). Never presented as fact — always badged. */
function aiFromRecord(r: IncidentRecord): Partial<BriefValues> {
  const ex = r.extraction ?? {};
  const out: Partial<BriefValues> = {};
  if (ex.summary) out.summary = ex.summary;
  if (ex.incident_type) out.incidentType = ex.incident_type;
  if (r.priority?.level) out.priority = r.priority.level;
  if (ex.caller_name) out.callerName = ex.caller_name;
  if (ex.people_involved !== undefined && ex.people_involved !== null) out.people = String(ex.people_involved);
  if (ex.injuries) out.injuries = ex.injuries;
  if (ex.weapons) out.threats = ex.weapons;
  if (ex.location) out.location = ex.location;
  if (ex.landmark) out.landmark = ex.landmark;
  if (ex.suspect) out.suspect = ex.suspect;
  if (ex.vehicle) out.vehicle = ex.vehicle;
  if (r.created_at) out.updatedAt = r.created_at;
  return out;
}

function briefKey(callId: string): string {
  return `rakshak.console.brief.${callId}`;
}

function loadOverrides(callId: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(briefKey(callId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return { ...(parsed as Record<string, string>) };
    return {};
  } catch {
    return {};
  }
}

/**
 * RIGHT column: AI emergency brief.
 * Sources: linked record (GET /api/records filtered by call) + process-call
 * results. Every field is an inline-editable input persisted to localStorage
 * keyed by call; touched fields are labelled "operator-edited", untouched AI
 * values are badged "AI-generated — verify" and never presented as fact.
 */
export function BriefPanel({ callId, incidentSignal, onRecordChange }: BriefPanelProps): React.ReactElement {
  const [record, setRecord] = useState<IncidentRecord | null>(null);
  const [ai, setAi] = useState<Partial<BriefValues>>({});
  const [overrides, setOverrides] = useState<Record<string, string>>(() => loadOverrides(callId));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLinked = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listRecords({ q: callId, limit: 25 });
      const exact = list.data.find((r) => r.call_id === callId) ?? list.data.find((r) => r.id === callId);
      if (exact) {
        setRecord(exact);
        setAi((prev) => ({ ...aiFromRecord(exact), ...prev }));
        return;
      }
      try {
        const single = await getRecord(callId);
        setRecord(single.data);
        setAi((prev) => ({ ...aiFromRecord(single.data), ...prev }));
        return;
      } catch {
        /* no record addressed by call id — genuine empty state */
      }
      setRecord(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the linked record.");
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    setOverrides(loadOverrides(callId));
    setRecord(null);
    setAi({});
    void fetchLinked();
  }, [callId, fetchLinked]);

  // After Create incident: fetch the fresh process-call record by id.
  useEffect(() => {
    if (!incidentSignal) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getRecord(incidentSignal.id);
        if (cancelled) return;
        setRecord(res.data);
        setAi((prev) => ({ ...aiFromRecord(res.data), updatedAt: incidentSignal.at, ...prev }));
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load the new incident record.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [incidentSignal]);

  useEffect(() => {
    onRecordChange(record);
  }, [record, onRecordChange]);

  const setField = (key: FieldKey, value: string): void => {
    setOverrides((prev) => {
      const next = { ...prev, [key]: value };
      try {
        localStorage.setItem(briefKey(callId), JSON.stringify(next));
      } catch {
        /* private mode — edits still apply for this session */
      }
      return next;
    });
  };

  const valueOf = (key: FieldKey): string => overrides[key] ?? ai[key] ?? "";
  const touched = (key: FieldKey): boolean => key in overrides;
  const hasAi = Object.values(ai).some((v) => v && v.trim());

  return (
    <section aria-label="AI emergency brief" className="flex flex-col gap-3 rounded-xl2 bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">AI emergency brief</h2>
        {record && (
          <span className="rounded-full border border-line bg-paper px-2 py-0.5 font-mono text-xs text-muted" title={`Linked record ${record.id}`}>
            record {record.id.slice(0, 8)}…
          </span>
        )}
      </div>

      {loading && (
        <div className="flex flex-col gap-2" aria-label="Loading brief">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-paper" />
          ))}
        </div>
      )}

      {!loading && error && (
        <div role="alert" className="rounded-lg border border-danger/30 bg-dangerbg px-3 py-2 text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={() => void fetchLinked()} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && !hasAi && (
        <div className="rounded-lg border border-dashed border-line bg-paper px-3 py-4 text-sm text-muted">
          No AI brief yet. It appears after the first processed caller utterance, or use{" "}
          <span className="font-semibold text-ink">Create incident</span> to process the transcript now. Every AI value
          below will be badged for verification.
        </div>
      )}

      {!loading &&
        FIELDS.map((f) => {
          const v = valueOf(f.key);
          const isTouched = touched(f.key);
          const isAi = !isTouched && !!ai[f.key]?.trim();
          const id = `brief-${f.key}`;
          return (
            <div key={f.key}>
              <div className="flex items-center gap-2">
                <label htmlFor={id} className="text-xs font-semibold text-ink">
                  {f.label}
                </label>
                {isAi && (
                  <span className="rounded-full border border-warn/40 bg-warnbg px-1.5 py-px text-[10px] font-semibold text-warn">
                    AI-generated — verify
                  </span>
                )}
                {isTouched && (
                  <span className="rounded-full border border-line bg-paper px-1.5 py-px text-[10px] font-semibold text-muted">
                    operator-edited
                  </span>
                )}
              </div>
              {f.multiline ? (
                <textarea
                  id={id}
                  value={v}
                  onChange={(e) => setField(f.key, e.target.value)}
                  rows={2}
                  placeholder={hasAi ? "" : "—"}
                  className="mt-1 min-h-[44px] w-full rounded-lg border border-line bg-card px-2.5 py-1.5 text-sm text-ink"
                />
              ) : (
                <input
                  id={id}
                  value={v}
                  onChange={(e) => setField(f.key, e.target.value)}
                  placeholder={hasAi ? "" : "—"}
                  className="mt-1 min-h-[40px] w-full rounded-lg border border-line bg-card px-2.5 text-sm text-ink"
                />
              )}
            </div>
          );
        })}

      <p className="text-xs text-faint">
        AI assists; the operator decides. Edits save on this device only (keyed by call).
      </p>
    </section>
  );
}
