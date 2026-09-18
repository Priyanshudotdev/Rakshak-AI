"use client";

/**
 * Operator console shell: narrow icon rail + sidebar on lg and up,
 * hamburger drawer below lg, compact topbar.
 *
 * The shell never opens its own realtime socket. Pages that need the feed
 * call useLiveEvents() once and pass `liveStatus` down. Notifications are
 * passed in via the `alerts` prop (default []).
 *
 * OWNERSHIP: this file is owned by the home/shell agent (feat/v2-architecture).
 * Do not replace with a stub — live/history/incidents/analytics pages all
 * typecheck against this real implementation.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  Buildings,
  CaretDoubleLeft,
  CaretDoubleRight,
  ChartBar,
  ClockCounterClockwise,
  FolderOpen,
  GearSix,
  House,
  List,
  PhoneCall,
  Question,
  SignOut,
  WifiHigh,
  WifiSlash,
  X,
} from "@phosphor-icons/react";
import { Badge } from "./ui";
import { getSession, logout } from "@/lib/api";
import { loadPrefs, savePrefs, type OperatorPrefs } from "@/lib/prefs";
import type { ConnectionStatus } from "@/lib/live";
import type { AVAILABILITY } from "@/lib/types";

export type ShellSection = "home" | "live" | "incidents" | "history" | "analytics" | "settings";
export type Availability = (typeof AVAILABILITY)[number];

export interface ShellCrumb {
  label: string;
  href?: string;
}

export interface ShellAlert {
  id: string;
  label: string;
}

/* ---------------- availability (prefs-backed) ---------------- */

