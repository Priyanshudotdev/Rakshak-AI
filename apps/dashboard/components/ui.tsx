import type { ReactNode } from "react";
import type { PriorityLevel } from "../lib/types";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg2 border border-line bg-surface shadow-[0_1px_2px_rgba(16,24,40,0.07)] ${className}`}>
      {children}
    </section>
  );
}

export function CardHead({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-cream">{title}</h2>
        {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

export function CardBody({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`px-4 py-3 ${className}`}>{children}</div>;
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger";
  type?: "button" | "submit";
  className?: string;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const styles =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accentpress"
      : variant === "danger"
        ? "border border-priohigh/60 text-priohigh hover:bg-priohigh/10"
        : "border border-line bg-surface2 text-cream hover:bg-surface3";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-md2 border border-line bg-ink px-3 py-2 text-sm text-cream placeholder:text-muted/70 focus:border-accent focus:outline-none";

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${inputCls} min-h-[96px] resize-y ${props.className ?? ""}`} />;
}

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "info" | "ok" | "warn" | "bad" }) {
  const tones: Record<string, string> = {
    neutral: "border-line bg-surface2 text-cream",
    info: "border-infoblue/40 bg-infoblue/10 text-[#1d4ed8]",
    ok: "border-priolow/40 bg-priolow/10 text-[#046c4e]",
    warn: "border-priomed/40 bg-priomed/10 text-[#8a5a00]",
    bad: "border-priohigh/40 bg-priohigh/10 text-[#b42323]",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[11px] ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function PriorityBadge({ level }: { level?: string }) {
  const l = (level ?? "MEDIUM").toUpperCase() as PriorityLevel;
  const tone = l === "HIGH" || l === "CRITICAL" ? "bad" : l === "MEDIUM" ? "warn" : "ok";
  const dot = l === "HIGH" || l === "CRITICAL" ? "bg-priohigh" : l === "MEDIUM" ? "bg-priomed" : "bg-priolow";
  return (
    <Badge tone={tone}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
      {l}
    </Badge>
  );
}

export function KV({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line/60 py-1.5 last:border-0">
      <dt className="shrink-0 text-xs uppercase tracking-wider text-muted">{k}</dt>
      <dd className={`text-right text-sm text-cream ${mono ? "font-mono text-[13px]" : ""}`}>{v ?? "—"}</dd>
    </div>
  );
}

export function EmptyState({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="rounded-md2 border border-dashed border-line px-4 py-8 text-center">
      <p className="text-sm font-medium text-cream">{title}</p>
      {sub ? <p className="mt-1 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" aria-label="loading" />;
}

export function Alert({ kind, children }: { kind: "error" | "ok"; children: ReactNode }) {
  const cls =
    kind === "error"
      ? "border-priohigh/50 bg-priohigh/10 text-[#a11f1f]"
      : "border-priolow/50 bg-priolow/10 text-[#05603f]";
  return <div className={`rounded-md2 border px-3 py-2 text-sm ${cls}`}>{children}</div>;
}
