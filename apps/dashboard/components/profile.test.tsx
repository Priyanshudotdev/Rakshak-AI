"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorProfile } from "./ops";

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("OperatorProfile", () => {
  it("stays hidden when no operator is signed in", () => {
    const { container } = render(
      <QueryClientProvider client={testClient()}>
        <OperatorProfile />
      </QueryClientProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("prefills from getProfile and saves the patch", async () => {
    const user = userEvent.setup();
    localStorage.setItem("rakshak.session", JSON.stringify({ name: "op1", role: "operator" }));
    localStorage.setItem("rakshak.operator", "op1");
    localStorage.setItem("rakshak.token", "tok-123");

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/operators/profile") && (!init?.method || init.method === "GET")) {
        return {
          ok: true,
          json: async () => ({
            operator_id: "op1",
            known_languages: ["hi-IN"],
            default_language: "hi-IN",
            mobile_e164: "+911234567890",
            active: true,
          }),
        } as Response;
      }
      if (String(url).endsWith("/api/operators/profile") && init?.method === "PUT") {
        return {
          ok: true,
          json: async () => ({
            operator_id: "op1",
            known_languages: ["hi-IN", "mr-IN"],
            default_language: "hi-IN",
            mobile_e164: "+911234567890",
            active: true,
          }),
        } as Response;
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

      // Prefill from GET.
      expect(await screen.findByDisplayValue("+911234567890")).toBeInTheDocument();
      const mrChip = await screen.findByTestId("lang-chip-mr-IN");
      expect(mrChip).toHaveAttribute("aria-pressed", "false");

      // Toggle a language and save.
      await user.click(mrChip);
      expect(mrChip).toHaveAttribute("aria-pressed", "true");
      await user.click(screen.getByRole("button", { name: /save profile/i }));

      await waitFor(() => expect(screen.getByText("Profile saved.")).toBeInTheDocument());
      const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === "PUT");
      expect(put).toBeDefined();
      expect(JSON.parse(String((put?.[1] as RequestInit).body))).toEqual({
        known_languages: ["hi-IN", "mr-IN"],
        default_language: "hi-IN",
        mobile_e164: "+911234567890",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
