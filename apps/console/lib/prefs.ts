/** Operator-side preferences. Local-only (localStorage) except the language pair,
 *  which mirrors the server OperatorProfile (known/default languages). */

export interface OperatorPrefs {
  preferredLanguage: string;
  knownLanguages: string[];
  audioInputId: string;
  audioOutputId: string;
  notifications: { sound: boolean; desktop: boolean };
  availability: "Available" | "Busy" | "Away" | "Offline";
}

const KEY = "rakshak.console.prefs";

export const DEFAULT_PREFS: OperatorPrefs = {
  preferredLanguage: "hi-IN",
  knownLanguages: ["hi-IN", "en-IN"],
  audioInputId: "default",
  audioOutputId: "default",
  notifications: { sound: true, desktop: false },
  availability: "Available",
};

export function loadPrefs(): OperatorPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<OperatorPrefs>;
    return {
      ...DEFAULT_PREFS,
      ...parsed,
      notifications: { ...DEFAULT_PREFS.notifications, ...(parsed.notifications ?? {}) },
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: OperatorPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

export interface AudioDevice {
  deviceId: string;
  label: string;
}

/** Real device enumeration; labels need a granted mic permission, hence the fallback names. */
export async function enumerateAudioDevices(): Promise<{ inputs: AudioDevice[]; outputs: AudioDevice[] }> {
  const empty = { inputs: [{ deviceId: "default", label: "Default microphone" }], outputs: [{ deviceId: "default", label: "Default speaker" }] };
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return empty;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ deviceId: d.deviceId || "default", label: d.label || `Microphone ${i + 1}` }));
    const outputs = devices
      .filter((d) => d.kind === "audiooutput")
      .map((d, i) => ({ deviceId: d.deviceId || "default", label: d.label || `Speaker ${i + 1}` }));
    return {
      inputs: inputs.length ? inputs : empty.inputs,
      outputs: outputs.length ? outputs : empty.outputs,
    };
  } catch {
    return empty;
  }
}
