"use client";

/**
 * Fresh console primitives for the v2 operator console.
 * Light calm theme only: paper page bg, white cards, charcoal text,
 * soft gray borders, one primary-blue accent. No gradients, no glass,
 * no decorative animation. Radius 12px (rounded-xl2), thin borders.
 * Icons come from @phosphor-icons/react; severity is always icon+text.
 */

import * as React from "react";
import { CircleNotch, Info, Warning, WarningCircle, X } from "@phosphor-icons/react";

/* ---------------- Card ---------------- */

export function Card({ className = "", ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-xl2 border border-line bg-card text-ink shadow-card ${className}`}
    />
  );
}

export function CardHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
      <div className="min-w-0">
        <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>
        {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ---------------- Button ---------------- */

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const BUTTON_BASE =
  "inline-flex min-h-[40px] items-center justify-center gap-2 rounded-xl2 px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white hover:bg-primary-dark",
  secondary: "border border-line bg-card text-ink hover:bg-paper",
  danger: "bg-danger text-white hover:opacity-90",
  ghost: "text-muted hover:bg-paper hover:text-ink",
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", loading = false, disabled, className = "", children, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`${BUTTON_BASE} ${BUTTON_VARIANTS[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Spinner label="Loading" className="h-4 w-4" /> : null}
      {children}
    </button>
  );
});

/* ---------------- Badge (always icon + text at call sites) ---------------- */

export type BadgeTone = "ok" | "warn" | "danger" | "info" | "neutral";

const BADGE_TONES: Record<BadgeTone, string> = {
  ok: "border-ok/30 bg-okbg text-ok",
  warn: "border-warn/30 bg-warnbg text-warn",
  danger: "border-danger/30 bg-dangerbg text-danger",
  info: "border-primary/30 bg-primary-soft text-primary-dark",
  neutral: "border-line bg-paper text-muted",
};

export function Badge({
  tone = "neutral",
  icon,
  children,
  className = "",
}: {
  tone?: BadgeTone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${BADGE_TONES[tone]} ${className}`}
    >
      {icon ? <span aria-hidden className="inline-flex [&_svg]:h-3.5 [&_svg]:w-3.5">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}

/* ---------------- Inputs ---------------- */

const INPUT_BASE =
  "w-full rounded-xl2 border bg-card px-3 text-sm text-ink placeholder:text-faint focus:border-primary";

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: string;
}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  { error, className = "", "aria-invalid": ariaInvalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={ariaInvalid ?? (error ? true : undefined)}
      className={`h-10 ${INPUT_BASE} ${error ? "border-danger" : "border-line"} ${className}`}
      {...rest}
    />
  );
});

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  error?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { error, className = "", children, "aria-invalid": ariaInvalid, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={ariaInvalid ?? (error ? true : undefined)}
      className={`h-10 ${INPUT_BASE} ${error ? "border-danger" : "border-line"} ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
});

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: string;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { error, className = "", "aria-invalid": ariaInvalid, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={ariaInvalid ?? (error ? true : undefined)}
      className={`min-h-[88px] py-2 ${INPUT_BASE} ${error ? "border-danger" : "border-line"} ${className}`}
      {...rest}
    />
  );
});

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
        {required ? (
          <>
            <span aria-hidden className="text-danger"> *</span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </label>
      {children}
      {error ? (
        <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/* ---------------- Skeleton (static, shimmer-free, reduced-motion safe) ---------------- */

export function Skeleton({
  className = "",
  label = "Loading content",
}: {
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} className={`rounded-xl2 bg-line/60 ${className}`}>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/* ---------------- EmptyState ---------------- */

export function EmptyState({
  icon,
  title,
  description,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {icon ? (
        <span aria-hidden className="mb-3 inline-flex rounded-xl2 bg-paper p-3 text-muted [&_svg]:h-6 [&_svg]:w-6">
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-sm text-sm text-muted">{description}</p> : null}
      {children ? <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  );
}

/* ---------------- Alert ---------------- */

export type AlertTone = "error" | "warn" | "info";

const ALERT_STYLES: Record<AlertTone, { box: string; Icon: typeof Info }> = {
  error: { box: "border-danger/25 bg-dangerbg text-ink", Icon: WarningCircle },
  warn: { box: "border-warn/25 bg-warnbg text-ink", Icon: Warning },
  info: { box: "border-primary/25 bg-primary-soft text-ink", Icon: Info },
};

export function Alert({
  tone,
  title,
  children,
  onRetry,
  retryLabel = "Retry",
}: {
  tone: AlertTone;
  title: string;
  children?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  const { box, Icon } = ALERT_STYLES[tone];
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-xl2 border px-4 py-3 ${box}`}>
      <span aria-hidden className="mt-0.5 inline-flex shrink-0 [&_svg]:h-5 [&_svg]:w-5">
        <Icon weight="duotone" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex min-h-[40px] items-center rounded-xl2 border border-line bg-card px-3 text-sm font-medium text-ink hover:bg-paper"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------- Spinner ---------------- */

export function Spinner({ label = "Loading", className = "h-5 w-5" }: { label?: string; className?: string }) {
  return (
    <span role="status" className="inline-flex items-center justify-center">
      <CircleNotch aria-hidden weight="bold" className={`animate-spin ${className}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

/* ---------------- Modal (focus trap-lite) ---------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  actions,
  initialFocusRef,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children?: React.ReactNode;
  actions?: React.ReactNode;
  initialFocusRef?: React.RefObject<HTMLElement>;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        const items = [...focusables].filter((el) => !el.hasAttribute("disabled"));
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const target =
      initialFocusRef?.current ??
      panelRef.current?.querySelector<HTMLElement>("button, [href], input, select, textarea");
    target?.focus();
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose, initialFocusRef]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close dialog"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className="relative w-full max-w-lg rounded-xl2 border border-line bg-card p-5 shadow-card sm:p-6"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id={descId} className="mt-1 text-sm text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink"
          >
            <X aria-hidden weight="bold" className="h-5 w-5" />
          </button>
        </div>
        {children ? <div className="mt-4">{children}</div> : null}
        {actions ? <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}

/* ---------------- Stat ---------------- */

export function Stat({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5">
        {icon ? (
          <span aria-hidden className="inline-flex text-muted [&_svg]:h-4 [&_svg]:w-4">{icon}</span>
        ) : null}
        <p className="truncate text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      </div>
      <p className="mt-1 truncate text-2xl font-semibold tabular-nums text-ink">{value}</p>
      {sub ? <p className="mt-0.5 truncate text-xs text-muted">{sub}</p> : null}
    </div>
  );
}
