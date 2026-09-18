import { describe, expect, it, vi } from "vitest";
import { createConversation, replyVoice } from "./conversation.js";

interface Play {
  channel: string;
  text: string;
  code: string;
}

function setup() {
  const plays: Play[] = [];
  const fetchCalls: Array<{ url: string; body: unknown }> = [];
  const channels = new Map([
    ["CALLER", "chan-caller"],
    ["OP", "chan-op"],
  ]);
  const peers = new Map([
    ["CALLER", { callId: "OP", channelId: "chan-op", role: "operator" }],
    ["OP", { callId: "CALLER", channelId: "chan-caller", role: "caller" }],
  ]);
  const ari = {
    channelForCall: (id: string) => channels.get(id) ?? null,
    bridgePeer: (id: string) => peers.get(id) ?? null,
    playReply: async (channel: string, text: string, code = "mr-IN") => {
      plays.push({ channel, text, code });
    },
  };
  const fetchFn = vi.fn(async (url: string, init: { body?: string }) => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    fetchCalls.push({ url: String(url), body });
    if (String(url).includes("/api/translate")) {
      return { ok: true, json: async () => ({ data: { translated_text: `[[${body.target_language_code}]]${body.text}` } }) };
    }
    if (String(url).includes("/api/process-call")) {
      return {
        ok: true,
        json: async () => ({ data: { extraction: { incident_type: "Fire" }, priority: { level: "HIGH" } } }),
      };
    }
    return { ok: false, json: async () => ({}) };
  });
  const conv = createConversation({
    ari: () => ari as never,
    apiUrl: "http://api:3001",
    fetchFn: fetchFn as unknown as typeof fetch,
    log: () => undefined,
    operatorLang: "en-IN",
  });
  return { conv, plays, fetchCalls };
}

describe("replyVoice", () => {
  it("matches Marathi, Hindi and English with Marathi default", () => {
    expect(replyVoice("Marathi").code).toBe("mr-IN");
    expect(replyVoice("mr-IN").code).toBe("mr-IN");
    expect(replyVoice("Hindi").code).toBe("hi-IN");
    expect(replyVoice("en-IN").code).toBe("en-IN");
    expect(replyVoice(undefined).code).toBe("mr-IN");
    expect(replyVoice("Unknown").code).toBe("mr-IN");
  });
});

describe("two-way translated conversation", () => {
  it("caller Marathi final: incident + Marathi replies + English for operator", async () => {
    const { conv, plays, fetchCalls } = setup();
    await conv.handleFinal("CALLER", "aag lagli aahe", "Marathi", "caller");
    expect(fetchCalls.some((c) => c.url.includes("/api/process-call"))).toBe(true);
    const callerPlays = plays.filter((p) => p.channel === "chan-caller");
    expect(callerPlays.map((p) => p.code)).toEqual(["mr-IN", "mr-IN"]);
    expect(callerPlays[0].text).toContain("माहिती मिळाली");
    expect(callerPlays[1].text).toContain("Fire");
    const opPlays = plays.filter((p) => p.channel === "chan-op");
    expect(opPlays).toHaveLength(1);
    expect(opPlays[0].code).toBe("en-IN");
    expect(opPlays[0].text).toContain("[[en-IN]]");
    const tr = fetchCalls.find((c) => c.url.includes("/api/translate"));
    expect(tr?.body).toMatchObject({ target_language_code: "en-IN" });
  });

  it("operator English final: Marathi to caller only, no incident", async () => {
    const { conv, plays, fetchCalls } = setup();
    await conv.handleFinal("CALLER", "aag lagli", "Marathi", "caller");
    const before = fetchCalls.length;
    await conv.handleFinal("OP", "help is coming", "en-IN", "operator");
    expect(fetchCalls.slice(before).some((c) => c.url.includes("/api/process-call"))).toBe(false);
    const callerPlays = plays.filter((p) => p.channel === "chan-caller");
    const last = callerPlays.at(-1)!;
    expect(last.code).toBe("mr-IN");
    expect(last.text).toContain("[[mr-IN]]help is coming");
  });

  it("operator final with no live peer stays silent", async () => {
    const { conv, fetchCalls, plays } = setup();
    const solo = createConversation({
      ari: () =>
        ({
          channelForCall: () => "chan-op",
          bridgePeer: () => null,
          playReply: async () => undefined,
        }) as never,
      apiUrl: "http://api:3001",
      fetchFn: (async () => {
        throw new Error("must not call");
      }) as unknown as typeof fetch,
      log: () => undefined,
      operatorLang: "en-IN",
    });
    await solo.handleFinal("OP", "hello?", "en-IN", "operator");
    expect(plays).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("ignores empty transcripts", async () => {
    const { conv, plays, fetchCalls } = setup();
    await conv.handleFinal("CALLER", "   ", "Marathi", "caller");
    expect(plays).toHaveLength(0);
    expect(fetchCalls).toHaveLength(0);
  });

  it("shaky first detection falls back to Marathi, confident later final switches", async () => {
    const { conv, plays } = setup();
    await conv.handleFinal("CALLER", "aag lagli aahe", "en-IN", "caller", 0.4);
    const first = plays.filter((p) => p.channel === "chan-caller");
    expect(first[0].code).toBe("mr-IN");
    expect(first[0].text).toContain("माहिती मिळाली");
    await conv.handleFinal("CALLER", "there is a fire", "en-IN", "caller", 0.95);
    const callerPlays = plays.filter((p) => p.channel === "chan-caller");
    expect(callerPlays.at(-2)!.code).toBe("en-IN");
    expect(callerPlays.at(-2)!.text).toContain("Got it");
    expect(callerPlays.at(-1)!.code).toBe("en-IN");
  });
});
