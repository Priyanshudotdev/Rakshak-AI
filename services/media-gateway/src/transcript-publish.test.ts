import { describe, expect, it, vi, afterEach } from "vitest";
import { AriController, type SocketLike } from "./ari.js";
import type { RealtimeAdapter, RealtimeCallbacks } from "./saaras.js";

class FakeSocket implements SocketLike {
  private handlers = new Map<string, Array<(...args: any[]) => void>>();
  on(event: "open" | "message" | "error" | "close", cb: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? [];
    list.push(cb);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: any[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...args);
  }
  send(): void {}
  close(): void {}
}

function setupCapturingAdapter() {
  const captured = new Map<string, RealtimeCallbacks>();
  const adapter: RealtimeAdapter = {
    kind: "test-capture",
    connect: async (callId: string, cb: RealtimeCallbacks) => {
      captured.set(callId, cb);
      return { sendAudio: () => undefined, close: () => undefined };
    },
  };
  return { adapter, captured };
}

function setupController() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let ext = 0;
  let snoops = 0;
  let bridges = 0;
  const fetchFn = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init.method ?? "GET", url: String(url), body });
    const u = String(url);
    if (u.includes("/channels/externalMedia")) {
      ext += 1;
      return { ok: true, json: async () => ({ id: `ext-pub-${ext}` }) };
    }
    if (u.includes("/snoop")) {
      snoops += 1;
      return { ok: true, json: async () => ({ id: `snoop-pub-${snoops}` }) };
    }
    if (u.includes("/bridges") && (init.method ?? "GET") === "POST" && !u.includes("addChannel")) {
      bridges += 1;
      return { ok: true, json: async () => ({ id: `bridge-pub-${bridges}` }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  const { adapter, captured } = setupCapturingAdapter();
  const published: Array<{ name: string; callId: string; payload: Record<string, unknown> }> = [];
  let socket: FakeSocket | null = null;
  const finals: Array<{ callId: string; text: string; language: string | undefined; role: string }> = [];
  const controller = new AriController(
    {
      adapter,
      publish: (name, callId, payload) =>
        void published.push({ name, callId, payload: (payload ?? {}) as Record<string, unknown> }),
      log: () => undefined,
      onFinalTranscript: (callId, text, language, role) => void finals.push({ callId, text, language, role }),
    },
    {
      baseUrl: "http://asterisk:8088",
      rtpHost: "127.0.0.1",
      rtpPortBase: 39000 + Math.floor(Math.random() * 2000),
      createSocket: () => {
        socket = new FakeSocket();
        setTimeout(() => socket!.emit("open"), 0);
        return socket;
      },
      fetchFn: fetchFn as unknown as typeof fetch,
    },
  );
  return { controller, published, finals, captured, socket: () => socket as unknown as FakeSocket };
}

async function startCaller(ctx: ReturnType<typeof setupController>, channelId: string) {
  await ctx.controller.start();
  ctx.socket().emit(
    "message",
    JSON.stringify({
      type: "StasisStart",
      channel: { id: channelId, name: "PJSIP/9000-00000001", caller: { number: "9000000001" } },
      args: ["9000"],
    }),
  );
  await new Promise((r) => setTimeout(r, 60));
  const callId = `ARI-${channelId.slice(0, 8).toUpperCase()}`;
  const cb = ctx.captured.get(callId);
  if (!cb) throw new Error(`no realtime session for ${callId}`);
  return { callId, cb };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("forkMedia transcript publish shape (transcript.partial/final)", () => {
  it("partials carry original_text + language fallback + caller role on the leg callId", async () => {
    const ctx = setupController();
    const { callId, cb } = await startCaller(ctx, "chan-pub-01");
    ctx.published.length = 0;
    cb.onPartial("aag lagli", "mr-IN");
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({
      name: "transcript.partial",
      callId,
      payload: { original_text: "aag lagli", language: "mr-IN", role: "caller" },
    });
    await ctx.controller.shutdown();
  });

  it("missing language falls back to Unknown and blank frames never publish", async () => {
    const ctx = setupController();
    const { callId, cb } = await startCaller(ctx, "chan-pub-02");
    ctx.published.length = 0;
    cb.onPartial("help", undefined);
    expect(ctx.published[0]?.payload).toMatchObject({
      original_text: "help",
      language: "Unknown",
      role: "caller",
    });
    const before = ctx.published.length;
    cb.onPartial("", "mr-IN");
    cb.onPartial("   ", "mr-IN");
    // @ts-expect-error contract probe: undefined text must never publish
    cb.onPartial(undefined, "mr-IN");
    expect(ctx.published).toHaveLength(before);
    expect(callId.startsWith("ARI-")).toBe(true);
    await ctx.controller.shutdown();
  });

  it("finals always land with text + language + role + confidence and drive onFinalTranscript", async () => {
    const ctx = setupController();
    const { callId, cb } = await startCaller(ctx, "chan-pub-03");
    ctx.published.length = 0;
    ctx.finals.length = 0;
    cb.onFinal("aag lagli aahe", "mr-IN", 0.92);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({
      name: "transcript.final",
      callId,
      payload: { original_text: "aag lagli aahe", language: "mr-IN", role: "caller", confidence: 0.92 },
    });
    expect(ctx.finals).toHaveLength(1);
    expect(ctx.finals[0]).toMatchObject({ callId, role: "caller" });
    // Blank finals never publish and never drive the conversation loop.
    cb.onFinal("   ", "mr-IN", 0.9);
    expect(ctx.published).toHaveLength(1);
    expect(ctx.finals).toHaveLength(1);
    await ctx.controller.shutdown();
  });

  it("operator legs publish role=operator on the operator callId", async () => {
    const ctx = setupController();
    const callerId = "chan-pub-op-caller";
    await ctx.controller.start();
    ctx.socket().emit(
      "message",
      JSON.stringify({
        type: "StasisStart",
        channel: { id: callerId, name: "PJSIP/9000-1", caller: { number: "9000000001" } },
        args: ["9000"],
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    ctx.socket().emit(
      "message",
      JSON.stringify({
        type: "StasisStart",
        channel: { id: "chan-pub-op-leg", name: "PJSIP/1001-1", caller: { number: "1001" } },
        args: ["9002"],
      }),
    );
    await new Promise((r) => setTimeout(r, 60));
    const opCallId = `ARI-OP-${"chan-pub-op-leg".slice(0, 8).toUpperCase()}`;
    const opCb = ctx.captured.get(opCallId);
    expect(opCb).toBeTruthy();
    ctx.published.length = 0;
    opCb!.onPartial("help is coming", "en-IN");
    expect(ctx.published[0]).toMatchObject({
      name: "transcript.partial",
      callId: opCallId,
      payload: { original_text: "help is coming", language: "en-IN", role: "operator" },
    });
    ctx.published.length = 0;
    opCb!.onFinal("help is coming", undefined, 0.8);
    expect(ctx.published[0]).toMatchObject({
      name: "transcript.final",
      callId: opCallId,
      payload: { original_text: "help is coming", language: "Unknown", role: "operator" },
    });
    await ctx.controller.shutdown();
  });

  it("partials faster than ~5/s coalesce; finals always land and re-arm partials", async () => {
    vi.useFakeTimers();
    // Drive Date.now manually — PartialThrottle defaults to Date.now.
    let now = 50_000;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => now);
    void spy;
    const ctx = setupController();
    // startCaller awaits real timers; with fake timers use real advance.
    // Switch back to real timers for the async setup, then fake for the burst.
    vi.useRealTimers();
    const { cb } = await startCaller(ctx, "chan-pub-04");
    vi.useFakeTimers();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    ctx.published.length = 0;
    // Burst of 10 partials in the same ms: only the leading edge publishes.
    for (let i = 0; i < 10; i++) cb.onPartial(`frame-${i}`, "mr-IN");
    const partials = ctx.published.filter((p) => p.name === "transcript.partial");
    expect(partials).toHaveLength(1);
    expect(partials[0]?.payload).toMatchObject({ original_text: "frame-0" });
    // A final inside the throttle window still lands...
    cb.onFinal("final-now", "mr-IN", 0.9);
    expect(ctx.published.filter((p) => p.name === "transcript.final")).toHaveLength(1);
    // ...and re-arms the window so the next partial is immediate.
    cb.onPartial("after-final", "mr-IN");
    const after = ctx.published.filter((p) => p.name === "transcript.partial");
    expect(after).toHaveLength(2);
    expect(after[1]?.payload).toMatchObject({ original_text: "after-final" });
    // Next-window partial publishes again once 200 ms elapse.
    cb.onPartial("too-soon", "mr-IN");
    expect(ctx.published.filter((p) => p.name === "transcript.partial")).toHaveLength(2);
    now += 200;
    cb.onPartial("next-window", "mr-IN");
    expect(ctx.published.filter((p) => p.name === "transcript.partial")).toHaveLength(3);
    vi.useRealTimers();
    await ctx.controller.shutdown();
  });
});
