"use client";

/**
 * Operator settings — single page, anchor nav (natively keyboard accessible).
 *
 * Sources of truth:
 * - Server (real, audited): operator profile (known/default language, mobile)
 *   via getProfile/putProfile; password via changePassword; registration via
 *   register(); health via getHealth.
 * - This device (lib/prefs.ts loadPrefs/savePrefs): preferred language
 *   mirror, audio device ids, notification toggles, availability.
 * - This device (./_store.ts): monitoring-record preference + translation
 *   default preference — no server counterpart exists, labeled local-only.
 *
 * Honesty gaps (no backend — never faked):
 * - MFA: "contact admin" panel, no enrollment UI.
 * - Sessions/sign-out-all: no session-list endpoint; change-password revokes
 *   other sessions server-side (stated), sign-out here clears this device.
 * - Team roles: display + register form only; roles are assigned server-side
 *   (first operator becomes admin, afterwards admin sign-in is required).
 * - PSTN/call recording is provider/Asterisk-side; the console has no
 *   recording endpoint, so the monitoring toggle is a preference flag only.
 */

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  Bell,
  BellRinging,
  CalendarCheck,
  Check,
  CheckCircle,
  Cpu,
  Faders,
  FileAudio,
  Globe,
  Info,
  Key,
  LockKey,
  Microphone,
  Play,
  PlugsConnected,
  ShieldCheck,
  SignOut,
  SpeakerHigh,
  Stop,
  Translate,
  UserCircle,
  Users,
  Warning,
  Waveform,
  XCircle,
} from "@phosphor-icons/react";
import { Shell } from "@/components/shell";
import {
  API_URL,
  changePassword,
  getHealth,
  getProfile,
  getSession,
  logout,
  putProfile,
  register,
} from "@/lib/api";
import { AVAILABILITY, SUPPORTED_LANGUAGES } from "@/lib/types";
import {
  enumerateAudioDevices,
  loadPrefs,
  savePrefs,
  type AudioDevice,
  type OperatorPrefs,
} from "@/lib/prefs";
import { loadDeviceSettings, saveDeviceSettings } from "./_store";

/* ---------------- bits ---------------- */

const SECTIONS = [
  { id: "profile", label: "Operator profile" },
  { id: "languages", label: "Supported languages" },
  { id: "audio", label: "Audio devices" },
  { id: "notifications", label: "Notifications" },
  { id: "availability", label: "Availability" },
  { id: "translation", label: "Translation" },
  { id: "recording", label: "Call recording" },
  { id: "security", label: "Security & MFA" },
  { id: "workspace", label: "Workspace" },
  { id: "team", label: "Team roles" },
] as const;

function Section({
  id,
  title,
  icon,
  note,
  children,
}: {
  id: string;
  title: string;
  icon: React.ReactNode;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-label={title}
      className="scroll-mt-24 rounded-xl2 border border-line bg-card p-5 shadow-card"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="text-primary" aria-hidden="true">
          {icon}
        </span>
        <h2 className="text-base font-semibold text-ink">{title}</h2>
      </div>
      {note ? <p className="mb-3 text-xs text-muted">{note}</p> : null}
      {children}
    </section>
  );
}

function FieldMsg({ ok, text }: { ok: boolean; text: string }) {
  return (
    <p role="status" className={`mt-2 flex items-start gap-1.5 text-sm ${ok ? "text-ok" : "text-danger"}`}>
      <span aria-hidden="true" className="mt-0.5">
        {ok ? <CheckCircle size={16} /> : <XCircle size={16} />}
      </span>
      {text}
    </p>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="space-y-2" aria-label="Loading">
      <div className="h-4 w-11/12 animate-pulse rounded bg-line" />
      <div className="h-4 w-3/4 animate-pulse rounded bg-line" />
      <div className="h-4 w-2/3 animate-pulse rounded bg-line" />
    </div>
  );
}

const inputCls =
  "w-full rounded-xl2 border border-line bg-paper px-3 py-2 text-sm text-ink placeholder:text-faint";
const btnPrimary =
  "inline-flex items-center justify-center gap-1.5 rounded-xl2 bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50";
