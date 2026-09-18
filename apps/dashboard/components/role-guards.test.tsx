"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecordDetail, RecordsPanel } from "./ops";
import type { IncidentRecord } from "../lib/types";

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

const RECORD = {
  id: "REC-1",
  call_id: "CALL-1",
  original_language: "hi-IN",
  extraction: { incident_type: "Fire", location: "Manish Nagar", summary: "Fire reported." },
  priority: { level: "HIGH" },
} as IncidentRecord;

function stubRecordsFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("/api/records")) {
      return { ok: true, json: async () => ({ status: "success", data: [], count: 0 }) } as Response;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("role-gated delete buttons", () => {
  it("hides RecordDetail delete for the operator role", () => {
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "op1", role: "operator" }));
    render(
      <QueryClientProvider client={testClient()}>
        <RecordDetail record={RECORD} events={[]} />
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: /delete record/i })).not.toBeInTheDocument();
    // Operators keep dispatch-logging.
    expect(screen.getByRole("button", { name: /log dispatch decision/i })).toBeInTheDocument();
  });

  it("shows RecordDetail delete for the admin role", () => {
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "boss", role: "admin" }));
    render(
      <QueryClientProvider client={testClient()}>
        <RecordDetail record={RECORD} events={[]} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("button", { name: /delete record/i })).toBeInTheDocument();
  });

  it("hides records clear for the operator role", async () => {
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "op1", role: "operator" }));
    stubRecordsFetch();
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <RecordsPanel selectedId={null} onSelect={() => undefined} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/no incidents yet/i)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /clear all records/i })).not.toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows records clear for the admin role", async () => {
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "boss", role: "admin" }));
    stubRecordsFetch();
    try {
      render(
        <QueryClientProvider client={testClient()}>
          <RecordsPanel selectedId={null} onSelect={() => undefined} />
        </QueryClientProvider>,
      );
      expect(await screen.findByText(/no incidents yet/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /clear all records/i })).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
