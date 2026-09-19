"use client";

/**
 * Operator home: welcome, availability, honest live stats, recent activity,
 * system health and a quickstart panel for new operators.
 *
 * No fake numbers: every stat traces to the live event feed (deriveCalls) or
 * the records API. When there is nothing to count, cards show 0 with a
 * source note or an explicit empty state.
 */

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle,
  ClockCounterClockwise,
  FolderOpen,
  Info,
  Microphone,
  PhoneCall,
  Warning,
  WarningCircle,
  WifiHigh,
  WifiSlash,
} from "@phosphor-icons/react";
import { Shell, useAvailability, type ShellAlert } from "@/components/shell";
import { useMounted } from "@/lib/mounted";
import { Alert, Badge, Card, CardHead, EmptyState, Select, Skeleton, Stat } from "@/components/ui";
import { deriveCalls, useLiveEvents, type LiveEvent } from "@/lib/live";
import { getHealth, getSession, listRecords } from "@/lib/api";
import { loadPrefs } from "@/lib/prefs";

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatLag(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function str(payload: Record<string, unknown> | undefined, key: string): string {
  const v = payload?.[key];
  return typeof v === "string" ? v : "";
}

function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return `${text.slice(0, n - 1).trimEnd()}…`;
}

/** One-line human summary of a live event for the activity timeline. */
function humanizeEvent(e: LiveEvent): { title: string; detail: string } {
  const p = e.payload;
  switch (e.name) {
    case "call.started": {
      const from = str(p, "caller") || str(p, "from") || "unknown caller";
      return { title: "Call started", detail: `from ${from} · ${truncate(e.callId, 24)}` };
    }
    case "call.answered":
      return { title: "Call answered", detail: truncate(e.callId, 32) };
    case "operator.waiting": {
      const id = str(p, "operator_id") || e.callId;
      return { title: "Operator waiting", detail: truncate(id, 32) };
    }
    case "operator.joined": {
      const id = str(p, "call_id") || e.callId;
      return { title: "Operator joined", detail: truncate(id, 32) };
    }
    case "transcript.partial": {
      const lang = str(p, "language") || "unknown language";
      const text = str(p, "original_text");
      return { title: `Listening… (${lang})`, detail: text ? truncate(text, 110) : truncate(e.callId, 32) };
    }
    case "transcript.final": {
      const lang = str(p, "language") || "unknown language";
      const text = str(p, "original_text");
      return { title: `Caller said · ${lang}`, detail: text ? truncate(text, 110) : truncate(e.callId, 32) };
    }
    case "incident.created": {
      const type = str(p, "incident_type") || "incident";
      const loc = str(p, "location");
      return { title: `Incident recorded · ${type}`, detail: loc || truncate(e.callId, 32) };
    }
    case "priority.updated": {
      const level = str(p, "level") || "updated";
      return { title: `Priority → ${level}`, detail: truncate(e.callId, 32) };
    }
    case "translation.toggled": {
      const on = p?.enabled === true;
      return { title: on ? "Translation on" : "Translation off", detail: truncate(str(p, "call_id") || e.callId, 32) };
    }
    case "call.ended": {
      const reason = str(p, "reason");
      return { title: "Call ended", detail: reason || truncate(e.callId, 32) };
    }
    default:
      return { title: e.name, detail: truncate(e.callId, 32) };
  }
}

type MicPermission = "granted" | "denied" | "prompt" | "unknown";

