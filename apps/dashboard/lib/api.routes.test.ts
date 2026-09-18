import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  API_URL,
  clearRecords,
  deleteRecord,
  getAnalytics,
  getAuditLog,
  getDispatchLog,
  getHealth,
  getProfile,
  getRecordCount,
  getTranslation,
  isAuthError,
  listRecords,
  postDispatch,
  processCall,
  putProfile,
  setTranslation,
  synthesize,
  translate,
} from "./api";

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

function errJson(status: number, message: string) {
  return { ok: false, status, statusText: message, json: async () => ({ status: "error", message }) } as Response;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("rakshak.token", "tok-123");
  localStorage.setItem("rakshak.operator", "op1");
  vi.restoreAllMocks();
});

describe("dashboard API wrappers hit real routes with real envelopes", () => {
  it("getHealth hits GET /api/health (raw, no {status,data} wrapper)", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "ok", sarvam: true, gemini: false, store: "file" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const h = await getHealth();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${API_URL}/api/health`);
      expect(h.status).toBe("ok");
      expect(h.sarvam).toBe(true);
      expect(h.gemini).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("processCall POSTs /api/process-call and unwraps {status,data}", async () => {
    const rec = { id: "REC-1" };
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: rec }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await processCall("help", "Hindi");
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe(`${API_URL}/api/process-call`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ transcript: "help", language: "Hindi" });
      expect(res.data).toEqual(rec);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("listRecords hits GET /api/records with query params ({status,data,count})", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: [{ id: "A" }], count: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await listRecords({ q: "fire", priority: "HIGH", limit: 10, offset: 5 });
      const [url] = fetchMock.mock.calls[0] as unknown as [string];
      expect(url).toContain(`${API_URL}/api/records?`);
      expect(url).toContain("q=fire");
      expect(url).toContain("priority=HIGH");
      expect(url).toContain("limit=10");
      expect(res.data).toEqual([{ id: "A" }]);
      expect(res.count).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getRecordCount unwraps {status,data:{count}}", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: { count: 7 } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await getRecordCount()).toBe(7);
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${API_URL}/api/records/count`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getAnalytics unwraps {status,data}", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: { total_records: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await getAnalytics();
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${API_URL}/api/analytics`);
      expect(res.data).toEqual({ total_records: 3 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getDispatchLog accepts the raw array the API returns", async () => {
    const fetchMock = vi.fn(async () => okJson([{ id: "DSP-001" }]));
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await getDispatchLog()).toEqual([{ id: "DSP-001" }]);
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${API_URL}/api/dispatch`);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getDispatchLog also accepts {log}/{data} shapes and throws on HTTP error", async () => {
    const okLog = vi.fn(async () => okJson({ status: "success", data: { x: 1 }, log: [{ id: "DSP-2" }] }));
    vi.stubGlobal("fetch", okLog);
    try {
      expect(await getDispatchLog()).toEqual([{ id: "DSP-2" }]);
    } finally {
      vi.unstubAllGlobals();
    }
    const bad = vi.fn(async () => errJson(500, "boom"));
    vi.stubGlobal("fetch", bad);
    try {
      await expect(getDispatchLog()).rejects.toThrow("boom");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("postDispatch POSTs /api/dispatch with Authorization + x-operator", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: { id: "DSP-1" }, log: [] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await postDispatch({ call_id: "CALL-1" });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/dispatch`);
      expect(init.method).toBe("POST");
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("translate POSTs /api/translate with auth headers and unwraps {status,data}", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: { translated_text: "hi", target: "hi-IN" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await translate("hello", "hi-IN", "en-IN");
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/translate`);
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
      expect(res.data.translated_text).toBe("hi");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("synthesize POSTs /api/tts", async () => {
    const fetchMock = vi.fn(async () =>
      okJson({ status: "success", data: { audio_base64: "data:audio/wav;base64,xx", speaker: "s", language_code: "mr-IN" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await synthesize("madat", { language_code: "mr-IN" });
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${API_URL}/api/tts`);
      expect(res.data.language_code).toBe("mr-IN");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("deleteRecord + clearRecords hit DELETE routes with auth headers", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", message: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await deleteRecord("REC-9");
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/records/REC-9`);
      expect(init.method).toBe("DELETE");
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
      await clearRecords();
      const [url2, init2] = fetchMock.mock.calls[1] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url2).toBe(`${API_URL}/api/records`);
      expect(init2.method).toBe("DELETE");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getAuditLog hits GET /api/audit?limit ({status,data})", async () => {
    const fetchMock = vi.fn(async () => okJson({ status: "success", data: [{ id: "AUD-1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await getAuditLog(10);
      expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe(`${API_URL}/api/audit?limit=10`);
      expect(res.data).toEqual([{ id: "AUD-1" }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("profile + translation wrappers use raw (unenveloped) routes with auth headers", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/operators/profile") && (!init?.method || init.method === "GET")) {
        return okJson({ operator_id: "op1", known_languages: [], default_language: "mr-IN", mobile_e164: "", active: true });
      }
      if (u.endsWith("/api/operators/profile")) return okJson({ operator_id: "op1", known_languages: ["hi-IN"], default_language: "hi-IN", mobile_e164: "", active: true });
      if (u.endsWith("/api/calls/CALL-1/translation") && (!init?.method || init.method === "GET")) {
        return okJson({ call_id: "CALL-1", enabled: false });
      }
      return okJson({ call_id: "CALL-1", enabled: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect((await getProfile()).operator_id).toBe("op1");
      expect((await putProfile({ default_language: "hi-IN" })).default_language).toBe("hi-IN");
      expect(await getTranslation("CALL-1")).toEqual({ call_id: "CALL-1", enabled: false });
      expect((await setTranslation("CALL-1", true)).enabled).toBe(true);
      for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit & { headers: Record<string, string> } | undefined]>) {
        expect(init?.headers?.["x-operator"]).toBe("op1");
        expect(init?.headers?.Authorization).toBe("Bearer tok-123");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("isAuthError detects 401s (status or message) and ignores other failures", () => {
    const e401 = new Error("Operator sign-in required") as Error & { status?: number };
    e401.status = 401;
    expect(isAuthError(e401)).toBe(true);
    expect(isAuthError(new Error("Operator sign-in required"))).toBe(true);
    expect(isAuthError(new Error("boom (500)"))).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
