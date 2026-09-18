"use client";

/**
 * Call History — server-backed table from GET /api/records (limit/offset paging).
 *
 * HONESTY NOTES:
 * - Records carry NO caller phone numbers and NO duration field (verified
 *   against apps/api/src/store.ts). The caller column therefore shows the
 *   short call_id plus an "Unknown caller" caption (or a masked number if a
 *   future record ever carries caller_number/caller_phone/caller). Duration
 *   shows a record duration field when present, else "—" — never synthesized.
 * - Translation quality = record language_confidence (0..1 share, or 0..100 —
 *   values > 1 are treated as already-percent). Missing/zero renders "—".
 * - Recording availability comes from the list endpoint's slim flags
 *   (has_original_audio / has_translated_audio); playback itself lives on the
 *   /incidents/[id] page, so this column links there.
 * - Server supports q + priority + language filters; date-from/to and sorting
 *   apply CLIENT-SIDE to the loaded page only (the API has no date filter or
 *   sort params). The page total comes from GET /api/records/count, which is
 *   UNFILTERED — labelled as such next to the pager.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowClockwise,
  ArrowSquareOut,
  CaretLeft,
  CaretRight,
  MagnifyingGlass,
  Microphone,
  WarningCircle,
} from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { getRecordCount, listRecords } from "@/lib/api";
import type { IncidentRecord } from "@/lib/types";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

/** Extra record fields the API may return beyond lib/types.ts IncidentRecord. */
interface RecordRow extends IncidentRecord {
  created_at?: string;
  original_language?: string;
  language_confidence?: number;
  timings?: Record<string, number>;
  dispatch_info?: { operator?: string; units?: string } | null;
  has_original_audio?: boolean;
  has_translated_audio?: boolean;
  duration_seconds?: number;
  duration_ms?: number;
  call_duration_seconds?: number;
  caller_number?: string;
  caller_phone?: string;
  caller?: string;
}

const PRIORITY_RANK: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

function priorityRank(level: string | undefined): number {
  return PRIORITY_RANK[(level ?? "").toUpperCase()] ?? 4;
}

/** Caller privacy: records have no numbers today — mask defensively if one appears. */
function callerDisplay(r: RecordRow): { primary: string; masked: string | null } {
  const raw = r.caller_number ?? r.caller_phone ?? (typeof r.caller === "string" ? r.caller : undefined);
  const digits = raw?.replace(/\D/g, "") ?? "";
  if (digits) return { primary: `\u2022\u2022\u2022 \u2022\u2022\u2022 ${digits.slice(-4)}`, masked: raw ?? null };
  const short = (r.call_id ?? r.id ?? "").slice(0, 12) || "Unknown";
  return { primary: short, masked: null };
}

function durationDisplay(r: RecordRow): string {
  const secs =
    r.duration_seconds ?? r.call_duration_seconds ?? (r.duration_ms != null ? r.duration_ms / 1000 : undefined);
  if (typeof secs === "number" && Number.isFinite(secs) && secs >= 0) {
    const s = Math.floor(secs);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  return "—";
}

function confidenceDisplay(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return "—";
  const pct = v > 1 ? Math.round(v) : Math.round(v * 100);
  return `${Math.min(100, pct)}%`;
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function PriorityBadge({ level }: { level: string | undefined }) {
  const p = (level ?? "").toUpperCase();
  const color =
    p === "CRITICAL" || p === "HIGH"
      ? "bg-dangerbg text-danger"
      : p === "MEDIUM"
        ? "bg-warnbg text-warn"
        : "bg-paper text-muted";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      <WarningCircle size={14} aria-hidden /> {p ? p.charAt(0) + p.slice(1).toLowerCase() : "—"}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="space-y-2" aria-label="Loading call history">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl2 border border-line bg-card p-4">
          <div className="h-4 w-2/3 rounded bg-paper" />
          <div className="mt-2 h-3 w-1/3 rounded bg-paper" />
        </div>
      ))}
    </div>
  );
}

