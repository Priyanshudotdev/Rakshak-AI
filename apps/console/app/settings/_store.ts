"use client";

/**
 * Device-local settings that have NO server counterpart (honestly labeled at
 * every call site as "stored on this device"):
 * - recordMonitoring: preference for capturing the operator's own monitoring
 *   audio. No recording endpoint exists in this build, so this is a
 *   preference flag only — monitoring capture is not implemented.
 * - translationDefault: the operator's preferred starting point for the
 *   per-call live-translation toggle. The toggle itself is per call
 *   (POST /api/calls/:id/translation, server default OFF); this flag does
 *   not change server behaviour.
 *
 * Everything with a server source of truth (profile languages, audio device
 * ids, notifications, availability) lives in lib/prefs.ts + the API and is
 * loaded/saved through those paths instead.
 */

export interface DeviceSettings {
  recordMonitoring: boolean;
  translationDefault: boolean;
}

const KEY = "rakshak.console.settings.device";

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  recordMonitoring: false,
  translationDefault: false,
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function loadDeviceSettings(): DeviceSettings {
  if (!isBrowser()) return { ...DEFAULT_DEVICE_SETTINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_DEVICE_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<DeviceSettings>;
    return {
      recordMonitoring: parsed.recordMonitoring ?? DEFAULT_DEVICE_SETTINGS.recordMonitoring,
      translationDefault: parsed.translationDefault ?? DEFAULT_DEVICE_SETTINGS.translationDefault,
    };
  } catch {
    return { ...DEFAULT_DEVICE_SETTINGS };
  }
}

export function saveDeviceSettings(next: DeviceSettings): void {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode */
  }
}
