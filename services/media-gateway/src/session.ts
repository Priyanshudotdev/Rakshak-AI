// Call session management for the media gateway (spec §7).
// Transport-only: tracks audio buffers, activity and lifecycle per call.
// No incident-intelligence logic lives here.

export interface CallSession {
  callId: string;
  from?: string;
  to?: string;
  startedAt: string;
  lastActivityAt: number;
  chunks: Buffer[];
  bufferedBytes: number;
  partials: number;
  utterances: number;
  ttsStopped: boolean;
}

export class SessionManager {
  private sessions = new Map<string, CallSession>();
  constructor(
    private readonly maxSessions: number = 200,
    private readonly maxBufferedBytes: number = 20 * 1024 * 1024,
  ) {}

  get size(): number {
    return this.sessions.size;
  }

  start(callId: string, from?: string, to?: string): CallSession {
    const existing = this.sessions.get(callId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return existing;
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error("gateway at capacity");
    }
    const session: CallSession = {
      callId,
      from,
      to,
      startedAt: new Date().toISOString(),
      lastActivityAt: Date.now(),
      chunks: [],
      bufferedBytes: 0,
      partials: 0,
      utterances: 0,
      ttsStopped: false,
    };
    this.sessions.set(callId, session);
    return session;
  }

  get(callId: string): CallSession | undefined {
    return this.sessions.get(callId);
  }

  /** Append an audio chunk. Returns false when the session buffer is full (backpressure). */
  pushAudio(callId: string, chunk: Buffer): boolean {
    const session = this.sessions.get(callId);
    if (!session) return false;
    if (session.bufferedBytes + chunk.length > this.maxBufferedBytes) return false;
    session.chunks.push(chunk);
    session.bufferedBytes += chunk.length;
    session.lastActivityAt = Date.now();
    return true;
  }

  touch(callId: string): void {
    const session = this.sessions.get(callId);
    if (session) session.lastActivityAt = Date.now();
  }

  markPartial(callId: string): void {
    const session = this.sessions.get(callId);
    if (session) {
      session.partials += 1;
      session.lastActivityAt = Date.now();
    }
  }

  stopTts(callId: string): boolean {
    const session = this.sessions.get(callId);
    if (!session) return false;
    session.ttsStopped = true;
    session.lastActivityAt = Date.now();
    return true;
  }

  /** Drain the buffer for one utterance and re-arm the session for the next turn. */
  takeAudio(callId: string): { bytes: Buffer; session: CallSession } | null {
    const session = this.sessions.get(callId);
    if (!session || !session.chunks.length) return null;
    const bytes = Buffer.concat(session.chunks);
    session.chunks = [];
    session.bufferedBytes = 0;
    session.utterances += 1;
    session.lastActivityAt = Date.now();
    return { bytes, session };
  }

  end(callId: string): CallSession | undefined {
    const session = this.sessions.get(callId);
    if (session) this.sessions.delete(callId);
    return session;
  }

  /** Sessions idle longer than `idleMs`. Caller ends them (call.ended) and drops them. */
  sweepIdle(idleMs: number): CallSession[] {
    const now = Date.now();
    const idle: CallSession[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivityAt > idleMs) {
        idle.push(session);
        this.sessions.delete(id);
      }
    }
    return idle;
  }
}
