// Versioned event envelope helpers — keeps gateway/api/dashboard on one contract.
import type { RakshakEvent, RakshakEventName } from "@rakshak/types";

export const EVENT_VERSION = "v2";

export function makeEvent<T>(name: RakshakEventName, callId: string, payload: T): RakshakEvent<T> {
  return { name, callId, at: new Date().toISOString(), payload };
}
