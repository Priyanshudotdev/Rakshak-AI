"use client";

import { useEffect, useRef, useState } from "react";

interface ConfirmProps {
  open: boolean;
  title: string;
  body: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** Accessible confirm modal: focus-trapped-ish, Escape + overlay close. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  onConfirm,
  onClose,
}: ConfirmProps): React.ReactElement | null {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-xl2 bg-card p-5 shadow-card"
      >
        <h2 id="confirm-title" className="text-base font-semibold text-ink">
          {title}
        </h2>
        <div className="mt-2 text-sm text-ink">{body}</div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] rounded-lg border border-line px-4 text-sm font-medium text-ink disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`min-h-[44px] rounded-lg px-4 text-sm font-semibold text-white disabled:opacity-50 ${
              danger ? "bg-danger" : "bg-primary"
            }`}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AssignProps {
  open: boolean;
  operators: string[];
  busy?: boolean;
  error?: string | null;
  onAssign: (operatorId: string) => void;
  onClose: () => void;
}

/** Transfer-to-operator: pick a waiting operator or type an operator id. */
export function AssignDialog({ open, operators, busy, error, onAssign, onClose }: AssignProps): React.ReactElement | null {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(operators[0] ?? "");
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, operators]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const trimmed = value.trim();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-title"
        className="w-full max-w-md rounded-xl2 bg-card p-5 shadow-card"
      >
        <h2 id="assign-title" className="text-base font-semibold text-ink">
          Transfer to operator
        </h2>
        <p className="mt-2 text-sm text-muted">
          Logs a dispatch handoff entry. This does not move phone audio — PSTN transfer controls do not exist in this
          console.
        </p>
        <label htmlFor="assign-operator" className="mt-4 block text-sm font-medium text-ink">
          Operator id
        </label>
        <input
          ref={inputRef}
          id="assign-operator"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          list="waiting-operators"
          placeholder="e.g. operator-2"
          disabled={busy}
          className="mt-1 min-h-[44px] w-full rounded-lg border border-line bg-card px-3 text-sm text-ink disabled:opacity-50"
        />
        <datalist id="waiting-operators">
          {operators.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
        {operators.length > 0 && <p className="mt-1 text-xs text-muted">{operators.length} waiting operator(s).</p>}
        {error && (
          <p role="alert" className="mt-2 text-sm text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[44px] rounded-lg border border-line px-4 text-sm font-medium text-ink disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => trimmed && onAssign(trimmed)}
            disabled={busy || !trimmed}
            className="min-h-[44px] rounded-lg bg-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Transferring…" : "Confirm transfer"}
          </button>
        </div>
      </div>
    </div>
  );
}
