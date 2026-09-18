import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_URL, getProfile, getTranslation, putProfile, setTranslation } from "./api";

function mockJson(body: unknown) {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("rakshak.token", "tok-123");
  localStorage.setItem("rakshak.operator", "op1");
  vi.restoreAllMocks();
});

describe("operator profile + translation API wrappers", () => {
  it("getProfile hits GET /api/operators/profile with auth headers", async () => {
    const fetchMock = vi.fn(async () => mockJson({ operator_id: "op1", known_languages: [], default_language: "mr-IN", mobile_e164: "", active: true }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await getProfile();
      expect(res.operator_id).toBe("op1");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/operators/profile`);
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("putProfile PUTs the patch with auth headers", async () => {
    const fetchMock = vi.fn(async () =>
      mockJson({ operator_id: "op1", known_languages: ["hi-IN"], default_language: "hi-IN", mobile_e164: "+911234567890", active: true }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const patch = { known_languages: ["hi-IN"], default_language: "hi-IN", mobile_e164: "+911234567890" };
      await putProfile(patch);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/operators/profile`);
      expect(init.method).toBe("PUT");
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
      expect(JSON.parse(String(init.body))).toEqual(patch);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getTranslation hits GET /api/calls/:id/translation", async () => {
    const fetchMock = vi.fn(async () => mockJson({ call_id: "CALL-1", enabled: false }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await getTranslation("CALL-1");
      expect(res).toEqual({ call_id: "CALL-1", enabled: false });
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/calls/CALL-1/translation`);
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("setTranslation POSTs {enabled} with auth headers", async () => {
    const fetchMock = vi.fn(async () => mockJson({ call_id: "CALL-1", enabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const res = await setTranslation("CALL-1", true);
      expect(res.enabled).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(`${API_URL}/api/calls/CALL-1/translation`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
      expect(init.headers["x-operator"]).toBe("op1");
      expect(init.headers.Authorization).toBe("Bearer tok-123");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
