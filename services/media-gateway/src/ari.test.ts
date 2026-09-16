import { describe, expect, it, vi } from "vitest";
import { AriController, rtpPayload, type SocketLike } from "./ari.js";
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

describe("AriController", () => {
  function setup() {
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

  it("tears down bridge and session on StasisEnd", async () => {
    const ctx = setup();
    const channelId = await startCall(ctx);
    ctx.socket().emit("message", JSON.stringify({ type: "StasisEnd", channel: { id: channelId } }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.calls.some((c) => c.method === "DELETE" && c.url.includes("bridges/bridge-1"))).toBe(true);
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

  it("survives malformed frames and failed REST calls", async () => {
    const ctx = setup();
    await ctx.controller.start();
    ctx.socket().emit("message", "not-json");
    ctx.socket().emit("message", JSON.stringify({ type: "StasisStart", channel: {} }));
    await new Promise((r) => setTimeout(r, 20));
    expect(ctx.published).toEqual([]);
  });
});