export default function HistoryPage() {
  const [page, setPage] = useState(0);
  const [qInput, setQInput] = useState("");
  const [q, setQ] = useState("");
  const [priority, setPriority] = useState("ALL");
  const [language, setLanguage] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState<"time" | "priority">("time");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  /* Debounce free-text search before it hits the server. */
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(qInput.trim());
      setPage(0);
    }, 400);
    return () => clearTimeout(t);
  }, [qInput]);

  const offset = page * PAGE_SIZE;
  const recordsQuery = useQuery({
    queryKey: ["history", page, q, priority, language],
    queryFn: () =>
      listRecords({
        q: q || undefined,
        priority: priority !== "ALL" ? priority : undefined,
        language: language.trim() || undefined,
        limit: PAGE_SIZE,
        offset,
      }),
    placeholderData: keepPreviousData,
  });
  const countQuery = useQuery({ queryKey: ["history-total"], queryFn: getRecordCount });

  const rows = useMemo(() => {
    const data = (recordsQuery.data?.data ?? []) as RecordRow[];
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : NaN;
    const to = dateTo ? new Date(`${dateTo}T00:00:00`).getTime() + 24 * 60 * 60 * 1000 : NaN;
    const kept = data.filter((r) => {
      const t = r.created_at ? new Date(r.created_at).getTime() : NaN;
      if (Number.isFinite(from) && (!Number.isFinite(t) || t < from)) return false;
      if (Number.isFinite(to) && (!Number.isFinite(t) || t >= to)) return false;
      return true;
    });
    const dir = sortDir === "desc" ? -1 : 1;
    return [...kept].sort((a, b) => {
      if (sortKey === "priority") {
        const d = priorityRank(a.priority?.level) - priorityRank(b.priority?.level);
        if (d !== 0) return d * dir;
      }
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return (ta - tb) * dir;
    });
  }, [recordsQuery.data, dateFrom, dateTo, sortKey, sortDir]);

  const total = countQuery.data?.data?.count;
  const pageCount = typeof total === "number" ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : null;
  const hasNext = rows.length === PAGE_SIZE;
  const isError = recordsQuery.isError;

  return (
    <Shell section="history" title="Call History">
      {/* Filters */}
      <div className="mb-4 rounded-xl2 border border-line bg-card p-4 shadow-card">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="flex items-center gap-2 rounded-xl2 border border-line bg-card px-3 py-2 sm:col-span-2">
            <MagnifyingGlass size={16} className="shrink-0 text-muted" aria-hidden />
            <span className="sr-only">Search records</span>
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search id, transcript, place…"
              className="w-full bg-transparent text-sm text-ink placeholder:text-faint focus:outline-none"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">Priority (server)</span>
            <select
              value={priority}
              onChange={(e) => {
                setPriority(e.target.value);
                setPage(0);
              }}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            >
              {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
                <option key={p} value={p}>
                  {p === "ALL" ? "All" : p.charAt(0) + p.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">Language (server)</span>
            <input
              value={language}
              onChange={(e) => {
                setLanguage(e.target.value);
                setPage(0);
              }}
              placeholder="e.g. Marathi"
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-faint"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">From (page only)</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-muted">To (page only)</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-full rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink"
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-xs font-medium text-muted">Sort</span>
          <div className="inline-flex overflow-hidden rounded-xl2 border border-line" role="group" aria-label="Sort records">
            {(["time", "priority"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setSortKey(k)}
                aria-pressed={sortKey === k}
                className={`px-3 py-1.5 text-sm ${sortKey === k ? "bg-primary-soft font-medium text-primary-dark" : "text-ink hover:bg-paper"}`}
              >
                {k === "time" ? "Time" : "Priority"}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            className="rounded-xl2 border border-line bg-card px-3 py-1.5 text-sm text-ink hover:bg-paper"
            aria-label={`Sort direction ${sortDir === "desc" ? "descending" : "ascending"}`}
          >
            {sortDir === "desc" ? "Newest first" : "Oldest first"}
          </button>
          <span className="text-xs text-faint">Date filter + sorting apply to the loaded page only.</span>
        </div>
      </div>

      {/* Body states */}
      {recordsQuery.isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <div role="alert" className="rounded-xl2 border border-line bg-dangerbg p-6 text-center">
          <p className="text-sm font-medium text-danger">Couldn&apos;t load call history.</p>
          <p className="mt-1 text-xs text-danger">
            {recordsQuery.error instanceof Error ? recordsQuery.error.message : "Network error"}
          </p>
          <button
            type="button"
            onClick={() => recordsQuery.refetch()}
            className="mt-3 inline-flex items-center gap-1.5 rounded-xl2 bg-danger px-3 py-2 text-sm font-medium text-white"
          >
            <ArrowClockwise size={16} aria-hidden /> Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl2 border border-dashed border-line bg-card p-10 text-center">
          <p className="text-sm font-medium text-ink">No records match</p>
          <p className="mt-1 text-xs text-muted">Try widening the search, clearing the date range, or going back a page.</p>
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden overflow-x-auto rounded-xl2 border border-line bg-card shadow-card md:block">
            <table className="w-full min-w-250 text-left text-sm">
              <caption className="sr-only">Call history records</caption>
              <thead>
                <tr className="border-b border-line text-xs text-muted">
                  <th scope="col" className="px-4 py-3 font-medium">Time</th>
                  <th scope="col" className="px-4 py-3 font-medium">Caller</th>
                  <th scope="col" className="px-4 py-3 font-medium">Language</th>
                  <th scope="col" className="px-4 py-3 font-medium">Operator</th>
                  <th scope="col" className="px-4 py-3 font-medium">Duration</th>
                  <th scope="col" className="px-4 py-3 font-medium">Priority</th>
                  <th scope="col" className="px-4 py-3 font-medium">Incident</th>
                  <th scope="col" className="px-4 py-3 font-medium">Quality</th>
                  <th scope="col" className="px-4 py-3 font-medium">Recording</th>
                  <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">Details</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const caller = callerDisplay(r);
                  const hasAudio = Boolean(r.has_original_audio || r.has_translated_audio);
                  return (
                    <tr key={r.id} className="border-b border-line last:border-0 hover:bg-paper">
                      <td className="whitespace-nowrap px-4 py-3 text-ink">{formatTime(r.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="font-mono text-ink">{caller.primary}</div>
                        {caller.masked == null && <div className="text-xs text-faint">Unknown caller</div>}
                      </td>
                      <td className="px-4 py-3 text-ink">{r.original_language || "—"}</td>
                      <td className="px-4 py-3 text-ink">{r.dispatch_info?.operator || "—"}</td>
                      <td className="px-4 py-3 text-ink">{durationDisplay(r)}</td>
                      <td className="px-4 py-3"><PriorityBadge level={r.priority?.level} /></td>
                      <td className="px-4 py-3">
                        {r.dispatched ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-okbg px-2 py-0.5 text-xs font-medium text-ok">
                            Dispatched
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted">
                            Recorded
                          </span>
                        )}
                        {r.extraction?.incident_type && (
                          <div className="mt-0.5 text-xs text-muted">{r.extraction.incident_type}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink">{confidenceDisplay(r.language_confidence)}</td>
                      <td className="px-4 py-3">
                        {hasAudio ? (
                          <Link
                            href={`/incidents/${encodeURIComponent(r.id)}`}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary-dark hover:underline"
                          >
                            <Microphone size={14} aria-hidden /> Play on incident page
                          </Link>
                        ) : (
                          <span className="text-xs text-faint">No recording</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">
                        <Link
                          href={`/incidents/${encodeURIComponent(r.id)}`}
                          className="inline-flex items-center gap-1 text-sm font-medium text-primary-dark hover:underline"
                        >
                          View details <ArrowSquareOut size={14} aria-hidden />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <ul className="space-y-3 md:hidden">
            {rows.map((r) => {
              const caller = callerDisplay(r);
              const hasAudio = Boolean(r.has_original_audio || r.has_translated_audio);
              return (
                <li key={r.id} className="rounded-xl2 border border-line bg-card p-4 shadow-card">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-ink">{caller.primary}</span>
                    <PriorityBadge level={r.priority?.level} />
                  </div>
                  <dl className="mt-2 space-y-1 text-sm text-ink">
                    <div className="flex justify-between gap-2"><dt className="text-muted">Time</dt><dd>{formatTime(r.created_at)}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Language</dt><dd>{r.original_language || "—"}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Operator</dt><dd>{r.dispatch_info?.operator || "—"}</dd></div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Duration</dt><dd>{durationDisplay(r)}</dd></div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">Incident</dt>
                      <dd>{r.dispatched ? "Dispatched" : "Recorded"}{r.extraction?.incident_type ? ` · ${r.extraction.incident_type}` : ""}</dd>
                    </div>
                    <div className="flex justify-between gap-2"><dt className="text-muted">Quality</dt><dd>{confidenceDisplay(r.language_confidence)}</dd></div>
                    <div className="flex justify-between gap-2">
                      <dt className="text-muted">Recording</dt>
                      <dd>
                        {hasAudio ? (
                          <Link href={`/incidents/${encodeURIComponent(r.id)}`} className="font-medium text-primary-dark hover:underline">
                            Play on incident page
                          </Link>
                        ) : (
                          "No recording"
                        )}
                      </dd>
                    </div>
                  </dl>
                  <Link
                    href={`/incidents/${encodeURIComponent(r.id)}`}
                    className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-primary-dark hover:underline"
                  >
                    View details <ArrowSquareOut size={14} aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>

          {/* Pagination */}
          <nav aria-label="History pages" className="mt-4 flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted">
              Page {page + 1}
              {pageCount != null && ` of ${pageCount}`} · showing {rows.length} record{rows.length === 1 ? "" : "s"} on
              this page
              {typeof total === "number" && ` · ${total} total records (unfiltered)`}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={page === 0 || recordsQuery.isFetching}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="inline-flex items-center gap-1 rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink hover:bg-paper disabled:opacity-50"
              >
                <CaretLeft size={16} aria-hidden /> Prev
              </button>
              <button
                type="button"
                disabled={!hasNext || recordsQuery.isFetching}
                onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-1 rounded-xl2 border border-line bg-card px-3 py-2 text-sm text-ink hover:bg-paper disabled:opacity-50"
              >
                Next <CaretRight size={16} aria-hidden />
              </button>
            </div>
          </nav>
        </>
      )}
    </Shell>
  );
}
