"use client";

/**
 * First-run operator setup. Guarded: without a session the operator is sent
 * to /login?next=/onboarding. Finishing saves prefs locally and best-effort
 * PUTs the language pair to the server profile (never blocking).
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Microphone, ShieldCheck } from "@phosphor-icons/react";
import { Alert, Button, Card, Field, Select, Spinner } from "@/components/ui";
import { getSession, putProfile } from "@/lib/api";
import {
  DEFAULT_PREFS,
  enumerateAudioDevices,
  loadPrefs,
  savePrefs,
  type AudioDevice,
  type OperatorPrefs,
} from "@/lib/prefs";
import { AVAILABILITY, SUPPORTED_LANGUAGES } from "@/lib/types";

const STEPS = ["Language", "Audio", "Notifications", "Availability", "Review"] as const;

const LANGUAGE_NAMES: Record<string, string> = {
  "mr-IN": "Marathi",
  "hi-IN": "Hindi",
  "en-IN": "English",
  "gu-IN": "Gujarati",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "bn-IN": "Bengali",
  "pa-IN": "Punjabi",
};

function langLabel(code: string): string {
  const name = LANGUAGE_NAMES[code];
  return name ? `${name} (${code})` : code;
}

type MicState = "idle" | "testing" | "denied" | "error";

export default function OnboardingPage() {
  const router = useRouter();
  const [ready, setReady] = React.useState(false);
  const [step, setStep] = React.useState(0);
  const [stepError, setStepError] = React.useState<string | null>(null);
  const [prefs, setPrefs] = React.useState<OperatorPrefs>(() => {
    try {
      return loadPrefs();
    } catch {
      return { ...DEFAULT_PREFS };
    }
  });

  const [devices, setDevices] = React.useState<{ inputs: AudioDevice[]; outputs: AudioDevice[] } | null>(null);
  const [devicesLoading, setDevicesLoading] = React.useState(false);
  const [devicesNote, setDevicesNote] = React.useState<string | null>(null);

  const [micState, setMicState] = React.useState<MicState>("idle");
  const [micError, setMicError] = React.useState<string | null>(null);
  const levelBarRef = React.useRef<HTMLDivElement>(null);
  const micRefs = React.useRef<{ stream?: MediaStream; ctx?: AudioContext; raf?: number }>({});

  const [notifNote, setNotifNote] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [profileError, setProfileError] = React.useState<string | null>(null);

  // Guard: redirect when there is no session.
  React.useEffect(() => {
    if (!getSession()) {
      router.replace("/login?next=/onboarding");
    } else {
      setReady(true);
    }
  }, [router]);

  const loadDevices = React.useCallback(async () => {
    setDevicesLoading(true);
    try {
      const d = await enumerateAudioDevices();
      setDevices(d);
      const unlabeled =
        d.inputs.length > 0 &&
        d.inputs.every((i) => i.label === "Default microphone" || /^Microphone \d+$/.test(i.label));
      setDevicesNote(
        unlabeled
          ? "Device names are hidden until microphone permission is granted — run “Test microphone” once, then refresh devices."
          : null,
      );
      setPrefs((p) => ({
        ...p,
        audioInputId: d.inputs.some((i) => i.deviceId === p.audioInputId) ? p.audioInputId : "default",
        audioOutputId: d.outputs.some((o) => o.deviceId === p.audioOutputId) ? p.audioOutputId : "default",
      }));
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadDevices();
  }, [loadDevices]);

  // Stop the mic test when leaving the page.
  React.useEffect(() => {
    const refs = micRefs.current;
    return () => {
      if (refs.raf) cancelAnimationFrame(refs.raf);
      refs.stream?.getTracks().forEach((t) => t.stop());
      refs.ctx?.close().catch(() => undefined);
    };
  }, []);

  function stopMicTest() {
    const { stream, ctx, raf } = micRefs.current;
    if (raf) cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop());
    ctx?.close().catch(() => undefined);
    micRefs.current = {};
    if (levelBarRef.current) levelBarRef.current.style.width = "0%";
    setMicState("idle");
  }

  async function startMicTest() {
    setMicError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicState("error");
      setMicError("This browser does not support microphone testing.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio:
          prefs.audioInputId && prefs.audioInputId !== "default"
            ? { deviceId: { exact: prefs.audioInputId } }
            : true,
      });
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        stream.getTracks().forEach((t) => t.stop());
        setMicState("error");
        setMicError("Audio monitoring is not supported in this browser.");
        return;
      }
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      micRefs.current = { stream, ctx };
      setMicState("testing");
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / data.length);
        const pct = Math.min(100, Math.round(rms * 300));
        if (levelBarRef.current) levelBarRef.current.style.width = `${pct}%`;
        micRefs.current.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        setMicState("denied");
        setMicError("Microphone access was denied. Allow microphone access in the browser prompt or site settings, then try again.");
      } else if (err instanceof DOMException && err.name === "OverconstrainedError") {
        setMicState("error");
        setMicError("The selected microphone is not available. Choose another input and try again.");
      } else {
        setMicState("error");
        setMicError("Could not start the microphone test. Check that a microphone is connected.");
      }
    }
  }

  async function handleDesktopChange(checked: boolean) {
    setPrefs((p) => ({ ...p, notifications: { ...p.notifications, desktop: checked } }));
    setNotifNote(null);
    if (checked && typeof window !== "undefined" && "Notification" in window) {
      try {
        if (Notification.permission === "default") {
          const result = await Notification.requestPermission();
          if (result === "denied") {
            setNotifNote("Desktop notifications are blocked in this browser. Allow them in site settings — sound alerts still work.");
          }
        } else if (Notification.permission === "denied") {
          setNotifNote("Desktop notifications are blocked in this browser. Allow them in site settings — sound alerts still work.");
        }
      } catch {
        /* permission request is best-effort */
      }
    }
  }

  function toggleKnown(code: string) {
    setPrefs((p) => ({
      ...p,
      knownLanguages: p.knownLanguages.includes(code)
        ? p.knownLanguages.filter((l) => l !== code)
        : [...p.knownLanguages, code],
    }));
  }

  function next() {
    setStepError(null);
    if (step === 0 && prefs.knownLanguages.length === 0) {
      setStepError("Select at least one language you can take calls in.");
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }

  function back() {
    setStepError(null);
    setStep((s) => Math.max(s - 1, 0));
  }

  async function finish() {
    setSaving(true);
    setProfileError(null);
    savePrefs(prefs);
    try {
      await putProfile({
        known_languages: [...prefs.knownLanguages],
        default_language: prefs.preferredLanguage,
      });
      router.push("/home");
    } catch {
      setProfileError(
        "Could not save your language profile to the server. Your setup is saved on this device — continue to Home and update it later in Settings.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!ready) {
    return (
      <main className="grid min-h-dvh place-items-center bg-paper px-4">
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          <Spinner label="Loading setup" />
          Loading setup…
        </span>
      </main>
    );
  }

  const progressPct = Math.round(((step + 1) / STEPS.length) * 100);

  return (
    <main className="bg-paper px-4 py-8 sm:py-12">
      <div className="mx-auto w-full max-w-2xl">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="inline-flex rounded-xl2 bg-primary-soft p-2 text-primary-dark [&_svg]:h-5 [&_svg]:w-5">
            <ShieldCheck weight="duotone" />
          </span>
          <p className="text-sm font-semibold">Rakshak AI</p>
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Operator setup</h1>
        <p className="mt-1 text-sm text-muted">
          Language, audio and alerts for this device. Takes about two minutes.
        </p>

        <ol aria-label="Setup steps" className="mt-6 flex flex-wrap gap-2">
          {STEPS.map((label, i) => {
            const done = i < step;
            const current = i === step;
            return (
              <li key={label}>
                <span
                  aria-current={current ? "step" : undefined}
                  className={`inline-flex min-h-[40px] items-center gap-2 rounded-full border px-3 text-sm font-medium ${
                    current
                      ? "border-primary/40 bg-primary-soft text-primary-dark"
                      : done
                        ? "border-ok/30 bg-okbg text-ok"
                        : "border-line bg-card text-muted"
                  }`}
                >
                  <span aria-hidden className="tabular-nums">{i + 1}</span>
                  {label}
                </span>
              </li>
            );
          })}
        </ol>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuenow={step + 1}
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${progressPct}%` }} />
        </div>

        <Card className="mt-4 p-5 sm:p-6">
          {stepError ? (
            <div className="mb-4">
              <Alert tone="warn" title="Check this step">
                {stepError}
              </Alert>
            </div>
          ) : null}

          {step === 0 ? (
            <div className="space-y-5">
              <Field label="Preferred language" htmlFor="ob-pref-lang" hint="Default language for transcripts shown to you.">
                <Select
                  id="ob-pref-lang"
                  value={prefs.preferredLanguage}
                  onChange={(e) => setPrefs((p) => ({ ...p, preferredLanguage: e.target.value }))}
                >
                  {SUPPORTED_LANGUAGES.map((code) => (
                    <option key={code} value={code}>
                      {langLabel(code)}
                    </option>
                  ))}
                </Select>
              </Field>
              <div>
                <p id="ob-known-label" className="mb-1.5 block text-sm font-medium">
                  Languages you can take calls in <span aria-hidden className="text-danger"> *</span>
                  <span className="sr-only">(required)</span>
                </p>
                <div role="group" aria-labelledby="ob-known-label" className="flex flex-wrap gap-2">
                  {SUPPORTED_LANGUAGES.map((code) => {
                    const selected = prefs.knownLanguages.includes(code);
                    return (
                      <button
                        key={code}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => toggleKnown(code)}
                        className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors ${
                          selected
                            ? "border-primary/40 bg-primary-soft text-primary-dark"
                            : "border-line bg-card text-muted hover:text-ink"
                        }`}
                      >
                        {selected ? <Check aria-hidden weight="bold" className="h-4 w-4" /> : null}
                        {langLabel(code)}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 text-xs text-muted">Saved to your server profile on finish.</p>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Microphone" htmlFor="ob-mic">
                  <Select
                    id="ob-mic"
                    value={prefs.audioInputId}
                    onChange={(e) => setPrefs((p) => ({ ...p, audioInputId: e.target.value }))}
                  >
                    {(devices?.inputs ?? [{ deviceId: "default", label: "Default microphone" }]).map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Speaker" htmlFor="ob-spk">
                  <Select
                    id="ob-spk"
                    value={prefs.audioOutputId}
                    onChange={(e) => setPrefs((p) => ({ ...p, audioOutputId: e.target.value }))}
                  >
                    {(devices?.outputs ?? [{ deviceId: "default", label: "Default speaker" }]).map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              {devicesNote ? <p className="text-xs text-muted">{devicesNote}</p> : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void loadDevices()} disabled={devicesLoading}>
                  {devicesLoading ? "Refreshing…" : "Refresh devices"}
                </Button>
                {micState === "testing" ? (
                  <Button variant="secondary" onClick={stopMicTest}>
                    Stop test
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => void startMicTest()}>
                    <Microphone aria-hidden className="h-4 w-4" />
                    Test microphone
                  </Button>
                )}
              </div>
              {micState === "testing" ? (
                <div aria-live="polite">
                  <p className="text-xs font-medium text-muted">Listening… speak to see the level move.</p>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-line" aria-hidden>
                    <div ref={levelBarRef} className="h-full rounded-full bg-ok" style={{ width: "0%" }} />
                  </div>
                </div>
              ) : null}
              {micState !== "testing" ? <div ref={levelBarRef} className="hidden" aria-hidden /> : null}
              {micError ? (
                <Alert tone={micState === "denied" ? "warn" : "error"} title={micState === "denied" ? "Microphone blocked" : "Microphone test failed"}>
                  {micError}
                </Alert>
              ) : null}
            </div>
          ) : null}

          {step === 2 ? (
            <div className="space-y-4">
              <p className="text-sm text-muted">How should this console get your attention for new calls?</p>
              <label className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-xl2 border border-line px-3 py-2">
                <input
                  type="checkbox"
                  checked={prefs.notifications.sound}
                  onChange={(e) =>
                    setPrefs((p) => ({ ...p, notifications: { ...p.notifications, sound: e.target.checked } }))
                  }
                  className="h-4 w-4 accent-[#2563eb]"
                />
                <span className="text-sm font-medium">Play a sound for incoming calls</span>
              </label>
              <label className="flex min-h-[40px] cursor-pointer items-center gap-3 rounded-xl2 border border-line px-3 py-2">
                <input
                  type="checkbox"
                  checked={prefs.notifications.desktop}
                  onChange={(e) => void handleDesktopChange(e.target.checked)}
                  className="h-4 w-4 accent-[#2563eb]"
                />
                <span className="text-sm font-medium">Show desktop notifications</span>
              </label>
              {notifNote ? <p className="text-xs text-muted">{notifNote}</p> : null}
            </div>
          ) : null}

          {step === 3 ? (
            <div className="space-y-2">
              <p className="text-sm text-muted">Callers are routed to operators marked Available first.</p>
              <div role="radiogroup" aria-label="Availability status" className="grid gap-2 sm:grid-cols-2">
                {AVAILABILITY.map((a) => {
                  const selected = prefs.availability === a;
                  return (
                    <button
                      key={a}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      onClick={() => setPrefs((p) => ({ ...p, availability: a }))}
                      className={`flex min-h-[40px] items-center gap-2.5 rounded-xl2 border px-3 py-2 text-left text-sm font-medium transition-colors ${
                        selected
                          ? "border-primary/40 bg-primary-soft text-primary-dark"
                          : "border-line bg-card text-muted hover:text-ink"
                      }`}
                    >
                      <span
                        aria-hidden
                        className={`h-2.5 w-2.5 rounded-full ${
                          a === "Available" ? "bg-ok" : a === "Busy" ? "bg-warn" : a === "Away" ? "bg-faint" : "bg-line"
                        }`}
                      />
                      {a}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {step === 4 ? (
            <div className="space-y-4">
              <dl className="divide-y divide-line rounded-xl2 border border-line">
                <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <dt className="text-sm text-muted">Preferred language</dt>
                  <dd className="text-sm font-medium">{langLabel(prefs.preferredLanguage)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <dt className="text-sm text-muted">Known languages</dt>
                  <dd className="text-right text-sm font-medium">
                    {prefs.knownLanguages.map(langLabel).join(", ") || "—"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <dt className="text-sm text-muted">Alerts</dt>
                  <dd className="text-sm font-medium">
                    {[prefs.notifications.sound && "Sound", prefs.notifications.desktop && "Desktop"]
                      .filter(Boolean)
                      .join(" + ") || "Off"}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <dt className="text-sm text-muted">Availability</dt>
                  <dd className="text-sm font-medium">{prefs.availability}</dd>
                </div>
              </dl>
              {profileError ? (
                <Alert tone="warn" title="Saved on this device only" onRetry={finish} retryLabel="Try server save again">
                  <p>{profileError}</p>
                  <p className="mt-2">
                    <Link href="/home" className="font-medium text-primary-dark hover:underline">
                      Continue to Home anyway
                    </Link>
                  </p>
                </Alert>
              ) : null}
            </div>
          ) : null}

          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
            <Button variant="secondary" onClick={back} disabled={step === 0 || saving}>
              Back
            </Button>
            {step < STEPS.length - 1 ? (
              <Button variant="primary" onClick={next}>
                Next
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void finish()} loading={saving}>
                {saving ? "Saving…" : "Finish setup"}
              </Button>
            )}
          </div>
        </Card>

        <p className="mt-4 text-center text-xs text-muted">
          You can change any of this later in{" "}
          <Link href="/settings" className="font-medium text-primary-dark hover:underline">
            Settings
          </Link>
          .
        </p>
      </div>
    </main>
  );
}
