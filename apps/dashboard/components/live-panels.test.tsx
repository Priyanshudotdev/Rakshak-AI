"use client";

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BilingualTranscriptList, WaitingRoomBanner } from "./live";
import { TranslationHistory } from "./ops";
import type { LiveEvent } from "../lib/live";

function evt(name: string, callId: string, payload: Record<string, unknown> = {}): LiveEvent {
  return { name, callId, at: "2026-09-18T10:00:00.000Z", payload };
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("WaitingRoomBanner", () => {
  it("shows the holding banner on operator.waiting with no live call", () => {
    render(<WaitingRoomBanner events={[evt("operator.waiting", "", { operator_id: "OP-1" })]} />);
    expect(screen.getByRole("status")).toHaveTextContent(/operator holding — no live caller/i);
  });

  it("clears on operator.joined", () => {
    const { container } = render(
      <WaitingRoomBanner
        events={[
          evt("operator.joined", "CALL-1", { call_id: "CALL-1", operator_id: "OP-1" }),
          evt("operator.waiting", "", { operator_id: "OP-1" }),
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("clears on call.ended", () => {
    const { container } = render(
      <WaitingRoomBanner
        events={[evt("call.ended", "CALL-1", {}), evt("operator.waiting", "", { operator_id: "OP-1" })]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("BilingualTranscriptList", () => {
  it("renders utterances grouped by call with language + role badges", () => {
    render(
      <BilingualTranscriptList
        events={[
          evt("transcript.final", "CALL-1", { original_text: "madad chahiye", language: "hi-IN", role: "caller" }),
          evt("transcript.final", "CALL-1", { original_text: "help is coming", language: "en-IN", role: "operator" }),
        ]}
      />,
    );
    expect(screen.getByText("CALL-1")).toBeInTheDocument();
    expect(screen.getByText("madad chahiye")).toBeInTheDocument();
    expect(screen.getByText("help is coming")).toBeInTheDocument();
    expect(screen.getByText("hi-IN")).toBeInTheDocument();
    expect(screen.getByText("en-IN")).toBeInTheDocument();
    expect(screen.getByText("caller")).toBeInTheDocument();
    expect(screen.getByText("operator")).toBeInTheDocument();
  });

  it("falls back to Unknown when the language field is missing", () => {
    render(
      <BilingualTranscriptList
        events={[evt("transcript.final", "CALL-7", { original_text: "hello", role: "caller" })]}
      />,
    );
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});

describe("TranslationHistory", () => {
  it("renders toggle events for the call and notes it is live-only", () => {
    render(
      <TranslationHistory
        callId="CALL-1"
        events={[
          evt("translation.toggled", "CALL-1", { call_id: "CALL-1", enabled: true, by: "op1" }),
          evt("translation.toggled", "CALL-2", { call_id: "CALL-2", enabled: false, by: "op2" }),
        ]}
      />,
    );
    expect(screen.getByText(/live-only — no backfill/i)).toBeInTheDocument();
    expect(screen.getByText("CALL-1")).toBeInTheDocument();
    expect(screen.getByText("by op1")).toBeInTheDocument();
    expect(screen.queryByText("CALL-2")).not.toBeInTheDocument();
  });

  it("shows an empty note when the call has no toggles", () => {
    render(<TranslationHistory callId="CALL-9" events={[]} />);
    expect(screen.getByText(/no translation toggles for this call/i)).toBeInTheDocument();
  });
});
