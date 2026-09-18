import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AriController, buildWav16, normalizeCli, OPERATOR_HOLD_MESSAGE, parseWavHeader, resampleLinear16, rtpPayload, type SocketLike } from "./ari.js";
import type { RealtimeAdapter } from "./saaras.js";

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

function rtpPacket(payload: number[], ssrc = 0x1234): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80;
  header[1] = 0x00;
  header.writeUInt16BE(7, 2);
  header.writeUInt32BE(160, 4);
  header.writeUInt32BE(ssrc, 8);
  return Buffer.concat([header, Buffer.from(payload)]);
}

describe("rtpPayload", () => {
  it("strips the 12-byte header", () => {
    expect([...rtpPayload(rtpPacket([1, 2, 3]))]).toEqual([1, 2, 3]);
  });

  it("skips CSRC identifiers", () => {
    const header = Buffer.alloc(12);
    header[0] = 0x81; // CC=1
    header[1] = 0x00;
    const packet = Buffer.concat([header, Buffer.from([9, 9, 9, 9]), Buffer.from([5])]);
    expect([...rtpPayload(packet)]).toEqual([5]);
  });

  it("returns empty for short or truncated packets", () => {
    expect(rtpPayload(Buffer.from([1, 2])).length).toBe(0);
    expect(rtpPayload(Buffer.alloc(0)).length).toBe(0);
  });
});

describe("buildWav16", () => {
  it("round-trips through the chunk parser", () => {
    const wav = buildWav16(new Int16Array([0, 1000, -1000, 300]), 8000);
    expect(parseWavHeader(wav)).toMatchObject({ sampleRate: 8000, channels: 1, bits: 16, dataLength: 8 });
  });
});

describe("tts helpers", () => {
  it("resamples by linear interpolation", () => {
    const out = resampleLinear16(new Int16Array([0, 100, 200, 300]), 4, 2);
    expect([...out]).toEqual([0, 200]);
    expect(resampleLinear16(new Int16Array([5]), 16000, 16000)).toEqual(new Int16Array([5]));
  });

  function wavWithJunk(): Buffer {
    const parts: Buffer[] = [Buffer.from("RIFF....WAVE")] as Buffer[];
    const head = parts[0];
    head.writeUInt32LE(60, 4);
    const junk = Buffer.alloc(8 + 10);
    junk.write("JUNK", 0);
    junk.writeUInt32LE(10, 4);
    const fmt = Buffer.alloc(8 + 16);
    fmt.write("fmt ", 0);
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(22050, 12);
    fmt.writeUInt16LE(1, 8 + 10);
    fmt.writeUInt16LE(16, 8 + 22 - 8);
    const data = Buffer.alloc(8 + 4);
    data.write("data", 0);
    data.writeUInt32LE(4, 4);
    return Buffer.concat([head, junk, fmt, data]);
  }

  it("parses wav headers and rejects junk", () => {
    const wav = Buffer.alloc(48);
    wav.write("RIFF", 0);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(22050, 24);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(4, 40);
    expect(parseWavHeader(wav)).toMatchObject({ dataOffset: 44, sampleRate: 22050, channels: 1, bits: 16 });
    expect(parseWavHeader(Buffer.from("junk"))).toBeNull();
  });

  it("finds the data chunk past JUNK sections", () => {
    // head(12) + junk(18) + fmt(24) = data header at 54, samples at 62.
    const parsed = parseWavHeader(wavWithJunk());
    expect(parsed).toMatchObject({ dataOffset: 62, sampleRate: 22050, channels: 1, bits: 16, dataLength: 4 });
  });
});