const btnGhost =
  "inline-flex items-center justify-center gap-1.5 rounded-xl2 border border-line px-3 py-2 text-sm font-medium text-ink hover:bg-paper disabled:cursor-not-allowed disabled:opacity-50";

/** 0.6 s 880 Hz sine as a WAV blob — no assets, no network. */
function toneWavBlob(freq = 880, seconds = 0.6, rate = 22050): Blob {
  const n = Math.floor(rate * seconds);
  const data = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / (rate * 0.02), (n - i) / (rate * 0.05));
    data[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 32767 * 0.5 * env);
  }
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const wstr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, data[i], true);
  return new Blob([buf], { type: "audio/wav" });
}

/* ---------------- page ---------------- */

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const [prefs, setPrefs] = useState<OperatorPrefs>(() =>
    typeof window === "undefined"
      ? {
          preferredLanguage: "hi-IN",
          knownLanguages: ["hi-IN", "en-IN"],
          audioInputId: "default",
          audioOutputId: "default",
          notifications: { sound: true, desktop: false },
          availability: "Available",
        }
      : loadPrefs(),
  );
  const [device, setDevice] = useState(loadDeviceSettings);
  const [session, setSession] = useState<{ name: string; role: string } | null>(null);

  useEffect(() => {
    setPrefs(loadPrefs());
    setDevice(loadDeviceSettings());
    setSession(getSession());
  }, []);

  function updatePrefs(next: OperatorPrefs) {
    setPrefs(next);
    savePrefs(next);
  }

  const profileQuery = useQuery({ queryKey: ["console-profile"], queryFn: getProfile, retry: 1 });
  const healthQuery = useQuery({ queryKey: ["console-health"], queryFn: getHealth, retry: 1 });

  /* profile form */
  const [defaultLang, setDefaultLang] = useState("hi-IN");
  const [mobile, setMobile] = useState("");
  const [profileMsg, setProfileMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  useEffect(() => {
    if (profileQuery.data) {
      setDefaultLang(profileQuery.data.default_language || "hi-IN");
      setMobile(profileQuery.data.mobile_e164 ?? "");
    }
  }, [profileQuery.data]);

  /* languages form (same server profile, checkbox UI) */
  const [langs, setLangs] = useState<string[]>([]);
  const [langsMsg, setLangsMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [langsBusy, setLangsBusy] = useState(false);
  useEffect(() => {
    if (profileQuery.data) {
      setLangs(
        profileQuery.data.known_languages.length
          ? profileQuery.data.known_languages
          : prefs.knownLanguages,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileQuery.data]);

  /* audio */
  const [inputs, setInputs] = useState<AudioDevice[]>([{ deviceId: "default", label: "Default microphone" }]);
  const [outputs, setOutputs] = useState<AudioDevice[]>([{ deviceId: "default", label: "Default speaker" }]);
  const [audioMsg, setAudioMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [spkNote, setSpkNote] = useState<string | null>(null);
  const meterRef = useRef<HTMLDivElement>(null);
  const micRefs = useRef<{ stream?: MediaStream; raf?: number; ctx?: AudioContext }>({});

  useEffect(() => {
    void refreshDevices();
    return () => stopMicTest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshDevices() {
    setAudioMsg(null);
    try {
      const d = await enumerateAudioDevices();
      setInputs(d.inputs);
      setOutputs(d.outputs);
      if (d.inputs.every((i) => i.label.startsWith("Microphone"))) {
        setAudioMsg({
          ok: true,
          text: "Device names are hidden until microphone permission is granted — use “Request microphone access”.",
        });
      }
    } catch (e) {
      setAudioMsg({ ok: false, text: e instanceof Error ? e.message : "Could not list audio devices." });
    }
  }

  async function requestMicAccess() {
    setMicError(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      await refreshDevices();
    } catch {
      setMicError("Microphone permission was denied. Device selection still works, but names and the mic test stay unavailable.");
    }
  }

  function stopMicTest() {
    const r = micRefs.current;
    if (r.raf) cancelAnimationFrame(r.raf);
    r.stream?.getTracks().forEach((t) => t.stop());
    try {
      void r.ctx?.close();
    } catch {
      /* already closed */
    }
    micRefs.current = {};
    setMicActive(false);
    setMicLevelText("");
    if (meterRef.current) meterRef.current.style.width = "0%";
  }

  const [micLevelText, setMicLevelText] = useState("");
  async function startMicTest() {
    setMicError(null);
    setMicLevelText("");
    try {
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(
          prefs.audioInputId !== "default" ? { audio: { deviceId: { exact: prefs.audioInputId } } } : { audio: true },
        );
      } catch (e) {
        if (e instanceof DOMException && e.name === "OverconstrainedError") {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else {
          throw e;
        }
      }
      const Ctx = window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) throw new Error("Web Audio is not supported in this browser.");
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      micRefs.current = { stream, ctx };
      setMicActive(true);
      const buf = new Uint8Array(analyser.fftSize);
      let frames = 0;
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const d = (buf[i] - 128) / 128;
          sum += d * d;
        }
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 2.5);
        if (meterRef.current) meterRef.current.style.width = `${Math.round(level * 100)}%`;
        frames += 1;
        if (frames % 15 === 0) setMicLevelText(`${Math.round(level * 100)}%`);
        micRefs.current.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      setMicError(
        e instanceof Error ? e.message : "Could not start the microphone test. Check permission and device.",
      );
      stopMicTest();
    }
  }

  async function playSpeakerTest() {
    setSpkNote(null);
    try {
      const url = URL.createObjectURL(toneWavBlob());
      const el = new Audio(url);
      const routable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
      if (prefs.audioOutputId !== "default") {
        if (routable.setSinkId) {
          try {
            await routable.setSinkId(prefs.audioOutputId);
          } catch {
            setSpkNote("The browser refused the selected speaker — playing on the default output instead.");
          }
        } else {
          setSpkNote("This browser cannot route audio to a chosen speaker — playing on the default output.");
        }
      }
      el.onended = () => setTimeout(() => URL.revokeObjectURL(url), 1000);
      await el.play();
    } catch {
      setSpkNote("Could not play the test tone. Check that audio output is enabled.");
    }
  }

  /* notifications */
  const [notifMsg, setNotifMsg] = useState<string | null>(null);
  // Permission is read client-side only: reading Notification.permission during
  // render produces different HTML on server ("unsupported") vs client and
  // crashes hydration. Initial value matches the server render exactly.
  const [desktopPermission, setDesktopPermission] = useState("unsupported");
  useEffect(() => {
    try {
      if (typeof Notification !== "undefined") setDesktopPermission(Notification.permission);
    } catch {
      /* keep fallback */
    }
  }, []);

  function playBeep() {
    try {
      const Ctx = window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) {
        setNotifMsg("Web Audio is not supported in this browser.");
        return;
      }
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
      osc.onended = () => void ctx.close();
    } catch {
      setNotifMsg("Could not play the test sound.");
    }
  }

  async function enableDesktop() {
    setNotifMsg(null);
    if (typeof Notification === "undefined") {
      setNotifMsg("Desktop notifications are not supported in this browser.");
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      updatePrefs({ ...prefs, notifications: { ...prefs.notifications, desktop: perm === "granted" } });
      setNotifMsg(
        perm === "granted" ? "Desktop notifications enabled." : "Permission denied — desktop notifications stay off.",
      );
    } catch {
      setNotifMsg("Could not request notification permission.");
    }
  }

  function sendTestNotification() {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") {
      setNotifMsg("Grant desktop permission first.");
      return;
    }
    try {
      new Notification("Rakshak console", { body: "Desktop notifications are working." });
    } catch {
      setNotifMsg("Could not show the test notification.");
    }
  }

  /* profile + languages saves */
  async function saveProfile() {
    setProfileMsg(null);
    setProfileBusy(true);
    try {
      const updated = await putProfile({
        default_language: defaultLang,
        mobile_e164: mobile.trim() === "" ? "" : mobile.trim().slice(0, 30),
      });
      updatePrefs({ ...prefs, preferredLanguage: updated.default_language || defaultLang });
      setProfileMsg({ ok: true, text: "Profile saved to the server." });
      await queryClient.invalidateQueries({ queryKey: ["console-profile"] });
    } catch (e) {
      setProfileMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save the profile." });
    } finally {
      setProfileBusy(false);
    }
  }

  function toggleLang(code: string) {
    setLangs((prev) => (prev.includes(code) ? prev.filter((l) => l !== code) : [...prev, code]));
  }

  async function saveLanguages() {
    setLangsMsg(null);
    setLangsBusy(true);
    try {
      await putProfile({ known_languages: langs });
      updatePrefs({ ...prefs, knownLanguages: langs });
      setLangsMsg({ ok: true, text: "Languages saved to your server operator profile." });
      await queryClient.invalidateQueries({ queryKey: ["console-profile"] });
    } catch (e) {
      setLangsMsg({ ok: false, text: e instanceof Error ? e.message : "Could not save languages." });
    } finally {
      setLangsBusy(false);
    }
  }

  /* security */
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwMsg, setPwMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  async function submitPassword() {
    setPwMsg(null);
    if (newPw !== confirmPw) {
      setPwMsg({ ok: false, text: "New passwords do not match." });
      return;
    }
    if (newPw.length < 4) {
      setPwMsg({ ok: false, text: "The new password needs at least 4 characters." });
      return;
    }
    setPwBusy(true);
    try {
      const res = await changePassword(curPw, newPw);
      setCurPw("");
      setNewPw("");
      setConfirmPw("");
      setPwMsg({ ok: true, text: res.message ?? "Password changed. Other sessions were signed out." });
    } catch (e) {
      setPwMsg({ ok: false, text: e instanceof Error ? e.message : "Could not change the password." });
    } finally {
      setPwBusy(false);
    }
  }

  /* team */
  const [regName, setRegName] = useState("");
  const [regPw, setRegPw] = useState("");
  const [regMsg, setRegMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [regBusy, setRegBusy] = useState(false);

  async function submitRegister() {
    setRegMsg(null);
    if (!regName.trim() || regPw.length < 4) {
      setRegMsg({ ok: false, text: "Enter a name and a password of at least 4 characters." });
      return;
    }
    setRegBusy(true);
    try {
      const res = await register(regName.trim().slice(0, 100), regPw);
      setRegName("");
      setRegPw("");
      setRegMsg({
        ok: true,
        text: `Operator “${res.data.name}” registered with role “${res.data.role}”.`,
      });
    } catch (e) {
      setRegMsg({ ok: false, text: e instanceof Error ? e.message : "Registration failed." });
    } finally {
      setRegBusy(false);
    }
  }

  async function signOut() {
    await logout();
    window.location.href = "/login";
  }

  const health = healthQuery.data ?? null;
  const healthTone = !health ? "neutral" : health.status === "ok" ? "green" : health.status === "degraded" ? "amber" : "red";

  return (
    <Shell section="settings" title="Settings">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6 sm:px-6 lg:flex-row">
        {/* anchor nav — natively keyboard accessible */}
        <nav aria-label="Settings sections" className="lg:w-56 lg:shrink-0">
          <ul className="flex gap-1 overflow-x-auto rounded-xl2 border border-line bg-card p-2 shadow-card lg:sticky lg:top-4 lg:flex-col lg:overflow-visible">
            {SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <a
                  href={`#${s.id}`}
                  className="block whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-muted hover:bg-paper hover:text-ink"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          {/* ---------- profile ---------- */}
          <Section
            id="profile"
            title="Operator profile"
            icon={<UserCircle size={20} aria-hidden="true" />}
            note="Same profile as onboarding — saved to the server."
          >
            {profileQuery.isPending ? (
              <Skeleton />
            ) : profileQuery.isError ? (
              <div role="alert" className="space-y-2">
                <p className="flex items-center gap-1.5 text-sm text-danger">
                  <XCircle size={16} aria-hidden="true" />
                  {profileQuery.error instanceof Error
                    ? profileQuery.error.message
                    : "Could not load the profile. Sign in may be required."}
                </p>
                <button type="button" onClick={() => profileQuery.refetch()} className={btnGhost}>
                  <ArrowClockwise size={16} aria-hidden="true" /> Retry
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div className="flex gap-2">
                    <dt className="w-32 shrink-0 text-muted">Operator ID</dt>
                    <dd className="font-mono text-ink">{profileQuery.data.operator_id}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-32 shrink-0 text-muted">Active</dt>
                    <dd className="flex items-center gap-1.5 text-ink">
                      {profileQuery.data.active ? (
                        <>
                          <CheckCircle size={16} className="text-ok" aria-hidden="true" /> Yes
                        </>
                      ) : (
                        <>
                          <XCircle size={16} className="text-danger" aria-hidden="true" /> No
                        </>
                      )}
                    </dd>
                  </div>
                </dl>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="set-default-lang" className="mb-1 block text-sm font-medium text-ink">
                      Default language
                    </label>
                    <select
                      id="set-default-lang"
                      value={defaultLang}
                      onChange={(e) => setDefaultLang(e.target.value)}
                      className={inputCls}
                    >
                      {SUPPORTED_LANGUAGES.map((l) => (
                        <option key={l} value={l}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="set-mobile" className="mb-1 block text-sm font-medium text-ink">
                      Mobile (for call routing)
                    </label>
                    <input
                      id="set-mobile"
                      type="tel"
                      value={mobile}
                      onChange={(e) => setMobile(e.target.value)}
                      placeholder="+91…"
                      maxLength={30}
                      className={inputCls}
                    />
                  </div>
                </div>
                <p className="text-xs text-muted">
                  Known languages are edited in <a href="#languages" className="text-primary-dark hover:underline">Supported languages</a> below.
                </p>
                <button type="button" onClick={saveProfile} disabled={profileBusy} className={btnPrimary}>
                  {profileBusy ? "Saving…" : "Save profile"}
                </button>
                {profileMsg ? <FieldMsg ok={profileMsg.ok} text={profileMsg.text} /> : null}
              </div>
            )}
          </Section>

          {/* ---------- languages ---------- */}
          <Section
            id="languages"
            title="Supported languages"
            icon={<Translate size={20} aria-hidden="true" />}
            note="Saved to your server operator profile (known_languages)."
          >
            <fieldset>
              <legend className="sr-only">Languages you can take calls in</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {SUPPORTED_LANGUAGES.map((code) => (
                  <label
                    key={code}
                    className="flex cursor-pointer items-center gap-2 rounded-xl2 border border-line bg-paper px-3 py-2 text-sm text-ink"
                  >
                    <input
                      type="checkbox"
                      checked={langs.includes(code)}
                      onChange={() => toggleLang(code)}
                      className="h-4 w-4 accent-[#2563eb]"
                    />
                    {code}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="mt-3">
              <button type="button" onClick={saveLanguages} disabled={langsBusy} className={btnPrimary}>
                {langsBusy ? "Saving…" : "Save languages"}
              </button>
            </div>
            {langsMsg ? <FieldMsg ok={langsMsg.ok} text={langsMsg.text} /> : null}
          </Section>

          {/* ---------- audio ---------- */}
          <Section
            id="audio"
            title="Audio devices"
            icon={<Faders size={20} aria-hidden="true" />}
            note="Device choice is stored on this device."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="set-audio-in" className="mb-1 block text-sm font-medium text-ink">
                  Microphone
                </label>
                <select
                  id="set-audio-in"
                  value={prefs.audioInputId}
                  onChange={(e) => updatePrefs({ ...prefs, audioInputId: e.target.value })}
                  className={inputCls}
                >
                  {inputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="set-audio-out" className="mb-1 block text-sm font-medium text-ink">
                  Speaker
                </label>
                <select
                  id="set-audio-out"
                  value={prefs.audioOutputId}
                  onChange={(e) => updatePrefs({ ...prefs, audioOutputId: e.target.value })}
                  className={inputCls}
                >
                  {outputs.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={refreshDevices} className={btnGhost}>
                <ArrowClockwise size={16} aria-hidden="true" /> Refresh devices
              </button>
              <button type="button" onClick={requestMicAccess} className={btnGhost}>
                <Microphone size={16} aria-hidden="true" /> Request microphone access
              </button>
            </div>
            {audioMsg ? <FieldMsg ok={audioMsg.ok} text={audioMsg.text} /> : null}

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl2 border border-line bg-paper p-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <Microphone size={16} aria-hidden="true" /> Microphone test
                </h3>
                <div
                  role="meter"
                  aria-label="Microphone input level"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuetext={micLevelText || "idle"}
                  className="mt-2 h-2 overflow-hidden rounded bg-line"
                >
                  <div ref={meterRef} className="h-full bg-ok" style={{ width: "0%" }} aria-hidden="true" />
                </div>
                <p className="mt-1 text-xs text-muted">{micActive ? `Input level: ${micLevelText || "…"}` : "Speak to see your input level."}</p>
                {micActive ? (
                  <button type="button" onClick={stopMicTest} className={`${btnGhost} mt-2`}>
                    <Stop size={16} aria-hidden="true" /> Stop test
                  </button>
                ) : (
                  <button type="button" onClick={startMicTest} className={`${btnGhost} mt-2`}>
                    <Play size={16} aria-hidden="true" /> Start mic test
                  </button>
                )}
                {micError ? (
                  <p role="alert" className="mt-2 text-sm text-danger">{micError}</p>
                ) : null}
              </div>
              <div className="rounded-xl2 border border-line bg-paper p-3">
                <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                  <SpeakerHigh size={16} aria-hidden="true" /> Speaker test
                </h3>
                <p className="mt-1 text-xs text-muted">Plays a short synthesized tone (no network, no audio files).</p>
                <button type="button" onClick={playSpeakerTest} className={`${btnGhost} mt-2`}>
                  <Play size={16} aria-hidden="true" /> Play test tone
                </button>
                {spkNote ? <p role="status" className="mt-2 text-sm text-warn">{spkNote}</p> : null}
              </div>
            </div>
          </Section>

          {/* ---------- notifications ---------- */}
          <Section
            id="notifications"
            title="Notifications"
            icon={<Bell size={20} aria-hidden="true" />}
            note="Stored on this device."
          >
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={prefs.notifications.sound}
                  onChange={(e) =>
                    updatePrefs({ ...prefs, notifications: { ...prefs.notifications, sound: e.target.checked } })
                  }
                  className="h-4 w-4 accent-[#2563eb]"
                />
                Alert sound for new incidents
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={prefs.notifications.desktop}
                  onChange={(e) => {
                    if (e.target.checked) void enableDesktop();
                    else updatePrefs({ ...prefs, notifications: { ...prefs.notifications, desktop: false } });
                  }}
                  className="h-4 w-4 accent-[#2563eb]"
                />
                Desktop notifications {desktopPermission !== "unsupported" ? `(browser permission: ${desktopPermission})` : "(unsupported in this browser)"}
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={playBeep} className={btnGhost}>
                Test sound
              </button>
              <button type="button" onClick={sendTestNotification} className={btnGhost}>
                <BellRinging size={16} aria-hidden="true" /> Test desktop notification
              </button>
            </div>
            {notifMsg ? <p role="status" className="mt-2 text-sm text-muted">{notifMsg}</p> : null}
          </Section>

          {/* ---------- availability ---------- */}
          <Section
            id="availability"
            title="Availability schedule"
            icon={<CalendarCheck size={20} aria-hidden="true" />}
            note="Stored on this device."
          >
            <div className="max-w-xs">
              <label htmlFor="set-availability" className="mb-1 block text-sm font-medium text-ink">
                Current availability
              </label>
              <select
                id="set-availability"
                value={prefs.availability}
                onChange={(e) =>
                  updatePrefs({ ...prefs, availability: e.target.value as OperatorPrefs["availability"] })
                }
                className={inputCls}
              >
                {AVAILABILITY.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-2 text-xs text-muted">
              There is no server presence endpoint in this build: availability is kept on this device
              and does not change call routing.
            </p>
          </Section>

          {/* ---------- translation ---------- */}
          <Section
            id="translation"
            title="Translation behavior"
            icon={<Waveform size={20} aria-hidden="true" />}
          >
            <div className="space-y-2 text-sm text-ink">
              <p>
                Live translation is a <strong>per-call toggle</strong>: on an active call the operator
                enables private translation into their own language. The caller never hears it. Every
                toggle is written to the server audit trail, and the server default for a new call is{" "}
                <strong>off</strong>.
              </p>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={device.translationDefault}
                  onChange={(e) => {
                    const next = { ...device, translationDefault: e.target.checked };
                    setDevice(next);
                    saveDeviceSettings(next);
                  }}
                  className="h-4 w-4 accent-[#2563eb]"
                />
                Prefer translation on for new calls I take
              </label>
              <p className="text-xs text-muted">
                A preference stored on this device only — it does not change the server default. The
                operator on the call still toggles per call.
              </p>
              {/* Live-call surface is the queue agent's /live route. */}
              <a href="/live" className="inline-flex items-center gap-1.5 font-medium text-primary-dark hover:underline">
                <Waveform size={16} aria-hidden="true" /> Open live calls
              </a>
            </div>
          </Section>

          {/* ---------- recording ---------- */}
          <Section
            id="recording"
            title="Call recording preferences"
            icon={<FileAudio size={20} aria-hidden="true" />}
          >
            <label className="flex cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={device.recordMonitoring}
                onChange={(e) => {
                  const next = { ...device, recordMonitoring: e.target.checked };
                  setDevice(next);
                  saveDeviceSettings(next);
                }}
                className="h-4 w-4 accent-[#2563eb]"
              />
              Record my monitoring audio
              <span className="rounded-full bg-paper px-2 py-0.5 text-xs text-muted">local-only preference</span>
            </label>
            <p className="mt-2 text-xs text-muted">
              Fact: PSTN/call recording happens provider/Asterisk-side — this console has no recording
              endpoint. This toggle only records your preference on this device; monitoring capture is
              not implemented in this build.
            </p>
          </Section>

          {/* ---------- security ---------- */}
          <Section
            id="security"
            title="Security & MFA"
            icon={<ShieldCheck size={20} aria-hidden="true" />}
          >
            <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Key size={16} aria-hidden="true" /> Change password
            </h3>
            <div className="grid max-w-md gap-2">
              <div>
                <label htmlFor="pw-current" className="mb-1 block text-sm font-medium text-ink">Current password</label>
                <input id="pw-current" type="password" value={curPw} onChange={(e) => setCurPw(e.target.value)} autoComplete="current-password" className={inputCls} />
              </div>
              <div>
                <label htmlFor="pw-new" className="mb-1 block text-sm font-medium text-ink">New password (min 4 characters)</label>
                <input id="pw-new" type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} autoComplete="new-password" className={inputCls} />
              </div>
              <div>
                <label htmlFor="pw-confirm" className="mb-1 block text-sm font-medium text-ink">Confirm new password</label>
                <input id="pw-confirm" type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} autoComplete="new-password" className={inputCls} />
              </div>
              <div>
                <button type="button" onClick={submitPassword} disabled={pwBusy} className={btnPrimary}>
                  <LockKey size={16} aria-hidden="true" /> {pwBusy ? "Changing…" : "Change password"}
                </button>
              </div>
            </div>
            {pwMsg ? <FieldMsg ok={pwMsg.ok} text={pwMsg.text} /> : null}
            <div className="mt-4 rounded-xl2 border border-line bg-paper p-3">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <ShieldCheck size={16} aria-hidden="true" /> Multi-factor authentication
              </h3>
              <p className="mt-1 text-sm text-muted">
                There is no self-service MFA enrollment in this build. To enable MFA on your account,{" "}
                <strong className="text-ink">contact your administrator</strong>.
              </p>
            </div>
          </Section>

          {/* ---------- workspace ---------- */}
          <Section
            id="workspace"
            title="Workspace"
            icon={<Globe size={20} aria-hidden="true" />}
          >
            <dl className="space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 text-muted">API URL</dt>
                <dd className="break-all font-mono text-ink">{API_URL}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-32 shrink-0 text-muted">From</dt>
                <dd className="text-ink">NEXT_PUBLIC_API_URL environment value (public config — no secrets here)</dd>
              </div>
            </dl>
            <div className="mt-3 flex items-center gap-2">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Cpu size={16} aria-hidden="true" /> Service health
              </h3>
              <button type="button" onClick={() => healthQuery.refetch()} className={`${btnGhost} !px-2 !py-1 text-xs`}>
                <ArrowClockwise size={14} aria-hidden="true" /> Refresh
              </button>
            </div>
            {healthQuery.isPending ? (
              <div className="mt-2"><Skeleton /></div>
            ) : healthQuery.isError || !health ? (
              <p role="alert" className="mt-2 flex items-center gap-1.5 text-sm text-danger">
                <XCircle size={16} aria-hidden="true" />
                {healthQuery.error instanceof Error ? healthQuery.error.message : "Health check failed."}
              </p>
            ) : (
              <ul className="mt-2 space-y-1.5 text-sm">
                <li className="flex items-center gap-1.5">
                  {healthTone === "green" ? (
                    <CheckCircle size={16} className="text-ok" aria-hidden="true" />
                  ) : healthTone === "amber" ? (
                    <Warning size={16} className="text-warn" aria-hidden="true" />
                  ) : (
                    <XCircle size={16} className="text-danger" aria-hidden="true" />
                  )}
                  <span className="text-ink">API: {health.status}</span>
                </li>
                <li className="flex items-center gap-1.5">
                  {health.sarvam ? (
                    <Check size={16} className="text-ok" aria-hidden="true" />
                  ) : (
                    <XCircle size={16} className="text-danger" aria-hidden="true" />
                  )}
                  <span className="text-ink">Telephony/AI (Sarvam): {health.sarvam ? "reachable" : "unreachable"}</span>
                </li>
                <li className="flex items-center gap-1.5">
                  {health.gemini ? (
                    <Check size={16} className="text-ok" aria-hidden="true" />
                  ) : (
                    <XCircle size={16} className="text-danger" aria-hidden="true" />
                  )}
                  <span className="text-ink">AI (Gemini): {health.gemini ? "reachable" : "unreachable"}</span>
                </li>
                {health.store ? (
                  <li className="flex items-center gap-1.5 text-ink">
                    <PlugsConnected size={16} className="text-muted" aria-hidden="true" /> Store: {health.store}
                    {health.db ? ` · DB: ${health.db}` : null}
                  </li>
                ) : null}
              </ul>
            )}
            <div className="mt-4 rounded-xl2 border border-line bg-paper p-3 text-sm">
              <p className="text-muted">
                There is no session-list endpoint in this build. Changing your password signs out all
                other sessions server-side; the button below signs out this device.
              </p>
              <button type="button" onClick={signOut} className={`${btnGhost} mt-2`}>
                <SignOut size={16} aria-hidden="true" /> Sign out this device
              </button>
            </div>
          </Section>

          {/* ---------- team ---------- */}
          <Section
            id="team"
            title="Team roles"
            icon={<Users size={20} aria-hidden="true" />}
          >
            <p className="flex items-center gap-1.5 text-sm text-ink">
              <Info size={16} className="text-muted" aria-hidden="true" />
              {session ? (
                <>Signed in as <strong>{session.name}</strong> (role: <strong>{session.role}</strong>).</>
              ) : (
                "Not signed in on this device."
              )}
            </p>
            <p className="mt-1 text-xs text-muted">
              Roles are assigned server-side and cannot be changed here. There is no team-management
              endpoint — operator registration is the only team action available.
            </p>
            <h3 className="mb-2 mt-4 text-sm font-semibold text-ink">Register a new operator</h3>
            <div className="grid max-w-md gap-2">
              <div>
                <label htmlFor="reg-name" className="mb-1 block text-sm font-medium text-ink">Operator name</label>
                <input id="reg-name" value={regName} onChange={(e) => setRegName(e.target.value)} maxLength={100} autoComplete="off" className={inputCls} />
              </div>
              <div>
                <label htmlFor="reg-pw" className="mb-1 block text-sm font-medium text-ink">Temporary password (min 4 characters)</label>
                <input id="reg-pw" type="password" value={regPw} onChange={(e) => setRegPw(e.target.value)} autoComplete="new-password" className={inputCls} />
              </div>
              <div>
                <button type="button" onClick={submitRegister} disabled={regBusy} className={btnPrimary}>
                  <Users size={16} aria-hidden="true" /> {regBusy ? "Registering…" : "Register operator"}
                </button>
              </div>
            </div>
            {regMsg ? <FieldMsg ok={regMsg.ok} text={regMsg.text} /> : null}
            <p className="mt-2 text-xs text-muted">
              The first registered operator becomes admin. Afterwards, admin sign-in is required to
              register anyone else (the server answers 401/403 otherwise), and roles are set
              server-side — this form has no role picker on purpose.
            </p>
          </Section>
        </div>
      </div>
    </Shell>
  );
}
