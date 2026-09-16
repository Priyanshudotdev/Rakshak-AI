import { afterEach, describe, expect, it, vi } from "vitest";
import { assessPriority, extract } from "./llm.js";

function resp(json: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as Response;
}

const chatJson = (content: string) => ({ choices: [{ message: { content } }] });

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.SARVAM_API_KEY;
  delete process.env.GEMINI_API_KEY;
});

describe("LLM providers", () => {
  it("sends both Sarvam auth headers with fast low-reasoning JSON params", async () => {
    process.env.SARVAM_API_KEY = "sk-test";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: unknown, init?: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      return resp(chatJson('{"a":1}'));
    });
    const r = await extract("hello", "hello", "Hindi");
    expect(r.model).toBe("sarvam-105b");
    expect(r.data).toEqual({ a: 1 });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["api-subscription-key"]).toBe("sk-test");
    expect(headers.Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("sarvam-105b");
    expect(body.reasoning_effort).toBeNull();
    expect(body.max_tokens).toBeGreaterThanOrEqual(2000);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("falls back to Gemini when Sarvam fails", async () => {
    process.env.SARVAM_API_KEY = "sk-test";
    process.env.GEMINI_API_KEY = "g-test";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: unknown) => {
      urls.push(String(url));
      if (String(url).includes("sarvam")) return resp({ error: "bad" }, 500);
      return resp({ candidates: [{ content: { parts: [{ text: '{"b":2}' }] } }] });
    });
    const r = await assessPriority({ incident_type: { primary: "Fire" } });
    expect(r.model).toBe("gemini");
    expect(r.data).toEqual({ b: 2 });
    expect(urls.some((u) => u.includes("gemini-2.5-flash"))).toBe(true);
    expect(urls.some((u) => u.includes("gemini-2.0-flash"))).toBe(false);
  });

  it("raises a combined error when all providers fail", async () => {
    process.env.SARVAM_API_KEY = "sk-test";
    vi.stubGlobal("fetch", async () => resp({ error: "x" }, 500));
    await expect(extract("hi", "hi", "Hindi")).rejects.toThrow(/sarvam.*gemini/s);
  });
});
