/**
 * Console-side utterance playback.
 *
 * Honesty scope: this plays back SERVER-SYNTHESIZED speech (POST /api/tts via
 * lib/api synthesize) of transcript text through the operator's speakers. It
 * is NOT the live PSTN audio, and there is intentionally no microphone path
 * here — mic testing belongs to onboarding. Volume + output-device selection
 * apply to this playback element only.
 */

let el: HTMLAudioElement | null = null;
let volume = 1;
let sinkId = "default";
let currentUrl: string | null = null;

function ensureEl(onEnded?: () => void): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
  }
  el.volume = volume;
  if (onEnded) {
    el.onended = onEnded;
  }
  if (sinkId && sinkId !== "default") {
    const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    try {
      const r = withSink.setSinkId?.(sinkId);
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* device routing unsupported — default output still plays */
    }
  }
  return el;
}

export function setPlaybackVolume(v: number): void {
  volume = Math.min(1, Math.max(0, v));
  if (el) el.volume = volume;
}

export function setPlaybackSink(id: string): void {
  sinkId = id || "default";
}

export function stopPlayback(): void {
  try {
    el?.pause();
  } catch {
    /* ignore */
  }
}

/** Sniff container from base64 magic: RIFF....WAVE -> wav, else mpeg. */
function mimeFor(base64: string): string {
  const head = base64.slice(0, 20);
  if (head.startsWith("UklGR")) return "audio/wav";
  return "audio/mpeg";
}

/** Play base64 audio returned by POST /api/tts. Resolves when playback ends. */
export function playBase64(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      const bin = atob(base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: mimeFor(base64) });
      currentUrl = URL.createObjectURL(blob);
      const node = ensureEl(() => resolve());
      node.onerror = () => reject(new Error("Audio playback failed in this browser."));
      node.src = currentUrl;
      const started = node.play();
      if (started && typeof started.catch === "function") {
        started.catch((err: unknown) => reject(err instanceof Error ? err : new Error("Audio playback failed.")));
      }
    } catch (err) {
      reject(err instanceof Error ? err : new Error("Audio playback failed."));
    }
  });
}

/** True when the browser can route this playback to a chosen output device. */
export function canSelectSink(): boolean {
  try {
    return typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;
  } catch {
    return false;
  }
}
