"use client";

/**
 * Operator sign-in. After login the operator returns to `?next=` when it is
 * a safe same-origin path, otherwise to /home.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { Eye, EyeSlash, ShieldCheck } from "@phosphor-icons/react";
import { Alert, Button, Card, Field, Spinner, TextInput } from "@/components/ui";
import { getSession, login, register } from "@/lib/api";

const ORG_KEY = "rakshak.console.org";

function safeNext(raw: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get("next")) ?? "/home";

  const [identifier, setIdentifier] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [org, setOrg] = React.useState("");
  const [mode, setMode] = React.useState<"signin" | "register">("signin");
  const [showPassword, setShowPassword] = React.useState(false);
  const [forgotOpen, setForgotOpen] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<{ identifier?: string; password?: string }>({});
  const [failure, setFailure] = React.useState<
    | { kind: "none" }
    | { kind: "credentials" }
    | { kind: "locked" }
    | { kind: "network" }
    | { kind: "taken" }
    | { kind: "closed" }
    | { kind: "generic"; message: string }
  >({ kind: "none" });
  const [loading, setLoading] = React.useState(false);

  // Already signed in → leave the login page.
  React.useEffect(() => {
    if (getSession()) router.replace(next);
  }, [router, next]);

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const errors: { identifier?: string; password?: string } = {};
    if (!identifier.trim()) errors.identifier = "Enter your employee ID or email.";
    if (!password) errors.password = "Enter your password.";
    setFieldErrors(errors);
    if (errors.identifier || errors.password) return;

    setLoading(true);
    setFailure({ kind: "none" });
    try {
      if (mode === "register") {
        try {
          await register(identifier.trim(), password);
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status === 409) {
            setFailure({ kind: "taken" });
            return;
          }
          if (status === 403) {
            setFailure({ kind: "closed" });
            return;
          }
          throw err;
        }
      }
      await login(identifier.trim(), password);
      if (org.trim()) {
        try {
          localStorage.setItem(ORG_KEY, org.trim().slice(0, 80));
        } catch {
          /* private mode */
        }
      }
      router.push(next);
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : "Sign-in failed.";
      if (status === 401) {
        setFailure({ kind: "credentials" });
      } else if (status === 423) {
        setFailure({ kind: "locked" });
      } else if (
        status === undefined ||
        err instanceof TypeError ||
        /failed to fetch|network|load failed/i.test(message)
      ) {
        setFailure({ kind: "network" });
      } else {
        setFailure({ kind: "generic", message });
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card className="w-full max-w-md p-6 sm:p-8">
      <div className="flex items-center gap-3">
        <span aria-hidden className="inline-flex rounded-xl2 bg-primary-soft p-2.5 text-primary-dark [&_svg]:h-6 [&_svg]:w-6">
          <ShieldCheck weight="duotone" />
        </span>
        <div>
          <p className="text-lg font-semibold leading-tight">Rakshak AI</p>
          <p className="text-xs text-muted">Operator Console</p>
        </div>
      </div>
      <p className="mt-4 text-sm text-muted">
        Live emergency-call translation and response — AI assists, humans decide.
      </p>

      <form onSubmit={handleSubmit} noValidate aria-busy={loading || undefined} className="mt-6 space-y-4">
        <div aria-live="polite">
          {failure.kind === "credentials" ? (
            <Alert tone="error" title="Incorrect credentials">
              The employee ID and password did not match. Check for typos and try again.
            </Alert>
          ) : null}
          {failure.kind === "locked" ? (
            <Alert tone="error" title="Account locked">
              This account is temporarily locked after too many sign-in attempts. Contact your
              administrator to unlock it.
            </Alert>
          ) : null}
          {failure.kind === "network" ? (
            <Alert tone="error" title="Connection problem" onRetry={() => handleSubmit()} retryLabel="Retry sign-in">
              Could not reach the server. Check your network connection and try again.
            </Alert>
          ) : null}
          {failure.kind === "taken" ? (
            <Alert tone="error" title="Name already registered">
              This employee ID is already registered. Switch to sign-in instead.
            </Alert>
          ) : null}
          {failure.kind === "closed" ? (
            <Alert tone="error" title="Registration closed">
              New accounts are created by an administrator. Ask your control-room admin to
              register this employee ID.
            </Alert>
          ) : null}
          {failure.kind === "generic" ? (
            <Alert tone="error" title="Sign-in failed">
              {failure.message}
            </Alert>
          ) : null}
        </div>

        <Field label="Employee ID or email" htmlFor="login-id" required error={fieldErrors.identifier}>
          <TextInput
            id="login-id"
            name="username"
            autoComplete="username"
            placeholder="e.g. operator-102 or name@control.room"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            error={fieldErrors.identifier}
          />
        </Field>

        <Field label="Password" htmlFor="login-password" required error={fieldErrors.password}>
          <div className="relative">
            <TextInput
              id="login-password"
              name="password"
              autoComplete="current-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={fieldErrors.password}
              className="pr-12"
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-1 top-1/2 inline-flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-xl2 text-muted hover:bg-paper hover:text-ink"
            >
              {showPassword ? (
                <EyeSlash aria-hidden className="h-5 w-5" />
              ) : (
                <Eye aria-hidden className="h-5 w-5" />
              )}
            </button>
          </div>
        </Field>

        <Field
          label="Organization / workspace"
          htmlFor="login-org"
          hint="Optional — used only for the workspace label on this device."
        >
          <TextInput
            id="login-org"
            name="organization"
            autoComplete="organization"
            placeholder="e.g. City Control Room"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
          />
        </Field>

        <div>
          <button
            type="button"
            aria-expanded={forgotOpen}
            onClick={() => setForgotOpen((v) => !v)}
            className="inline-flex min-h-[40px] items-center rounded text-sm font-medium text-primary-dark hover:underline"
          >
            Forgot password?
          </button>
          {forgotOpen ? (
            <div className="mt-2 rounded-xl2 border border-line bg-paper px-4 py-3 text-sm text-muted">
              Password resets are handled by your administrator — there is no self-service reset
              on this console. Contact your control-room administrator with your employee ID and
              they will issue a new password.
            </div>
          ) : null}
        </div>

        <Button type="submit" variant="primary" loading={loading} className="w-full">
          {loading ? (mode === "register" ? "Creating account…" : "Signing in…") : mode === "register" ? "Create account" : "Sign in"}
        </Button>
        <div className="text-center">
          <button
            type="button"
            onClick={() => {
              setMode((m) => (m === "signin" ? "register" : "signin"));
              setFailure({ kind: "none" });
              setFieldErrors({});
            }}
            className="inline-flex min-h-[40px] items-center rounded text-sm font-medium text-primary-dark hover:underline"
          >
            {mode === "signin" ? "New operator? Create an account" : "Have an account? Sign in"}
          </button>
          {mode === "register" ? (
            <p className="mt-1 text-xs text-muted">The first account becomes the administrator.</p>
          ) : null}
        </div>
      </form>

      <p className="mt-6 text-center text-xs text-muted">
        New operator? After signing in, complete{" "}
        <Link href="/onboarding" className="font-medium text-primary-dark hover:underline">
          audio &amp; language setup
        </Link>
        .
      </p>
    </Card>
  );
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center bg-paper px-4 py-10">
      <Suspense
        fallback={
          <span className="inline-flex items-center gap-2 text-sm text-muted">
            <Spinner label="Loading sign-in" />
            Loading sign-in…
          </span>
        }
      >
        <LoginForm />
      </Suspense>
    </main>
  );
}