export function useAvailability() {
  const [availability, setAvailabilityState] = React.useState<OperatorPrefs["availability"]>(
    () => {
      try {
        return loadPrefs().availability;
      } catch {
        return "Available";
      }
    },
  );

  React.useEffect(() => {
    try {
      setAvailabilityState(loadPrefs().availability);
    } catch {
      /* keep default */
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === "rakshak.console.prefs") {
        try {
          setAvailabilityState(loadPrefs().availability);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setAvailability = React.useCallback((next: OperatorPrefs["availability"]) => {
    try {
      savePrefs({ ...loadPrefs(), availability: next });
    } catch {
      /* private mode: still reflect locally */
    }
    setAvailabilityState(next);
  }, []);

  return { availability, setAvailability };
}

const AVAILABILITY_DOT: Record<OperatorPrefs["availability"], string> = {
  Available: "bg-ok",
  Busy: "bg-warn",
  Away: "bg-faint",
  Offline: "border border-faint bg-transparent",
};

/* ---------------- workspace selector (local-only placeholder) ---------------- */

const ORG_KEY = "rakshak.console.org";
const ORG_OPTIONS = ["City Control Room", "District Control Room", "Training Workspace"];

function useOrg() {
  const [org, setOrg] = React.useState<string>(ORG_OPTIONS[0]);
  React.useEffect(() => {
    try {
      const v = localStorage.getItem(ORG_KEY);
      if (v && v.trim()) setOrg(v.trim().slice(0, 80));
    } catch {
      /* keep default */
    }
  }, []);
  const update = React.useCallback((v: string) => {
    setOrg(v);
    try {
      localStorage.setItem(ORG_KEY, v);
    } catch {
      /* private mode */
    }
  }, []);
  return { org, update };
}

/* ---------------- nav ---------------- */

const NAV: { section: ShellSection; label: string; href: string; Icon: typeof House }[] = [
  { section: "home", label: "Home", href: "/home", Icon: House },
  { section: "live", label: "Live Calls", href: "/live", Icon: PhoneCall },
  { section: "incidents", label: "Incidents", href: "/incidents", Icon: FolderOpen },
  { section: "history", label: "Call History", href: "/history", Icon: ClockCounterClockwise },
  { section: "analytics", label: "Analytics", href: "/analytics", Icon: ChartBar },
  { section: "settings", label: "Settings", href: "/settings", Icon: GearSix },
];

/* ---------------- session ---------------- */

function useOperator() {
  const [operator, setOperator] = React.useState<{ name: string; role: string } | null>(null);
  React.useEffect(() => {
    setOperator(getSession());
  }, []);
  return operator;
}

function useSignOut() {
  const router = useRouter();
  return React.useCallback(async () => {
    try {
      await logout();
    } finally {
      router.push("/login");
    }
  }, [router]);
}

/* ---------------- connection badge (icon + text, live region) ---------------- */

function ConnectionBadge({ status }: { status?: ConnectionStatus }) {
  if (!status) {
    return (
      <Badge tone="neutral" icon={<WifiSlash weight="duotone" />}>
        No feed
      </Badge>
    );
  }
  if (status === "live") {
    return (
      <Badge tone="ok" icon={<WifiHigh weight="duotone" />}>
        Live
      </Badge>
    );
  }
  if (status === "reconnecting") {
    return (
      <Badge tone="warn" icon={<WifiSlash weight="duotone" />}>
        Reconnecting
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" icon={<WifiSlash weight="duotone" />}>
      Connecting…
    </Badge>
  );
}

/* ---------------- sidebar body (shared by sidebar + mobile drawer) ---------------- */

function SidebarBody({
  section,
  onNavigate,
  collapsed = false,
}: {
  section: ShellSection;
  onNavigate?: () => void;
  /** Icon-only sliding mode (desktop collapse). Labels become tooltips. */
  collapsed?: boolean;
}) {
  const { org, update } = useOrg();
  const operator = useOperator();
  const signOut = useSignOut();
  const { availability } = useAvailability();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const initial = (operator?.name.trim().charAt(0) ?? "O").toUpperCase();

  return (
    <div className="flex h-full flex-col">
      {collapsed ? null : (
      <div className="border-b border-line px-4 py-3">
        <label
          htmlFor="workspace-selector"
          className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted"
        >
          <Buildings aria-hidden weight="duotone" className="h-4 w-4" />
          Workspace
        </label>
        <select
          id="workspace-selector"
          value={org}
          onChange={(e) => update(e.target.value)}
          title="Workspace (local-only placeholder)"
          className="mt-1.5 h-10 w-full rounded-xl2 border border-line bg-card px-2 text-sm font-medium text-ink focus:border-primary"
        >
          {ORG_OPTIONS.includes(org) ? null : <option value={org}>{org} (this device)</option>}
          {ORG_OPTIONS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[11px] text-faint">Local-only placeholder, not synced.</p>
      </div>
      )}

      <nav aria-label="Primary" className={`flex-1 overflow-y-auto py-3 ${collapsed ? "px-2" : "px-2"}`}>
        <ul className="space-y-1">
          {NAV.map(({ section: s, label, href, Icon }) => {
            const active = s === section;
            return (
              <li key={s}>
                <Link
                  href={href}
                  title={label}
                  aria-label={label}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={`flex min-h-[40px] items-center gap-3 rounded-xl2 px-3 text-sm font-medium transition-colors ${
                    collapsed ? "justify-center px-0" : ""
                  } ${
                    active
                      ? "bg-primary-soft text-primary-dark"
                      : "text-muted hover:bg-paper hover:text-ink"
                  }`}
                >
                  <Icon aria-hidden weight={active ? "fill" : "regular"} className="h-5 w-5 shrink-0" />
                  {collapsed ? null : label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="relative border-t border-line p-3">
        <div className={`flex items-center gap-3 ${collapsed ? "flex-col gap-2" : ""}`}>
          <span className="relative inline-flex shrink-0">
            <span
              aria-hidden
              className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-dark"
            >
              {initial}
            </span>
            <span
              aria-hidden
              title={availability}
              className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full ring-2 ring-card ${AVAILABILITY_DOT[availability]}`}
            />
          </span>
          {collapsed ? null : (
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-ink">{operator?.name ?? "Operator"}</p>
            <p className="truncate text-xs text-muted">
              {operator?.role ?? "operator"} · {availability}
            </p>
          </div>
          )}
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label="Account menu"
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink"
          >
            {menuOpen ? (
              <X aria-hidden weight="bold" className="h-5 w-5" />
            ) : (
              <SignOut aria-hidden className="h-5 w-5" />
            )}
          </button>
        </div>
        {menuOpen ? (
          <div
            role="menu"
            aria-label="Account"
            className={
              collapsed
                ? "absolute bottom-full left-2 z-50 mb-2 w-52 rounded-xl2 border border-line bg-card p-1.5 shadow-card"
                : "mt-2 rounded-xl2 border border-line bg-card p-1.5"
            }
          >
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              className="flex min-h-[40px] w-full items-center gap-2 rounded-xl2 px-3 text-sm font-medium text-danger hover:bg-dangerbg"
            >
              <SignOut aria-hidden className="h-4 w-4" />
              Sign out
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- notifications ---------------- */

function NotificationsBell({ alerts }: { alerts: ShellAlert[] }) {
  const [open, setOpen] = React.useState(false);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const count = alerts.length;

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  return (
    <div ref={panelRef} className="relative">
      <button
        type="button"
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications, none"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink"
      >
        <Bell aria-hidden weight={count > 0 ? "fill" : "regular"} className="h-5 w-5" />
        {count > 0 ? (
          <span
            aria-hidden
            className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold tabular-nums text-white"
          >
            {count > 9 ? "9+" : count}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          role="region"
          aria-label="Notifications"
          className="absolute right-0 top-12 z-40 w-72 rounded-xl2 border border-line bg-card p-2 shadow-card"
        >
          {count === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted">No alerts.</p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {alerts.map((a) => (
                <li key={a.id} className="rounded-xl2 px-3 py-2 text-sm text-ink hover:bg-paper">
                  {a.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- topbar profile menu ---------------- */

function ProfileMenu() {
  const operator = useOperator();
  const signOut = useSignOut();
  const { availability } = useAvailability();
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const initial = (operator?.name.trim().charAt(0) ?? "O").toUpperCase();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={operator ? `Account: ${operator.name}` : "Account"}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-10 w-10 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary-dark hover:bg-primary-soft"
      >
        <span aria-hidden>{initial}</span>
        <span
          aria-hidden
          className={`absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card ${AVAILABILITY_DOT[availability]}`}
        />
      </button>
      {open ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-12 z-40 w-60 rounded-xl2 border border-line bg-card p-2 shadow-card"
        >
          <p className="truncate px-3 pb-1 pt-2 text-sm font-semibold text-ink">
            {operator?.name ?? "Operator"}
          </p>
          <p className="truncate px-3 pb-2 text-xs text-muted">
            {operator?.role ?? "operator"} · {availability}
          </p>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="flex min-h-[40px] w-full items-center gap-2 rounded-xl2 px-3 text-sm font-medium text-danger hover:bg-dangerbg"
          >
            <SignOut aria-hidden className="h-4 w-4" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- Shell ---------------- */

export function Shell({
  section,
  title,
  crumbs = [],
  actions,
  liveStatus,
  alerts = [],
  children,
}: {
  section: ShellSection;
  title: string;
  crumbs?: ShellCrumb[];
  actions?: React.ReactNode;
  liveStatus?: ConnectionStatus;
  alerts?: ShellAlert[];
  children: React.ReactNode;
}) {
  const [drawer, setDrawer] = React.useState(false);
  const [collapsed, setCollapsed] = React.useState(false);
  const closeRef = React.useRef<HTMLButtonElement>(null);

  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("rakshak.console.navCollapsed") === "1");
    } catch {
      /* keep expanded */
    }
  }, []);

  const toggleCollapsed = React.useCallback(() => {
    setCollapsed((v) => {
      try {
        localStorage.setItem("rakshak.console.navCollapsed", v ? "0" : "1");
      } catch {
        /* private mode */
      }
      return !v;
    });
  }, []);

  React.useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawer(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [drawer]);

  return (
    <div className="flex min-h-dvh bg-paper text-ink">
      {/* single sliding sidebar (desktop): expanded labels <-> collapsed icons */}
      <aside
        aria-label="Workspace and navigation"
        className={`sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-card transition-[width] duration-200 ease-out lg:block ${
          collapsed ? "w-[68px]" : "w-60"
        }`}
      >
        <SidebarBody section={section} collapsed={collapsed} />
      </aside>

      {/* mobile drawer */}
      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setDrawer(false)}
            className="absolute inset-0 cursor-default bg-ink/40"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute left-0 top-0 h-full w-72 max-w-[85vw] bg-card shadow-card"
          >
            <div className="flex h-14 items-center justify-between border-b border-line px-4">
              <p className="text-sm font-semibold">Rakshak AI</p>
              <button
                ref={closeRef}
                type="button"
                aria-label="Close navigation"
                onClick={() => setDrawer(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink"
              >
                <X aria-hidden weight="bold" className="h-5 w-5" />
              </button>
            </div>
            <div className="h-[calc(100%-3.5rem)]">
              <SidebarBody section={section} onNavigate={() => setDrawer(false)} />
            </div>
          </aside>
        </div>
      ) : null}

      {/* main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-card">
          <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink lg:hidden"
            >
              <List aria-hidden weight="bold" className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
              aria-expanded={!collapsed}
              onClick={toggleCollapsed}
              title={collapsed ? "Expand navigation" : "Collapse navigation"}
              className="hidden h-10 w-10 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink lg:inline-flex"
            >
              {collapsed ? (
                <CaretDoubleRight aria-hidden weight="bold" className="h-5 w-5" />
              ) : (
                <CaretDoubleLeft aria-hidden weight="bold" className="h-5 w-5" />
              )}
            </button>
            <div className="min-w-0 flex-1">
              {crumbs.length > 0 ? (
                <nav aria-label="Breadcrumb">
                  <ol className="flex min-w-0 items-center gap-1 text-xs text-muted">
                    {crumbs.map((c, i) => (
                      <li key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1">
                        {i > 0 ? (
                          <span aria-hidden className="text-faint">
                            /
                          </span>
                        ) : null}
                        {c.href && i < crumbs.length - 1 ? (
                          <Link href={c.href} className="truncate hover:text-ink">
                            {c.label}
                          </Link>
                        ) : (
                          <span aria-current={i === crumbs.length - 1 ? "page" : undefined} className="truncate">
                            {c.label}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </nav>
              ) : null}
              <h1 className="truncate text-base font-semibold leading-tight">{title}</h1>
            </div>
            <div aria-live="polite" className="hidden shrink-0 sm:block">
              <ConnectionBadge status={liveStatus} />
            </div>
            <NotificationsBell alerts={alerts} />
            <Link
              href="/onboarding"
              aria-label="Help and setup"
              title="Help & setup"
              className="hidden h-10 w-10 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink sm:inline-flex"
            >
              <Question aria-hidden className="h-5 w-5" />
            </Link>
            <ProfileMenu />
          </div>
          <div aria-live="polite" className="border-t border-line px-4 py-1.5 sm:hidden">
            <ConnectionBadge status={liveStatus} />
          </div>
        </header>

        {actions ? (
          <div className="border-b border-line bg-card">
            <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-2.5">{actions}</div>
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-4 sm:px-4 sm:py-6">{children}</main>
      </div>
    </div>
  );
}
