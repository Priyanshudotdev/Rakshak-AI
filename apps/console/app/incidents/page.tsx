"use client";

import Link from "next/link";
import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { PhoneCall } from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import { Alert, Badge, Card, EmptyState, Select, Skeleton, TextInput } from "@/components/ui";
import { listRecords } from "@/lib/api";
import type { IncidentRecord } from "@/lib/types";

function priorityTone(level?: string): "danger" | "warn" | "ok" | "neutral" {
  const l = (level ?? "").toUpperCase();
  if (l === "CRITICAL" || l === "HIGH") return "danger";
  if (l === "MEDIUM") return "warn";
  if (l === "LOW") return "ok";
  return "neutral";
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

export default function IncidentsPage() {
  const [q, setQ] = useState("");
  const [priority, setPriority] = useState("ALL");
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ["incidents", q, priority],
    queryFn: () =>
      listRecords({ q: q || undefined, priority, limit: 50 }).then((r) => r.data as IncidentRecord[]),
    refetchInterval: 8000,
    placeholderData: keepPreviousData,
  });
  const records = data ?? [];

  return (
    <Shell section="incidents" title="Incidents" crumbs={[{ label: "Incidents" }]}>
      <Card>
        <div className="border-b border-line px-4 py-3 sm:px-5">
          <h2 className="text-sm font-semibold text-ink">All incidents</h2>
          <p className="mt-0.5 text-xs text-muted">Newest first · select a row for the case file</p>
        </div>
        <div className="px-4 py-3 sm:px-5">
          <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px]">
            <TextInput
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search id, transcript, location, type…"
              aria-label="Search incidents"
            />
            <Select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority filter">
              {["ALL", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </div>
          {isPending && !data ? (
            <div className="space-y-2" role="status" aria-label="Loading incidents">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-16" />
              ))}
            </div>
          ) : isError && !data ? (
            <Alert tone="error" title="Couldn't load incidents" onRetry={() => void refetch()}>
              Check the API connection and try again.
            </Alert>
          ) : records.length === 0 ? (
            <EmptyState title="No incidents" description="New emergency calls create incidents automatically." />
          ) : (
            <ul className="space-y-2">
              {records.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/incidents/${encodeURIComponent(r.id)}`}
                    className="flex items-center gap-3 rounded-xl border border-line bg-card p-3 shadow-card transition-colors hover:border-primary/50 focus-visible:outline-none"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary-soft text-primary">
                      <PhoneCall size={18} weight="duotone" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted">{shortId(r.id)}</span>
                        <Badge tone={priorityTone(r.priority?.level)}>{r.priority?.level ?? "UNRATED"}</Badge>
                        {r.dispatched ? <Badge tone="ok">Dispatched</Badge> : null}
                      </span>
                      <span className="mt-0.5 block truncate text-sm font-medium text-ink">
                        {r.extraction?.incident_type ?? "Unknown"} · {r.extraction?.location ?? "Location unknown"}
                      </span>
                    </span>
                    <span className="hidden shrink-0 text-xs text-muted sm:block">{r.original_language ?? ""}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </Shell>
  );
}