export default function HomePage() {
  const feed = useLiveEvents();
  // Relative times depend on the client clock: render placeholders until
  // hydration completes so server and client HTML agree exactly.
  const mounted = useMounted();
  const { calls, waitingOperators } = React.useMemo(() => deriveCalls(feed.events), [feed.events]);
  const { availability, setAvailability } = useAvailability();

  const [operatorName, setOperatorName] = React.useState("operator");
  const [audioInputId, setAudioInputId] = React.useState("default");
  const [micPermission, setMicPermission] = React.useState<MicPermission>("unknown");

  React.useEffect(() => {
    setOperatorName(getSession()?.name ?? "operator");
    try {
      setAudioInputId(loadPrefs().audioInputId);
    } catch {
      /* keep default */
    }
    let cancelled = false;
    const perms = navigator.permissions as
      | { query?: (desc: { name: string }) => Promise<{ state: string }> }
      | undefined;
    if (perms?.query) {
      perms
        .query({ name: "microphone" })
        .then((r) => {
          if (!cancelled && (r.state === "granted" || r.state === "denied" || r.state === "prompt")) {
            setMicPermission(r.state);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const recordsQuery = useQuery({
    queryKey: ["records", "recent-home"],
    queryFn: () => listRecords({ limit: 50 }),
  });
  const healthQuery = useQuery({ queryKey: ["health-home"], queryFn: getHealth });

  const records = React.useMemo(() => recordsQuery.data?.data ?? [], [recordsQuery.data]);
  const sarvam = healthQuery.data?.sarvam;

  /* ---- honest stats: every value traces to the feed or the records API ---- */
  const active = calls.filter((c) => c.status !== "ended");
  const unassigned = active.filter((c) => !c.operatorJoined);
  const liveCritical = active.filter((c) => (c.priority ?? "").toUpperCase() === "CRITICAL");
  const recordsCritical = records.filter(
    (r) => (r.priority?.level ?? "").toUpperCase() === "CRITICAL",
  ).length;
  const joined = calls.filter((c) => c.operatorJoined);
  const avgLagMs =
    joined.length > 0
      ? joined.reduce((sum, c) => {
          const ms = Date.parse(c.lastAt) - Date.parse(c.startedAt);
          return sum + (Number.isNaN(ms) ? 0 : Math.max(0, ms));
        }, 0) / joined.length
      : null;

  const alerts: ShellAlert[] = React.useMemo(() => {
    const out: ShellAlert[] = [];
    if (feed.status === "reconnecting") out.push({ id: "feed", label: "Live feed reconnecting" });
    if (liveCritical.length > 0) {
      out.push({
        id: "critical",
        label: `${liveCritical.length} critical live call${liveCritical.length === 1 ? "" : "s"}`,
      });
    }
    return out;
  }, [feed.status, liveCritical.length]);

  const recent = feed.events.slice(0, 8);
  const loadingFeed = feed.status === "connecting" && feed.events.length === 0;

  const recentCallStart = feed.events.some(
    (e) => e.name === "call.started" && Date.now() - Date.parse(e.at) < 5 * 60 * 1000,
  );

  return (
    <Shell
      section="home"
      title={`Welcome, ${operatorName}`}
      crumbs={[{ label: "Home" }]}
      liveStatus={feed.status}
      alerts={alerts}
    >
      {/* welcome row */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <label htmlFor="home-availability" className="text-sm text-muted">
            You are
          </label>
          <Select
            id="home-availability"
            value={availability}
            onChange={(e) =>
              setAvailability(e.target.value as typeof availability)
            }
            aria-label="Your availability status"
            className="w-auto"
          >
            <option value="Available">Available</option>
            <option value="Busy">Busy</option>
            <option value="Away">Away</option>
            <option value="Offline">Offline</option>
          </Select>
        </div>
        <Link
          href="/live"
          className="inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl2 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark"
        >
          <PhoneCall aria-hidden className="h-4 w-4" />
          Open Live Calls
        </Link>
      </div>

      {/* stat cards */}
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Card className="p-4">
          <Stat
            label="Active emergencies"
            value={active.length}
            sub="non-ended live calls"
            icon={<PhoneCall weight="duotone" />}
          />
        </Card>
        <Card className="p-4">
          <Stat
            label="Unassigned"
            value={unassigned.length}
            sub="no operator joined (live feed)"
            icon={<Warning weight="duotone" />}
          />
        </Card>
        <Card className="p-4">
          <Stat
            label="Waiting"
            value={waitingOperators.length}
            sub="operators waiting (live feed)"
            icon={<ClockCounterClockwise weight="duotone" />}
          />
        </Card>
        <Card className="p-4">
          <Stat
            label="Critical"
            value={liveCritical.length}
            sub={`${recordsCritical} critical in last ${records.length} records`}
            icon={<WarningCircle weight="duotone" />}
          />
        </Card>
        <Card className="p-4">
          <Stat
            label="Avg response"
            value={avgLagMs === null ? "—" : formatLag(avgLagMs)}
            sub={
              joined.length > 0
                ? `${joined.length} joined calls · start → last update`
                : "no joined calls yet"
            }
            icon={<CheckCircle weight="duotone" />}
          />
        </Card>
      </div>

      {recordsQuery.isError ? (
        <div className="mt-3">
          <Alert tone="warn" title="Recent records unavailable" onRetry={() => void recordsQuery.refetch()}>
            Incident counts below the timeline may be incomplete.
          </Alert>
        </div>
      ) : null}

      <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {/* recent activity */}
        <Card>
          <CardHead title="Recent activity" sub="Latest live events, newest first" />
          {loadingFeed ? (
            <div className="space-y-2 p-4" aria-label="Loading activity">
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
              <Skeleton className="h-10" />
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={<PhoneCall weight="duotone" />}
              title="No live activity yet"
              description="Calls will appear here as they arrive on the live feed."
            />
          ) : (
            <ol className="divide-y divide-line">
              {recent.map((e, i) => {
                const { title, detail } = humanizeEvent(e);
                return (
                  <li key={`${e.callId}-${e.at}-${e.name}-${i}`} className="flex items-start gap-3 px-4 py-2.5 sm:px-5">
                    <span aria-hidden className="mt-0.5 inline-flex text-muted [&_svg]:h-4 [&_svg]:w-4">
                      <Info weight="duotone" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{title}</p>
                      <p className="truncate text-xs text-muted">{detail}</p>
                    </div>
                    <time dateTime={e.at} title={e.at} className="shrink-0 text-xs tabular-nums text-faint">
                      {mounted ? timeAgo(e.at) : "—"}
                    </time>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        {/* system health */}
        <Card>
          <CardHead title="System health" sub="Each row names its source — no inferred greens" />
          <ul className="divide-y divide-line">
            <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
              {recentCallStart ? (
                <Badge tone="ok" icon={<PhoneCall weight="duotone" />}>Receiving calls</Badge>
              ) : (
                <Badge tone="neutral" icon={<PhoneCall weight="duotone" />}>
                  {feed.events.length > 0 ? "Feed live · no recent calls" : "No recent call activity"}
                </Badge>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Telephony</p>
                <p className="truncate text-xs text-muted">Derived from live call.started events (last 5 min)</p>
              </div>
            </li>
            <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
              {sarvam === true ? (
                <Badge tone="ok" icon={<CheckCircle weight="duotone" />}>Operational</Badge>
              ) : sarvam === false ? (
                <Badge tone="danger" icon={<WarningCircle weight="duotone" />}>Unavailable</Badge>
              ) : (
                <Badge tone="neutral" icon={<ClockCounterClockwise weight="duotone" />}>Checking…</Badge>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Translation service</p>
                <p className="truncate text-xs text-muted">Server health · sarvam flag</p>
              </div>
            </li>
            <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
              {feed.status === "live" ? (
                <Badge tone="ok" icon={<WifiHigh weight="duotone" />}>Streaming</Badge>
              ) : feed.status === "reconnecting" ? (
                <Badge tone="warn" icon={<WifiSlash weight="duotone" />}>Reconnecting</Badge>
              ) : (
                <Badge tone="neutral" icon={<WifiSlash weight="duotone" />}>Connecting…</Badge>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Audio streaming</p>
                <p className="truncate text-xs text-muted">Live socket status</p>
              </div>
            </li>
            <li className="flex items-center gap-3 px-4 py-3 sm:px-5">
              {micPermission === "granted" ? (
                <Badge tone="ok" icon={<Microphone weight="duotone" />}>Ready</Badge>
              ) : micPermission === "denied" ? (
                <Badge tone="danger" icon={<Microphone weight="duotone" />}>Blocked</Badge>
              ) : (
                <Badge tone="neutral" icon={<Microphone weight="duotone" />}>Unknown</Badge>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Microphone</p>
                <p className="truncate text-xs text-muted">
                  {audioInputId === "default" ? "Default microphone" : audioInputId} · permission {micPermission}
                  {micPermission === "denied" ? " — allow mic access in site settings" : ""}
                </p>
              </div>
            </li>
          </ul>
          {healthQuery.isError ? (
            <div className="px-4 pb-4 sm:px-5">
              <Alert tone="warn" title="Health check unavailable" onRetry={() => void healthQuery.refetch()}>
                Translation-service status above may be stale.
              </Alert>
            </div>
          ) : null}
        </Card>
      </div>

      {/* quickstart */}
      <Card className="mt-4">
        <CardHead title="New operator quickstart" sub="Three steps to a working station" />
        <ol className="grid gap-2 p-4 sm:grid-cols-3 sm:px-5">
          <li>
            <Link
              href="/onboarding"
              className="flex min-h-[40px] items-center gap-2 rounded-xl2 border border-line px-3 py-2.5 text-sm font-medium hover:bg-paper"
            >
              <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-xs font-bold tabular-nums text-primary-dark">1</span>
              Complete setup
              <ArrowRight aria-hidden className="ml-auto h-4 w-4 text-faint" />
            </Link>
            <p className="mt-1 px-1 text-xs text-muted">Language, mic test and alerts.</p>
          </li>
          <li>
            <Link
              href="/settings"
              className="flex min-h-[40px] items-center gap-2 rounded-xl2 border border-line px-3 py-2.5 text-sm font-medium hover:bg-paper"
            >
              <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-xs font-bold tabular-nums text-primary-dark">2</span>
              Audio &amp; notifications
              <ArrowRight aria-hidden className="ml-auto h-4 w-4 text-faint" />
            </Link>
            <p className="mt-1 px-1 text-xs text-muted">Devices and alert preferences.</p>
          </li>
          <li>
            <Link
              href="/live"
              className="flex min-h-[40px] items-center gap-2 rounded-xl2 border border-line px-3 py-2.5 text-sm font-medium hover:bg-paper"
            >
              <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary-soft text-xs font-bold tabular-nums text-primary-dark">3</span>
              Take live calls
              <ArrowRight aria-hidden className="ml-auto h-4 w-4 text-faint" />
            </Link>
            <p className="mt-1 px-1 text-xs text-muted">Join the live queue when Available.</p>
          </li>
        </ol>
      </Card>

      {/* dispatched context, honestly sourced */}
      {records.length > 0 ? (
        <Card className="mt-4">
          <CardHead
            title="Latest records"
            sub={`${records.length} most recent records from the API`}
            actions={
              <Link href="/incidents" className="inline-flex min-h-[40px] items-center gap-1 text-sm font-medium text-primary-dark hover:underline">
                <FolderOpen aria-hidden className="h-4 w-4" />
                All incidents
              </Link>
            }
          />
          <ul className="divide-y divide-line">
            {records.slice(0, 5).map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 sm:px-5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {r.extraction?.incident_type ?? "Incident"} · {r.extraction?.location ?? "location unknown"}
                  </p>
                  <p className="truncate text-xs tabular-nums text-muted">
                    {r.id}
                    {r.created_at ? ` · ${mounted ? timeAgo(r.created_at) : "—"}` : ""}
                  </p>
                </div>
                {r.priority?.level ? (
                  <Badge
                    tone={(r.priority.level ?? "").toUpperCase() === "CRITICAL" ? "danger" : "neutral"}
                    icon={<WarningCircle weight="duotone" />}
                  >
                    {r.priority.level}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Shell>
  );
}
