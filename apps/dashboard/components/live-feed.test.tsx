"use client";

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BilingualTranscriptList, LivePanel } from "./live";
import type { LiveEvent } from "../lib/live";

function evt(
  name: string,
  callId: string,
  at = "2026-09-18T10:00:00.000Z",
  payload: Record<string, unknown> = {},
): LiveEvent {
  return { name, callId, at, payload };
}

describe("LivePanel connection state", () => {
  it("shows connecting on first dial", () => {
    render(<LivePanel feed={{ connected: false, status: "connecting", events: [], lastPartial: null }} />);
    expect(screen.getByTestId("live-status")).toHaveTextContent("connecting");
  });

  it("shows live when the socket is open", () => {
    render(<LivePanel feed={{ connected: true, status: "live", events: [], lastPartial: null }} />);
    expect(screen.getByTestId("live-status")).toHaveTextContent("live");
  });

  it("shows reconnecting with backoff retry info", () => {
    render(
      <LivePanel
        feed={{ connected: false, status: "reconnecting", retryCount: 2, nextRetryMs: 4000, events: [], lastPartial: null }}
      />,
    );
    const badge = screen.getByTestId("live-status");
    expect(badge).toHaveTextContent(/reconnecting/);
    expect(badge).toHaveTextContent(/retry 2/);
    expect(badge).toHaveTextContent(/in 4s/);
  });

  it("falls back to connected when status is absent (legacy feeds)", () => {
    render(<LivePanel feed={{ connected: true, events: [], lastPartial: null }} />);
    expect(screen.getByTestId("live-status")).toHaveTextContent("live");
  });
});

describe("LivePanel partial streaming + last-N events", () => {
  it("streams the latest partial while speaking", () => {
    render(
      <LivePanel
        feed={{
          connected: true,
          status: "live",
          events: [evt("transcript.partial", "CALL-1", "2026-09-18T10:00:01.000Z", { original_text: "aag lag…" })],
          lastPartial: "aag lag…",
        }}
      />,
    );
    expect(screen.getByTestId("live-partial")).toHaveTextContent("aag lag…");
    expect(screen.getByText("Hearing now (partial)")).toBeInTheDocument();
  });

  it("caps the visible event list at 15 (last-N)", () => {
    const events = Array.from({ length: 25 }, (_, i) =>
      evt(
        "transcript.final",
        `CALL-${i}`,
        `2026-09-18T10:${String(i).padStart(2, "0")}:00.000Z`,
        { original_text: `utterance-${i}` },
      ),
    );
    render(<LivePanel feed={{ connected: true, status: "live", events, lastPartial: null }} />);
    const list = screen.getByTestId("live-events");
    // 25 in the feed, only 15 rendered.
    expect(within(list).getAllByRole("listitem")).toHaveLength(15);
  });

  it("shows an empty state when there is no call", () => {
    render(<LivePanel feed={{ connected: false, status: "connecting", events: [], lastPartial: null }} />);
    expect(screen.getByText("No live events yet")).toBeInTheDocument();
    expect(screen.getByText(/No bilingual transcript yet/)).toBeInTheDocument();
  });
});

describe("BilingualTranscriptList grouping", () => {
  it("groups finals by call newest-first with language + role badges", () => {
    render(
      <BilingualTranscriptList
        events={[
          evt("transcript.final", "CALL-2", "2026-09-18T10:00:02.000Z", {
            original_text: "madad chahiye",
            language: "hi-IN",
            role: "caller",
          }),
          evt("transcript.final", "CALL-1", "2026-09-18T10:00:01.000Z", {
            original_text: "help is coming",
            language: "en-IN",
            role: "operator",
          }),
        ]}
      />,
    );
    // Call groups in newest-first order.
    const groups = screen.getByText("CALL-2").closest("div")?.parentElement;
    expect(groups).toBeInTheDocument();
    expect(screen.getByText("madad chahiye")).toBeInTheDocument();
    expect(screen.getByText("help is coming")).toBeInTheDocument();
    expect(screen.getByText("hi-IN")).toBeInTheDocument();
    expect(screen.getByText("en-IN")).toBeInTheDocument();
    expect(screen.getByText("caller")).toBeInTheDocument();
    expect(screen.getByText("operator")).toBeInTheDocument();
  });

  it("ignores partials and falls back to Unknown language", () => {
    render(
      <BilingualTranscriptList
        events={[
          evt("transcript.partial", "CALL-1", "2026-09-18T10:00:02.000Z", { original_text: "half…" }),
          evt("transcript.final", "CALL-1", "2026-09-18T10:00:01.000Z", { original_text: "full", role: "caller" }),
        ]}
      />,
    );
    expect(screen.queryByText("half…")).not.toBeInTheDocument();
    expect(screen.getByText("full")).toBeInTheDocument();
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