describe("AriController", () => {
  function setup(extraOpts: Record<string, unknown> = {}, extraHooks: Record<string, unknown> = {}) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const fetchFn = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
      const body = init.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method: init.method ?? "GET", url: String(url), body });
      const path = String(url);
      if (path.includes("/channels/externalMedia")) return { ok: true, json: async () => ({ id: "ext-1" }) };
      if (path.includes("/bridges") && (init.method ?? "GET") === "POST" && !path.includes("addChannel")) {
        return { ok: true, json: async () => ({ id: "bridge-1" }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const sentAudio: Uint8Array[] = [];
    const adapter: RealtimeAdapter = {
      kind: "test",
      connect: async () => ({ sendAudio: (c: Uint8Array) => void sentAudio.push(c), close: () => undefined }),
    };
    const published: Array<{ name: string; callId: string }> = [];
    let socket: FakeSocket | null = null;
    const controller = new AriController(
      {
        adapter,
        publish: (name, callId) => void published.push({ name, callId }),
        log: () => undefined,
        ...extraHooks,
      },
      {
        baseUrl: "http://asterisk:8088",
        rtpHost: "127.0.0.1",
        rtpPortBase: 33000 + Math.floor(Math.random() * 2000),
        createSocket: () => {
          socket = new FakeSocket();
          setTimeout(() => socket!.emit("open"), 0);
          return socket;
        },
        fetchFn: fetchFn as unknown as typeof fetch,
        ...extraOpts,
      },
    );
    return { controller, calls, sentAudio, published, socket: () => socket as unknown as FakeSocket };
  }

  async function startCall(ctx: ReturnType<typeof setup>, channelId = "chan-abc-12345678") {
    await ctx.controller.start();
    ctx.socket().emit(
      "message",
      JSON.stringify({
        type: "StasisStart",
        channel: { id: channelId, caller: { number: "1001" } },
        args: ["9000"],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    return channelId;
  }

  it("answers, forks external media and bridges on StasisStart", async () => {
    const ctx = setup();
    await startCall(ctx);
    const urls = ctx.calls.map((c) => `${c.method} ${c.url.split("/ari/")[1]?.split("?")[0]}`);
    expect(urls).toContain("POST channels/chan-abc-12345678/answer");
    const ext = ctx.calls.find((c) => c.url.includes("externalMedia"));
    expect(ext?.body).toMatchObject({ format: "slin16", encapsulation: "rtp" });
    expect(String((ext?.body as { external_host?: string })?.external_host)).toMatch(/^127\.0\.0\.1:\d+$/);
    expect(urls).toContain("POST bridges");
    const add = ctx.calls.find((c) => c.url.includes("addChannel"));
    expect(add?.body).toEqual({ channel: ["chan-abc-12345678", "ext-1"] });
    expect(ctx.published[0]).toMatchObject({ name: "call.answered" });
  });

  it("routes RTP payloads into the realtime adapter", async () => {
    const ctx = setup();
    const channelId = await startCall(ctx);
    ctx.controller.feedRtp(channelId, rtpPacket([10, 20, 30]));
    expect(ctx.sentAudio).toHaveLength(1);
    expect([...ctx.sentAudio[0]]).toEqual([10, 20, 30]);
    ctx.controller.feedRtp("unknown-channel", rtpPacket([1]));
    expect(ctx.sentAudio).toHaveLength(1);
  });

  it("tears down bridge, caller and media fork on StasisEnd", async () => {
    const ctx = setup();
    const channelId = await startCall(ctx);
    ctx.socket().emit("message", JSON.stringify({ type: "StasisEnd", channel: { id: channelId } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.calls.some((c) => c.method === "DELETE" && c.url.includes("bridges/bridge-1"))).toBe(true);
    const hangups = ctx.calls.filter((c) => c.method === "POST" && c.url.includes("/hangup")).map((c) => c.url);
    expect(hangups.some((u) => u.includes("chan-abc-12345678"))).toBe(true);
    expect(hangups.some((u) => u.includes("ext-1"))).toBe(true);
    expect(ctx.published.at(-1)).toMatchObject({ name: "call.ended" });
  });

  it("ignores its own media forks and duplicate starts (no fork cascade)", async () => {
    const ctx = setup();
    await ctx.controller.start();
    const emit = (id: string, name: string, args: string[]) =>
      ctx.socket().emit("message", JSON.stringify({ type: "StasisStart", channel: { id, name }, args }));
    emit("chan-dup-01", "PJSIP/1001-00000001", ["9000"]);
    emit("chan-dup-01", "PJSIP/1001-00000001", ["9000"]);
    emit("ext-1", "UnicastRTP/media-gateway-00000001", []);
    await new Promise((r) => setTimeout(r, 50));
    // Exactly one external fork despite three StasisStart events.
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(1);
    expect(
      ctx.calls.filter((c) => c.method === "POST" && c.url.split("?")[0].endsWith("/bridges")),
    ).toHaveLength(1);
  });

  it("serializes overlapping replies instead of interleaving streams", async () => {
    const { createSocket } = await import("node:dgram");
    const ctx = setup();
    const channelId = await startCall(ctx);
    // Teach the return path with one real loopback RTP packet.
    const sock = createSocket("udp4");
    const probe = rtpPacket([1, 2, 3, 4]);
    const portGuess = (ctx.controller as unknown as { nextRtpPort: number }).nextRtpPort - 1;
    await new Promise<void>((resolve, reject) => {
      sock.send(probe, portGuess, "127.0.0.1", (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((r) => setTimeout(r, 50));
    sock.close();
    // Two overlapping one-frame replies must both complete, in order.
    const one = new Int16Array(320).fill(100);
    const two = new Int16Array(320).fill(200);
    await Promise.all([ctx.controller.sendCallAudio(channelId, one), ctx.controller.sendCallAudio(channelId, two)]);
    expect(ctx.controller.channelForCall("unknown")).toBeNull();
  });

  it("plays replies via Asterisk file playback on the caller channel", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "tts-"));
    const wav = Buffer.from("RIFF....WAVEfakepcm");
    const synthArgs: Array<[string, string | undefined]> = [];
    const ctx = setup(
      { ttsDir: tmp },
      {
        synthesize: async (text: string, code?: string) => {
          synthArgs.push([text, code]);
          return wav;
        },
      },
    );
    const channelId = await startCall(ctx);
    await ctx.controller.playReply(channelId, "madat pathvat aahe");
    // startCall itself triggers the Marathi greeting synthesis first.
    expect(synthArgs).toContainEqual(["madat pathvat aahe", "mr-IN"]);
    await ctx.controller.playReply(channelId, "Got it", "en-IN");
    expect(synthArgs).toContainEqual(["Got it", "en-IN"]);
    const play = ctx.calls.find((c) => c.url.includes("/play"));
    expect(play?.method).toBe("POST");
    expect(String(play?.url)).toContain(`channels/${channelId}/play`);
    const media = (play?.body as { media?: string })?.media ?? "";
    expect(media.startsWith("sound:tts/tts-")).toBe(true);
    const files = await readdir(tmp);
    expect(files.some((f) => f.startsWith("tts-") && f.endsWith(".wav"))).toBe(true);
    // Unknown channels and missing synthesizer are silent no-ops.
    await ctx.controller.playReply("ghost", "hi");
    const ctx2 = setup();
    await startCall(ctx2);
    await ctx2.controller.playReply("chan-abc-12345678", "hi");
  });

  async function startOperator(ctx: ReturnType<typeof setup>, channelId = "op-chan-01") {
    ctx.socket().emit(
      "message",
      JSON.stringify({ type: "StasisStart", channel: { id: channelId, name: `PJSIP/1001-x`, caller: { number: "1001" } }, args: ["9002"] }),
    );
    await new Promise((r) => setTimeout(r, 50));
    return channelId;
  }

  it("hangs up operator joins with no live emergency call", async () => {
    const ctx = setup();
    await ctx.controller.start();
    await startOperator(ctx);
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(0);
    expect(ctx.calls.some((c) => c.url.includes("op-chan-01/hangup"))).toBe(true);
    expect(ctx.published).toEqual([{ name: "call.ended", callId: expect.stringContaining("ARI-OP-") }]);
  });

  it("forks operator audio too and joins the same bridge", async () => {
    const ctx = setup();
    await startCall(ctx);
    await startOperator(ctx);
    // One fork per leg: caller STT + operator STT (role-tagged downstream).
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(2);
    // Operator joins the CALLER's bridge — no new bridge is created.
    expect(ctx.calls.filter((c) => c.method === "POST" && c.url.split("?")[0].endsWith("/bridges"))).toHaveLength(1);
    const add = ctx.calls.find((c) => c.url.includes("addChannel") && JSON.stringify(c.body).includes("op-chan-01"));
    expect(add).toBeTruthy();
    expect(ctx.published).toContainEqual({ name: "call.answered", callId: expect.stringContaining("ARI-OP-") });
  });

  it("operator hangup leaves the emergency leg alive; caller hangup clears all", async () => {
    const ctx = setup();
    const caller = await startCall(ctx, "chan-caller-1");
    const op = await startOperator(ctx, "op-chan-1");
    // Operator leaves: only their channel hung up, no bridge delete.
    ctx.socket().emit("message", JSON.stringify({ type: "StasisEnd", channel: { id: op } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.calls.some((c) => c.url.includes("op-chan-1/hangup"))).toBe(true);
    expect(ctx.calls.some((c) => c.method === "DELETE" && c.url.includes("bridges"))).toBe(false);
    expect(ctx.published.at(-1)).toEqual({ name: "call.ended", callId: expect.stringContaining("ARI-OP-") });
    // Caller leaves: everything torn down.
    ctx.socket().emit("message", JSON.stringify({ type: "StasisEnd", channel: { id: caller } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.calls.some((c) => c.method === "DELETE" && c.url.includes("bridges"))).toBe(true);
    expect(ctx.published.at(-1)).toMatchObject({ name: "call.ended" });
  });

  it("survives malformed frames and failed REST calls", async () => {
    const ctx = setup();
    await ctx.controller.start();
    ctx.socket().emit("message", "not-json");
    ctx.socket().emit("message", JSON.stringify({ type: "StasisStart", channel: {} }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.published).toEqual([]);
  });
});

describe("normalizeCli", () => {
  it("prefixes 10-digit mobiles with +91", () => {
    expect(normalizeCli("9876543210")).toBe("+919876543210");
    expect(normalizeCli("(98765) 43210")).toBe("+919876543210");
    expect(normalizeCli("09876543210")).toBe("+919876543210");
  });

  it("keeps existing + prefix otherwise", () => {
    expect(normalizeCli("+919876543210")).toBe("+919876543210");
    expect(normalizeCli("+91 98765 43210")).toBe("+919876543210");
    expect(normalizeCli("919876543210")).toBe("+919876543210");
    expect(normalizeCli("+1-415-555-1234")).toBe("+14155551234");
  });

  it("handles short service numbers and empties", () => {
    expect(normalizeCli("1001")).toBe("+1001");
    expect(normalizeCli("")).toBe("");
    expect(normalizeCli(null)).toBe("");
    expect(normalizeCli(undefined)).toBe("");
  });
});

describe("DID operator routing", () => {
  const OP_MOBILE = "+919876543210";
  const OP_PROFILE = { operator_id: "OP-1", default_language: "hi-IN", known_languages: ["en", "hi"] };

  function setupDid(
    opts: {
      lookup?: (mobile: string) => { status: number; body: unknown } | { throw: Error };
      apiUrl?: string;
      ingestKey?: string;
      waitRoomPollMs?: number;
      waitRoomTimeoutMs?: number;
      synthesizeLang?: string[];
    } = {},
  ) {
    const calls: Array<{ method: string; url: string; body: unknown; headers: Record<string, string> }> = [];
    let extCounter = 0;
    const fetchFn = vi.fn(async (url: string, init: { method?: string; body?: string; headers?: Record<string, string> }) => {
      const u = String(url);
      const method = init.method ?? "GET";
      let body: unknown;
      try {
        body = init.body ? JSON.parse(init.body as string) : undefined;
      } catch {
        body = undefined;
      }
      calls.push({ method, url: u, body, headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) } });
      if (u.includes("/api/operators/lookup")) {
        const mobile = new URL(u).searchParams.get("mobile") ?? "";
        const behavior = opts.lookup?.(mobile);
        if (behavior && "throw" in behavior) throw (behavior as { throw: Error }).throw;
        if (!behavior) return { ok: false, status: 404, json: async () => ({}) };
        const b = behavior as { status: number; body: unknown };
        if (b.status === 200) return { ok: true, status: 200, json: async () => b.body };
        return { ok: false, status: b.status, json: async () => b.body };
      }
      if (u.includes("/channels/externalMedia")) {
        extCounter += 1;
        return { ok: true, json: async () => ({ id: `ext-did-${extCounter}` }) };
      }
      if (u.includes("/bridges") && method === "POST" && !u.includes("addChannel")) {
        return { ok: true, json: async () => ({ id: "bridge-did-1" }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    const sentAudio: Uint8Array[] = [];
    const adapter: RealtimeAdapter = {
      kind: "test",
      connect: async () => ({ sendAudio: (c: Uint8Array) => void sentAudio.push(c), close: () => undefined }),
    };
    const published: Array<{ name: string; callId: string; payload?: unknown }> = [];
    let socket: FakeSocket | null = null;
    const joins: Array<{ caller: string; op: string }> = [];
    const teardowns: Array<{ callId: string; role: string }> = [];
    const synthArgs: Array<[string, string | undefined]> = [];
    const controller = new AriController(
      {
        adapter,
        publish: (name, callId, payload) => void published.push({ name, callId, payload }),
        log: () => undefined,
        synthesize: async (text: string, code?: string) => {
          synthArgs.push([text, code]);
          opts.synthesizeLang?.push(code ?? "");
          return null;
        },
        onOperatorJoin: (caller, op) => void joins.push({ caller, op }),
        onCallTeardown: (callId, role) => void teardowns.push({ callId, role }),
      },
      {
        baseUrl: "http://asterisk:8088",
        apiUrl: opts.apiUrl ?? "http://api:3001",
        ingestKey: opts.ingestKey ?? "",
        rtpHost: "127.0.0.1",
        rtpPortBase: 35000 + Math.floor(Math.random() * 2000),
        createSocket: () => {
          socket = new FakeSocket();
          setTimeout(() => socket!.emit("open"), 0);
          return socket;
        },
        fetchFn: fetchFn as unknown as typeof fetch,
        waitRoomPollMs: opts.waitRoomPollMs,
        waitRoomTimeoutMs: opts.waitRoomTimeoutMs,
      },
    );
    return {
      controller,
      calls,
      published,
      joins,
      teardowns,
      synthArgs,
      fetchFn,
      socket: () => socket as unknown as FakeSocket,
    };
  }

  function stasisStart(channelId: string, caller: string, exten = "9000") {
    return JSON.stringify({
      type: "StasisStart",
      channel: { id: channelId, name: `PJSIP/${caller}-00000001`, caller: { number: caller } },
      args: [exten],
    });
  }

  it("lookup 404 -> caller flow (same DID, unknown mobile)", async () => {
    const ctx = setupDid({ lookup: () => ({ status: 404, body: {} }) });
    await ctx.controller.start();
    ctx.socket().emit("message", stasisStart("chan-caller-did-01", "9876543210", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    const lookupCall = ctx.calls.find((c) => c.url.includes("/api/operators/lookup"));
    expect(lookupCall?.url).toContain(encodeURIComponent("+919876543210"));
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({ name: "call.answered" });
    expect(ctx.published[0]?.callId).toMatch(/^ARI-/);
    expect(ctx.published[0]?.callId).not.toContain("OP");
    await ctx.controller.shutdown();
  });

  it("lookup fetch failure fails closed to caller flow", async () => {
    const ctx = setupDid({ lookup: () => ({ throw: new Error("api down") }) });
    await ctx.controller.start();
    ctx.socket().emit("message", stasisStart("chan-caller-fail-01", "9876543210", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(1);
    expect(ctx.published[0]).toMatchObject({ name: "call.answered" });
    await ctx.controller.shutdown();
  });

  it("sends x-ingest-key when configured", async () => {
    const ctx = setupDid({
      lookup: () => ({ status: 404, body: {} }),
      ingestKey: "secret-123",
    });
    await ctx.controller.start();
    ctx.socket().emit("message", stasisStart("chan-caller-key-01", "9876543210", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    const lookupCall = ctx.calls.find((c) => c.url.includes("/api/operators/lookup"));
    expect(lookupCall?.headers["x-ingest-key"]).toBe("secret-123");
    await ctx.controller.shutdown();
  });

  it("caches hits and 404s for 60s (no second fetch)", async () => {
    const ctx = setupDid({
      lookup: (mobile) =>
        mobile === OP_MOBILE ? { status: 200, body: OP_PROFILE } : { status: 404, body: {} },
    });
    const first = await ctx.controller.lookupOperator(OP_MOBILE);
    expect(first).toMatchObject({ operator_id: "OP-1" });
    const fetchCountAfterFirst = ctx.fetchFn.mock.calls.length;
    const second = await ctx.controller.lookupOperator(OP_MOBILE);
    expect(second).toMatchObject({ operator_id: "OP-1" });
    expect(ctx.fetchFn.mock.calls.length).toBe(fetchCountAfterFirst);
    const miss1 = await ctx.controller.lookupOperator("+911111111111");
    expect(miss1).toBeNull();
    const countAfterMiss = ctx.fetchFn.mock.calls.length;
    const miss2 = await ctx.controller.lookupOperator("+911111111111");
    expect(miss2).toBeNull();
    expect(ctx.fetchFn.mock.calls.length).toBe(countAfterMiss);
    await ctx.controller.shutdown();
  });

  it("lookup hit with live caller -> operator flow joins same bridge", async () => {
    const ctx = setupDid({
      lookup: (mobile) => (mobile === OP_MOBILE ? { status: 200, body: OP_PROFILE } : { status: 404, body: {} }),
    });
    await ctx.controller.start();
    // Caller first (unknown mobile -> caller flow).
    ctx.socket().emit("message", stasisStart("chan-live-caller-01", "9000000001", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    // Operator dials the SAME DID from a known mobile.
    ctx.socket().emit("message", stasisStart("chan-op-did-01", "9876543210", "9000"));
    await new Promise((r) => setTimeout(r, 80));
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(2);
    expect(ctx.calls.filter((c) => c.method === "POST" && c.url.split("?")[0].endsWith("/bridges"))).toHaveLength(1);
    const opAnswered = ctx.published.find((p) => p.name === "call.answered" && p.callId.includes("OP-"));
    expect(opAnswered).toBeTruthy();
    expect(opAnswered?.payload).toMatchObject({ role: "operator", operator_id: "OP-1" });
    expect(ctx.joins).toHaveLength(1);
    const callerCallId = ctx.published.find((p) => p.name === "call.answered" && !p.callId.includes("OP-"))?.callId;
    expect(callerCallId).toBeTruthy();
    expect(ctx.controller.getOperatorProfile(callerCallId!)).toMatchObject({ operator_id: "OP-1" });
    await ctx.controller.shutdown();
  });

  it("no live call -> waiting room (hold message, poll, join on arrival)", async () => {
    const ctx = setupDid({
      lookup: (mobile) => (mobile === OP_MOBILE ? { status: 200, body: OP_PROFILE } : { status: 404, body: {} }),
      waitRoomPollMs: 10,
      waitRoomTimeoutMs: 2000,
    });
    await ctx.controller.start();
    ctx.socket().emit("message", stasisStart("chan-op-wait-01", "+919876543210", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    // Forked + answered from the start, hold message in operator default.
    expect(ctx.calls.filter((c) => c.url.includes("externalMedia"))).toHaveLength(1);
    expect(ctx.calls.some((c) => c.url.includes("chan-op-wait-01/answer"))).toBe(true);
    expect(ctx.synthArgs).toContainEqual([OPERATOR_HOLD_MESSAGE, "hi-IN"]);
    expect(ctx.published).toContainEqual(
      expect.objectContaining({ name: "call.answered", callId: expect.stringContaining("ARI-OP-") }),
    );
    expect(ctx.controller.waitingCount()).toBe(1);
    expect(ctx.calls.some((c) => c.url.includes("chan-op-wait-01/hangup"))).toBe(false);
    // A caller arrives on the same DID: the poll joins the operator.
    ctx.socket().emit("message", stasisStart("chan-caller-late-01", "9000000002", "9000"));
    await new Promise((r) => setTimeout(r, 120));
    expect(ctx.controller.waitingCount()).toBe(0);
    expect(ctx.joins).toHaveLength(1);
    const add = ctx.calls.find((c) => c.url.includes("addChannel") && JSON.stringify(c.body).includes("chan-op-wait-01"));
    expect(add).toBeTruthy();
    await ctx.controller.shutdown();
  });

  it("waiting-room hangup releases everything", async () => {
    const ctx = setupDid({
      lookup: (mobile) => (mobile === OP_MOBILE ? { status: 200, body: OP_PROFILE } : { status: 404, body: {} }),
      waitRoomPollMs: 20,
      waitRoomTimeoutMs: 2000,
    });
    await ctx.controller.start();
    ctx.socket().emit("message", stasisStart("chan-op-wait-02", "9876543210", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    expect(ctx.controller.waitingCount()).toBe(1);
    ctx.socket().emit("message", JSON.stringify({ type: "StasisEnd", channel: { id: "chan-op-wait-02" } }));
    await new Promise((r) => setTimeout(r, 40));
    expect(ctx.controller.waitingCount()).toBe(0);
    expect(ctx.controller.getOperatorProfile(expect.anything() as unknown as string)).toBeNull();
    expect(ctx.teardowns.some((t) => t.role === "operator")).toBe(true);
    await ctx.controller.shutdown();
  });

  it("caller teardown clears per-call operator profile", async () => {
    const ctx = setupDid({
      lookup: (mobile) => (mobile === OP_MOBILE ? { status: 200, body: OP_PROFILE } : { status: 404, body: {} }),
    });
    await ctx.controller.start();
    ctx.socket().emit("message", stasisStart("chan-live-caller-02", "9000000003", "9000"));
    await new Promise((r) => setTimeout(r, 60));
    ctx.socket().emit("message", stasisStart("chan-op-did-02", "9876543210", "9000"));
    await new Promise((r) => setTimeout(r, 80));
    const callerCallId = ctx.published.find((p) => p.name === "call.answered" && !p.callId.includes("OP-"))?.callId!;
    expect(ctx.controller.getOperatorProfile(callerCallId)).toBeTruthy();
    ctx.socket().emit("message", JSON.stringify({ type: "StasisEnd", channel: { id: "chan-live-caller-02" } }));
    await new Promise((r) => setTimeout(r, 40));
    expect(ctx.controller.getOperatorProfile(callerCallId)).toBeNull();
    expect(ctx.teardowns.some((t) => t.callId === callerCallId)).toBe(true);
    await ctx.controller.shutdown();
  });
});
