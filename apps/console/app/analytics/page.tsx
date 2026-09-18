"use client";

/**
 * Analytics — ONLY real numbers from GET /api/analytics (+ GET
 * /api/metrics/latency for the percentile table). Shapes verified read-only
 * against apps/api/src/analytics.ts, apps/api/src/events.ts and
 * apps/api/src/app.ts; nothing here is modified or mocked.
 *
 * - Stat cards: total_records, priority_breakdown, immediate_danger_count,
 *   dispatched_count, average_latencies.total_ms — straight from /api/analytics.
 * - Latency table: avg/p50/p95 (+n) per stage from /api/metrics/latency
 *   ({speech,language,translate,extract,priority,tts,total}_ms). If that
 *   endpoint fails, an error-with-retry shows and the analytics averages still
 *   stand in the cards (labelled as means).
 * - Records-per-day: computed client-side from a BOUNDED fetch of the most
 *   recent 200 records (limit 200) — the bound is stated in the UI.
 * - No chart library, no fabricated series. Every figure names its source.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowClockwise,
  ChartBar,
  CheckCircle,
  Siren,
  Timer,
  WarningCircle,
} from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { API_URL, getAnalytics, listRecords } from "@/lib/api";
import type { IncidentRecord } from "@/lib/types";

interface AnalyticsData {
  total_records?: number;
  priority_breakdown?: Record<string, number>;
  language_distribution?: Record<string, number>;
  incident_types?: Record<string, number>;
  immediate_danger_count?: number;
  dispatched_count?: number;
  average_latencies?: Record<string, number>;
}

interface LatencyStage {
  n: number;
  avg: number;
  p50: number;
  p95: number;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function fmtMs(v: number): string {
  return `${Math.round(v).toLocaleString("en-IN")} ms`;
}

const STAGE_LABELS: Record<string, string> = {
  speech_ms: "Speech-to-text",
  language_ms: "Language ID",
  translate_ms: "Translation",
  extract_ms: "Extraction",
  priority_ms: "Priority scoring",
  tts_ms: "Text-to-speech",
  total_ms: "End-to-end",
};
const STAGE_ORDER = ["speech_ms", "language_ms", "translate_ms", "extract_ms", "priority_ms", "tts_ms", "total_ms"];

async function getLatency(): Promise<{ data: Record<string, LatencyStage>; count: number }> {
  const res = await fetch(`${API_URL}/api/metrics/latency`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Latency metrics unavailable (${res.status})`);
  const body = (await res.json()) as { status: string; data: Record<string, LatencyStage>; count?: number };
  return { data: body.data ?? {}, count: num(body.count) };
}

function topEntries(obj: Record<string, number> | undefined, n: number): [string, number][] {
  if (!obj) return [];
  return Object.entries(obj)
    .filter(([, v]) => typeof v === "number" && v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

function StatCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl2 border border-line bg-card p-4 shadow-card">
      <div className="flex items-center gap-2 text-muted">
        <span aria-hidden>{icon}</span>
        <p className="text-xs font-medium uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-semibold text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">{sub}</p>
    </div>
  );
}

function SkeletonCards() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Loading analytics">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl2 border border-line bg-card p-4">
          <div className="h-3 w-1/2 rounded bg-paper" />
          <div className="mt-3 h-7 w-1/3 rounded bg-paper" />
        </div>
      ))}
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl2 border border-line bg-dangerbg p-6 text-center">
      <p className="inline-flex items-center gap-1.5 text-sm font-medium text-danger">
        <WarningCircle size={16} aria-hidden /> {message}
      </p>
      <div>
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 inline-flex items-center gap-1.5 rounded-xl2 bg-danger px-3 py-2 text-sm font-medium text-white"
        >
          <ArrowClockwise size={16} aria-hidden /> Retry
        </button>
      </div>
    </div>
  );
}

export default function AnalyticsPage() {
  const analyticsQuery = useQuery({ queryKey: ["analytics"], queryFn: getAnalytics });
  const latencyQuery = useQuery({ queryKey: ["latency"], queryFn: getLatency });
  const recentQuery = useQuery({
    queryKey: ["analytics-recent-200"],
    queryFn: () => listRecords({ limit: 200 }),
    staleTime: 30_000,
  });

  const data = (analyticsQuery.data?.data ?? {}) as AnalyticsData;
  const total = num(data.total_records);
  const dispatched = num(data.dispatched_count);
  const danger = num(data.immediate_danger_count);
  const avgTotal = num(data.average_latencies?.total_ms);
  const prioEntries = useMemo(() => topEntries(data.priority_breakdown, 10), [analyticsQuery.data]);
  const langEntries = useMemo(() => topEntries(data.language_distribution, 8), [analyticsQuery.data]);
  const incidentEntries = useMemo(() => topEntries(data.incident_types, 8), [analyticsQuery.data]);

  const perDay = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of (recentQuery.data?.data ?? []) as IncidentRecord[]) {
      const day = (r.created_at ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 14);
  }, [recentQuery.data]);

  return (
    <Shell section="analytics" title="Analytics">
      {analyticsQuery.isLoading ? (
        <SkeletonCards />
      ) : analyticsQuery.isError ? (
        <ErrorCard
          message={`Couldn't load analytics: ${analyticsQuery.error instanceof Error ? analyticsQuery.error.message : "network error"}`}
          onRetry={() => analyticsQuery.refetch()}
        />
      ) : total === 0 ? (
        <div className="rounded-xl2 border border-dashed border-line bg-card p-10 text-center">
          <p className="text-sm font-medium text-ink">No analytics yet</p>
          <p className="mt-1 text-xs text-muted">
            The API reports zero records. Figures will appear here once calls are processed.
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Stat cards — every value from GET /api/analytics */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={<ChartBar size={16} />}
              label="Total records"
              value={total.toLocaleString("en-IN")}
              sub="total_records · /api/analytics"
            />
            <StatCard
              icon={<CheckCircle size={16} />}
              label="Dispatched"
              value={dispatched.toLocaleString("en-IN")}
              sub="dispatched_count · /api/analytics"
            />
            <StatCard
              icon={<Siren size={16} />}
              label="Immediate danger"
              value={danger.toLocaleString("en-IN")}
              sub="immediate_danger_count · /api/analytics"
            />
            <StatCard
              icon={<Timer size={16} />}
              label="Avg end-to-end"
              value={avgTotal > 0 ? fmtMs(avgTotal) : "—"}
              sub="average_latencies.total_ms · mean"
            />
          </div>

          {/* Priority split — every key the API returns (HIGH/MEDIUM/LOW+). */}
          <section aria-label="Priority split" className="rounded-xl2 border border-line bg-card p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">Priority split</h2>
            <p className="text-xs text-muted">priority_breakdown · /api/analytics</p>
            {prioEntries.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No priority data.</p>
            ) : (
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {prioEntries.map(([level, count]) => (
                  <li key={level} className="rounded-xl2 bg-paper px-3 py-2">
                    <p className="text-xs font-medium text-muted">{level}</p>
                    <p className="text-lg font-semibold text-ink">{count.toLocaleString("en-IN")}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Latency percentiles */}
          <section aria-label="Latency" className="rounded-xl2 border border-line bg-card p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">Pipeline latency</h2>
            <p className="text-xs text-muted">avg / p50 / p95 per stage · GET /api/metrics/latency</p>
            {latencyQuery.isLoading ? (
              <div className="mt-3 animate-pulse space-y-2" aria-label="Loading latency">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="h-4 rounded bg-paper" />
                ))}
              </div>
            ) : latencyQuery.isError ? (
              <div className="mt-3">
                <ErrorCard
                  message={`Couldn't load latency percentiles: ${latencyQuery.error instanceof Error ? latencyQuery.error.message : "network error"}`}
                  onRetry={() => latencyQuery.refetch()}
                />
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-135 text-left text-sm">
                  <caption className="sr-only">Latency percentiles per pipeline stage</caption>
                  <thead>
                    <tr className="border-b border-line text-xs text-muted">
                      <th scope="col" className="py-2 pr-4 font-medium">Stage</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Samples</th>
                      <th scope="col" className="py-2 pr-4 font-medium">Avg</th>
                      <th scope="col" className="py-2 pr-4 font-medium">p50</th>
                      <th scope="col" className="py-2 font-medium">p95</th>
                    </tr>
                  </thead>
                  <tbody>
                    {STAGE_ORDER.map((stage) => {
                      const s = latencyQuery.data?.data[stage];
                      return (
                        <tr key={stage} className="border-b border-line last:border-0">
                          <th scope="row" className="py-2 pr-4 font-normal text-ink">
                            {STAGE_LABELS[stage] ?? stage}
                          </th>
                          <td className="py-2 pr-4 text-ink">{s ? num(s.n).toLocaleString("en-IN") : "—"}</td>
                          <td className="py-2 pr-4 text-ink">{s && s.n > 0 ? fmtMs(s.avg) : "—"}</td>
                          <td className="py-2 pr-4 text-ink">{s && s.n > 0 ? fmtMs(s.p50) : "—"}</td>
                          <td className="py-2 text-ink">{s && s.n > 0 ? fmtMs(s.p95) : "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Records per day (bounded) */}
          <section aria-label="Records per day" className="rounded-xl2 border border-line bg-card p-4 shadow-card">
            <h2 className="text-sm font-semibold text-ink">Records per day</h2>
            <p className="text-xs text-muted">
              Counted client-side from the most recent 200 records only (bounded fetch, newest 14 days shown).
            </p>
            {recentQuery.isLoading ? (
              <div className="mt-3 animate-pulse space-y-2" aria-label="Loading recent records">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="h-4 rounded bg-paper" />
                ))}
              </div>
            ) : recentQuery.isError ? (
              <div className="mt-3">
                <ErrorCard
                  message={`Couldn't load recent records: ${recentQuery.error instanceof Error ? recentQuery.error.message : "network error"}`}
                  onRetry={() => recentQuery.refetch()}
                />
              </div>
            ) : perDay.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No dated records in the recent window.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line">
                {perDay.map(([day, count]) => (
                  <li key={day} className="flex items-center justify-between py-2 text-sm">
                    <span className="text-ink">{day}</span>
                    <span className="font-semibold text-ink">
                      {count} record{count === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Breakdowns */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <section aria-label="Top languages" className="rounded-xl2 border border-line bg-card p-4 shadow-card">
              <h2 className="text-sm font-semibold text-ink">Top languages</h2>
              <p className="text-xs text-muted">language_distribution · /api/analytics</p>
              {langEntries.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No language data.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {langEntries.map(([lang, count]) => (
                    <li key={lang} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="text-ink">{lang}</span>
                      <span className="font-semibold text-ink">{count.toLocaleString("en-IN")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Top incident types" className="rounded-xl2 border border-line bg-card p-4 shadow-card">
              <h2 className="text-sm font-semibold text-ink">Top incident types</h2>
              <p className="text-xs text-muted">incident_types · /api/analytics</p>
              {incidentEntries.length === 0 ? (
                <p className="mt-2 text-sm text-muted">No incident-type data.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {incidentEntries.map(([type, count]) => (
                    <li key={type} className="flex items-center justify-between py-1.5 text-sm">
                      <span className="text-ink">{type}</span>
                      <span className="font-semibold text-ink">{count.toLocaleString("en-IN")}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </div>
      )}
    </Shell>
  );
}
