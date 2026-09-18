"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LiveTranslationPanel } from "./ops";
import type { LiveEvent } from "../lib/live";

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function evt(name: string, callId: string, payload: Record<string, unknown> = {}): LiveEvent {
  return { name, callId, at: new Date().toISOString(), payload };
}

const FEED = {
  events: [
    evt("translation.suggested", "CALL-1", { caller_language: "ta-IN", operator_id: "op1" }),
    evt("transcript.final", "CALL-1", { original_text: "help" }),
  ],
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("rakshak.token", "tok-123");
  localStorage.setItem("rakshak.operator", "op1");
  vi.restoreAllMocks();
});

describe("LiveTranslationPanel", () => {
  it("toggle flip POSTs the flipped value", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/calls/CALL-1/translation") && (!init?.method || init.method === "GET")) {
        return { ok: true, json: async () => ({ call_id: "CALL-1", enabled: false }) } as Response;
      }
      if (String(url).endsWith("/api/calls/CALL-1/translation") && init?.method === "POST") {
        return { ok: true, json: async () => ({ call_id: "CALL-1", enabled: true }) } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <LiveTranslationPanel feed={{ events: [evt("transcript.final", "CALL-1", { original_text: "help" })] }} />
        </QueryClientProvider>,
      );
      const toggle = await screen.findByRole("button", { name: /translation:/i });
      expect(toggle).toHaveTextContent("OFF");
      await user.click(toggle);
      await waitFor(() => expect(toggle).toHaveTextContent("ON"));
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "POST");
      expect(post).toBeDefined();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toEqual({ enabled: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("nudge banner appears on event and hides after enabling", async () => {
    const user = userEvent.setup();
    let enabled = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/calls/CALL-1/translation") && (!init?.method || init.method === "GET")) {
        return { ok: true, json: async () => ({ call_id: "CALL-1", enabled }) } as Response;
      }
      if (String(url).endsWith("/api/calls/CALL-1/translation") && init?.method === "POST") {
        enabled = true;
        return { ok: true, json: async () => ({ call_id: "CALL-1", enabled: true }) } as Response;
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <LiveTranslationPanel feed={FEED} />
        </QueryClientProvider>,
      );
      // Nudge appears while toggle is OFF.
      const nudge = await screen.findByRole("alert");
      expect(nudge).toHaveTextContent("Caller speaks ta-IN");
      const enableBtn = await screen.findByRole("button", { name: /^enable$/i });
      await user.click(enableBtn);
      // After enabling, the banner hides and the toggle reads ON.
      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(await screen.findByRole("button", { name: /translation: on/i })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows empty state with no live call", async () => {
    render(
      <QueryClientProvider client={testClient()}>
        <LiveTranslationPanel feed={{ events: [] }} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/no live call/i)).toBeInTheDocument();
  });
});
