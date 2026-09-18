"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuditPanel, DispatchPanel, OperatorProfile, RecordsPanel, Topbar } from "./ops";
import type { IncidentRecord } from "../lib/types";

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

const RECORD = {
  id: "REC-STALE",
  call_id: "CALL-STALE",
  original_language: "hi-IN",
  source: "text",
  extraction: { incident_type: "Fire", location: "Manish Nagar", summary: "Fire reported." },
  priority: { level: "HIGH" },
} as IncidentRecord;

function errRes(message: string, status = 500) {
  return { ok: false, status, statusText: message, json: async () => ({ status: "error", message }) } as Response;
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("honest loading/error/empty states", () => {
  it("Topbar shows a distinct offline state when /api/health is unreachable", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/health")) throw new Error("fetch failed");
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <Topbar section="home" onMenu={() => undefined} />
        </QueryClientProvider>,
      );
      // Loading first (distinct from offline)…
      expect(await screen.findByText("API …")).toBeInTheDocument();
      // …then the offline badge, not an infinite skeleton.
      expect(await screen.findByTestId("health-offline")).toHaveTextContent("API offline");
      expect(await screen.findByText("STT offline")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("RecordsPanel keeps stale rows with a stale hint on refetch error", async () => {
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "op1", role: "operator" }));
    const qc = testClient();
    qc.setQueryData(["records", "", "ALL", ""], [RECORD]);
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/records")) return errRes("server down");
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={qc}>
          <RecordsPanel selectedId={null} onSelect={() => undefined} />
        </QueryClientProvider>,
      );
      // Stale row stays visible plus a stale hint (not skeletons, not empty).
      expect(await screen.findByText(/Fire.*Manish Nagar/)).toBeInTheDocument();
      expect(await screen.findByText("stale")).toBeInTheDocument();
      expect(screen.queryByText(/no incidents yet/i)).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("RecordsPanel shows a retryable error with no cached data", async () => {
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "op1", role: "operator" }));
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/records")) return errRes("server down");
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <RecordsPanel selectedId={null} onSelect={() => undefined} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/server down/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      // Never an infinite skeleton and never a misleading empty state.
      expect(screen.queryByText(/no incidents yet/i)).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("OperatorProfile save shows sign-in guidance on 401", async () => {
    const user = userEvent.setup();
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "op1", role: "operator" }));
    localStorage.setItem("rakshak.token", "tok-123");
    localStorage.setItem("rakshak.operator", "op1");
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/operators/profile") && (!init?.method || init.method === "GET")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({
            operator_id: "op1",
            known_languages: [],
            default_language: "mr-IN",
            mobile_e164: "",
            active: true,
          }),
        } as Response;
      }
      if (String(url).endsWith("/api/operators/profile")) {
        return errRes("Operator sign-in required", 401);
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <OperatorProfile />
        </QueryClientProvider>,
      );
      await screen.findByTestId("lang-chip-mr-IN");
      await user.click(screen.getByRole("button", { name: /save profile/i }));
      await waitFor(() => expect(screen.getByText(/sign in required/i)).toBeInTheDocument());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("DispatchPanel shows a retryable error with no cached log", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/api/dispatch")) return errRes("dispatch down");
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <DispatchPanel />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/dispatch down/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      expect(screen.queryByText(/no dispatches logged/i)).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("AuditPanel renders live entries and a retryable error with no data", async () => {
    const okMock = vi.fn(async (url: string) => {
      if (String(url).includes("/api/audit")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ status: "success", data: [{ id: "AUD-1", action: "dispatch", actor: "op1" }] }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", okMock);
    try {
      const { unmount } = render(
        <QueryClientProvider client={testClient()}>
          <AuditPanel />
        </QueryClientProvider>,
      );
      expect(await screen.findByText("dispatch")).toBeInTheDocument();
      unmount();
    } finally {
      vi.unstubAllGlobals();
    }
    const badMock = vi.fn(async () => errRes("audit down"));
    vi.stubGlobal("fetch", badMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <AuditPanel />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/audit down/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
