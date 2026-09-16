import { describe, expect, it, vi, afterEach } from "vitest";
import { createAdapter, SaarasRealtimeAdapter, type SocketLike } from "./saaras.js";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  private handlers = new Map<string, Array<(...args: any[]) => void>>();

  on(event: "open" | "message" | "error" | "close", cb: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }

  emit(event: string, ...args: any[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

const PREV_REALTIME = process.env.REALTIME;
const PREV_KEY = process.env.SARVAM_API_KEY;

afterEach(() => {
  if (PREV_REALTIME === undefined) delete process.env.REALTIME;
  else process.env.REALTIME = PREV_REALTIME;
  if (PREV_KEY === undefined) delete process.env.SARVAM_API_KEY;
  else process.env.SARVAM_API_KEY = PREV_KEY;
  vi.unstubAllGlobals();
});

function callbacks() {
  return {
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("createAdapter", () => {
  it("defaults to passthrough transport", () => {
    delete process.env.REALTIME;
    expect(createAdapter().kind).toBe("passthrough");
  });

  it("selects the Saaras realtime adapter when REALTIME=saaras", () => {
    process.env.REALTIME = "saaras";
    expect(createAdapter().kind).toBe("saaras-realtime");
  });
});

describe("SaarasRealtimeAdapter", () => {
  it("refuses to connect without an API key", async () => {
    delete process.env.SARVAM_API_KEY;
    const adapter = new SaarasRealtimeAdapter({ createSocket: () => new FakeSocket() });
    await expect(adapter.connect("CALL-A", callbacks())).rejects.toThrow(/SARVAM_API_KEY/);
  });

  it("streams base64 audio_input frames and routes partials/finals", async () => {
    process.env.SARVAM_API_KEY = "test-key";
    let socket: FakeSocket | null = null;
    let seenUrl = "";
    const adapter = new SaarasRealtimeAdapter({
      languageCode: "mr-IN",
      createSocket: (url) => {
        seenUrl = url;
        socket = new FakeSocket();
        // Open asynchronously like a real socket.
        setTimeout(() => socket!.emit("open"), 0);
        return socket;
      },
    });
    const cb = callbacks();
    const session = await adapter.connect("CALL-A", cb);
    expect(seenUrl).toContain("language_code=mr-IN");
    expect(seenUrl).toContain("saaras%3Av3-realtime");

    session.sendAudio(new Uint8Array([1, 2, 3]));
    const frame = JSON.parse(socket!.sent[0]) as { event: string; audio: string };
    expect(frame.event).toBe("audio_input");
    expect(Buffer.from(frame.audio, "base64")).toEqual(Buffer.from([1, 2, 3]));

    socket!.emit("message", JSON.stringify({ event: "transcript.partial", text: "aag", language: "mr-IN" }));
    socket!.emit("message", JSON.stringify({ event: "transcript.final", text: "aag lagli", language: "mr-IN" }));
    expect(cb.onPartial).toHaveBeenCalledWith("aag", "mr-IN");
    expect(cb.onFinal).toHaveBeenCalledWith("aag lagli", "mr-IN");

    session.close();
    expect(JSON.parse(socket!.sent.at(-1)!)).toEqual({ event: "end" });
    expect(socket!.closed).toBe(true);
  });

  it("surfaces fatal server errors and closes the session", async () => {
    process.env.SARVAM_API_KEY = "test-key";
    let socket: FakeSocket | null = null;
    const adapter = new SaarasRealtimeAdapter({
      createSocket: () => {
        socket = new FakeSocket();
        setTimeout(() => socket!.emit("open"), 0);
        return socket;
      },
    });
    const cb = callbacks();
    const session = await adapter.connect("CALL-A", cb);
    void session;
    socket!.emit("message", JSON.stringify({ event: "error", code: 4000, is_fatal: true, message: "bad params" }));
    expect(cb.onError).toHaveBeenCalledTimes(1);
    expect(socket!.closed).toBe(true);
    // Non-fatal errors report but keep the session open.
    socket!.closed = false;
    socket!.emit("message", JSON.stringify({ event: "error", code: 1011, is_fatal: false, message: "blip" }));
    expect(cb.onError).toHaveBeenCalledTimes(2);
    expect(socket!.closed).toBe(false);
  });

  it("ignores malformed frames without crashing", async () => {
    process.env.SARVAM_API_KEY = "test-key";
    let socket: FakeSocket | null = null;
    const adapter = new SaarasRealtimeAdapter({
      createSocket: () => {
        socket = new FakeSocket();
        setTimeout(() => socket!.emit("open"), 0);
        return socket;
      },
    });
    const cb = callbacks();
    await adapter.connect("CALL-A", cb);
    socket!.emit("message", "not-json{{{");
    socket!.emit("message", JSON.stringify({ event: "session.begin" }));
    socket!.emit("message", JSON.stringify({ event: "transcript.partial" }));
    expect(cb.onPartial).not.toHaveBeenCalled();
    expect(cb.onError).not.toHaveBeenCalled();
  });
});
