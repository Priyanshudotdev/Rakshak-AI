// Sarvam Saaras Realtime adapter boundary (spec §8).
//
// The live path (Asterisk External Media → Saaras Realtime → partials) plugs in
// here in the Asterisk phase. Until then the gateway runs in replay/file mode:
// it accepts complete audio over WS, forwards it to the API batch endpoint,
// and relays client- or STT-provided partial frames as transcript.partial events.
//
// This file intentionally contains no fake STT — partials are only emitted
// when a real source (client mic agent or Saaras session) provides them.

export interface RealtimeCallbacks {
  onPartial: (text: string, language?: string) => void;
  onFinal: (text: string, language?: string) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}

export interface RealtimeSession {
  sendAudio(_chunk: Uint8Array): void;
  close(): void;
}

export interface RealtimeAdapter {
  readonly kind: string;
  connect(_callId: string, _cb: RealtimeCallbacks): Promise<RealtimeSession>;
}

/** Pass-through adapter: relays externally provided partials, performs no recognition. */
export class PassthroughAdapter implements RealtimeAdapter {
  readonly kind = "passthrough";
  async connect(_callId: string, _cb: RealtimeCallbacks): Promise<RealtimeSession> {
    return {
      sendAudio() {
        /* buffered by the session manager for finalize */
      },
      close() {
        /* nothing held */
      },
    };
  }
}

export function createAdapter(): RealtimeAdapter {
  // REALTIME=saaras enables the Saaras Realtime WebSocket session here (Asterisk phase).
  // Until SARVAM_API_KEY + Asterisk media are wired, passthrough keeps the
  // transport verifiable without pretending to transcribe.
  if ((process.env.REALTIME ?? "").toLowerCase() === "saaras") {
    throw new Error("Saaras Realtime adapter is not wired yet — unset REALTIME to run replay/file mode");
  }
  return new PassthroughAdapter();
}
