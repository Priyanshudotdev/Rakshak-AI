import { describe, expect, it, vi } from "vitest";
import { createConversation, isKnownTongue, replyVoice } from "./conversation.js";

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

describe("isKnownTongue", () => {
  it("matches names and codes case-insensitively", () => {
    expect(isKnownTongue("Marathi", ["mr-IN", "en"])).toBe(true);
    expect(isKnownTongue("mr-IN", ["Marathi"])).toBe(true);
    expect(isKnownTongue("Hindi", ["hi", "en"])).toBe(true);
    expect(isKnownTongue("Marathi", ["en", "hi"])).toBe(false);
    expect(isKnownTongue(undefined, ["en"])).toBe(false);
  });
});

describe("translation toggle rendition", () => {
  const PROFILE = { operator_id: "OP-1", default_language: "hi-IN", known_languages: ["en", "hi"] };

  function setupToggle(opts: { enabled: boolean | ((callId: string) => boolean); operatorLang?: string } = { enabled: false }) {
    const plays: Array<{ channel: string; text: string; code: string }> = [];
    const fetchCalls: Array<{ url: string; body: unknown }> = [];
    const published: Array<{ name: string; callId: string; payload: unknown }> = [];
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
      if (String(url).match(/\/api\/calls\/.+\/translation/)) {
        const flag = typeof opts.enabled === "function" ? opts.enabled(String(url)) : opts.enabled;
        const callId = String(url).split("/api/calls/")[1]?.split("/translation")[0];
        return { ok: true, json: async () => ({ call_id: decodeURIComponent(callId ?? ""), enabled: flag }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    const conv = createConversation({
      ari: () => ari as never,
      apiUrl: "http://api:3001",
      fetchFn: fetchFn as unknown as typeof fetch,
      log: () => undefined,
      operatorLang: opts.operatorLang ?? "en-IN",
      publish: (name, callId, payload) => void published.push({ name, callId, payload }),
    });
    conv.setOperatorProfile("CALLER", PROFILE);
    return { conv, plays, fetchCalls, published };
  }

  it("toggle OFF -> rendition skipped + nudge published once", async () => {
    const { conv, plays, published, fetchCalls } = setupToggle({ enabled: false });
    await conv.handleFinal("CALLER", "aag lagli aahe", "Marathi", "caller");
    await conv.handleFinal("CALLER", "aag lagli aahe", "Marathi", "caller");
    const opHi = plays.filter((p) => p.channel === "chan-op" && p.code === "hi-IN");
    expect(opHi).toHaveLength(0);
    const nudges = published.filter((p) => p.name === "translation.suggested");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({
      callId: "CALLER",
      payload: { call_id: "CALLER", caller_language: "Marathi", operator_id: "OP-1" },
    });
    // 2s TTL: the second final reuses the cached toggle (one fetch).
    expect(fetchCalls.filter((c) => c.url.includes("/translation"))).toHaveLength(1);
  });

  it("toggle ON + known tongue -> no rendition, no nudge", async () => {
    const { conv, plays, published, fetchCalls } = setupToggle({ enabled: true });
    await conv.handleFinal("CALLER", "madad chahiye", "Hindi", "caller");
    const opHi = plays.filter((p) => p.channel === "chan-op" && p.code === "hi-IN");
    expect(opHi).toHaveLength(0);
    expect(published.filter((p) => p.name === "translation.suggested")).toHaveLength(0);
    expect(fetchCalls.some((c) => c.url.includes("/api/translate") && (c.body as { target_language_code?: string })?.target_language_code === "hi-IN")).toBe(false);
  });

  it("toggle ON + unknown tongue -> rendition into operator channel in operator default", async () => {
    const { conv, plays, published, fetchCalls } = setupToggle({ enabled: true });
    await conv.handleFinal("CALLER", "aag lagli aahe", "Marathi", "caller");
    const opHi = plays.filter((p) => p.channel === "chan-op" && p.code === "hi-IN");
    expect(opHi).toHaveLength(1);
    expect(opHi[0].text).toContain("[[hi-IN]]");
    const tr = fetchCalls.find(
      (c) => c.url.includes("/api/translate") && (c.body as { target_language_code?: string })?.target_language_code === "hi-IN",
    );
    expect(tr?.body).toMatchObject({ target_language_code: "hi-IN", source_language_code: "Marathi" });
    expect(published.filter((p) => p.name === "translation.suggested")).toHaveLength(0);
  });

  it("toggle fetch failure defaults OFF and nudges once", async () => {
    const plays: Array<{ channel: string; text: string; code: string }> = [];
    const published: Array<{ name: string; callId: string; payload: unknown }> = [];
    const ari = {
      channelForCall: () => "chan-caller",
      bridgePeer: () => ({ callId: "OP", channelId: "chan-op", role: "operator" }),
      playReply: async (channel: string, text: string, code = "mr-IN") => {
        plays.push({ channel, text, code });
      },
    };
    // Same-channel fake keeps the test minimal: operator channel resolves too.
    const ari2 = {
      channelForCall: (id: string) => (id === "CALLER" ? "chan-caller" : "chan-op"),
      bridgePeer: () => ({ callId: "OP", channelId: "chan-op", role: "operator" }),
      playReply: async (channel: string, text: string, code = "mr-IN") => {
        plays.push({ channel, text, code });
      },
    };
    void ari;
    const fetchFn = vi.fn(async (url: string, init: { body?: string }) => {
      const u = String(url);
      if (u.includes("/api/translate")) {
        const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        return { ok: true, json: async () => ({ data: { translated_text: `[[${body.target_language_code}]]${body.text}` } }) };
      }
      if (u.includes("/api/process-call")) {
        return { ok: true, json: async () => ({ data: { extraction: { incident_type: "Fire" } } }) };
      }
      if (u.includes("/translation")) throw new Error("api down");
      return { ok: false, json: async () => ({}) };
    });
    const conv = createConversation({
      ari: () => ari2 as never,
      apiUrl: "http://api:3001",
      fetchFn: fetchFn as unknown as typeof fetch,
      log: () => undefined,
      operatorLang: "en-IN",
      publish: (name, callId, payload) => void published.push({ name, callId, payload }),
    });
    conv.setOperatorProfile("CALLER", PROFILE);
    await conv.handleFinal("CALLER", "aag lagli", "Marathi", "caller");
    expect(published.filter((p) => p.name === "translation.suggested")).toHaveLength(1);
  });

  it("teardown clears per-call caches", async () => {
    const { conv, fetchCalls } = setupToggle({ enabled: false });
    await conv.handleFinal("CALLER", "aag lagli", "Marathi", "caller");
    expect(conv.profileByCall.has("CALLER")).toBe(true);
    expect(conv.toggleCache.has("CALLER")).toBe(true);
    expect(conv.nudged.has("CALLER")).toBe(true);
    expect(conv.langByCall.has("CALLER")).toBe(true);
    conv.clearCallState("CALLER");
    expect(conv.profileByCall.has("CALLER")).toBe(false);
    expect(conv.toggleCache.has("CALLER")).toBe(false);
    expect(conv.nudged.has("CALLER")).toBe(false);
    expect(conv.langByCall.has("CALLER")).toBe(false);
    const before = fetchCalls.filter((c) => c.url.includes("/translation")).length;
    await conv.isTranslationEnabled("CALLER");
    expect(fetchCalls.filter((c) => c.url.includes("/translation")).length).toBe(before + 1);
  });

  it("pulls profile from the gateway cache when not set locally", async () => {
    const plays: Array<{ channel: string; text: string; code: string }> = [];
    const published: Array<{ name: string; callId: string; payload: unknown }> = [];
    const ari = {
      channelForCall: (id: string) => (id === "CALLER" ? "chan-caller" : "chan-op"),
      bridgePeer: () => ({ callId: "OP", channelId: "chan-op", role: "operator" }),
      playReply: async (channel: string, text: string, code = "mr-IN") => {
        plays.push({ channel, text, code });
      },
      getOperatorProfile: (id: string) => (id === "OP" || id === "CALLER" ? PROFILE : null),
    };
    const fetchFn = vi.fn(async (url: string, init: { body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      if (String(url).includes("/api/translate")) {
        return { ok: true, json: async () => ({ data: { translated_text: `[[${body.target_language_code}]]${body.text}` } }) };
      }
      if (String(url).includes("/api/process-call")) {
        return { ok: true, json: async () => ({ data: { extraction: { incident_type: "Fire" } } }) };
      }
      if (String(url).includes("/translation")) {
        return { ok: true, json: async () => ({ call_id: "CALLER", enabled: true }) };
      }
      return { ok: false, json: async () => ({}) };
    });
    const conv = createConversation({
      ari: () => ari as never,
      apiUrl: "http://api:3001",
      fetchFn: fetchFn as unknown as typeof fetch,
      log: () => undefined,
      operatorLang: "en-IN",
      publish: (name, callId, payload) => void published.push({ name, callId, payload }),
    });
    await conv.handleFinal("CALLER", "aag lagli", "Marathi", "caller");
    expect(plays.some((p) => p.channel === "chan-op" && p.code === "hi-IN")).toBe(true);
    expect(conv.getOperatorProfile("CALLER")).toMatchObject({ operator_id: "OP-1" });
  });
});
