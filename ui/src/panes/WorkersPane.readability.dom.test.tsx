// ui/src/panes/WorkersPane.readability.dom.test.tsx — spec 28 landing 4c:
// the readability suggestion pane extension (columns, filters, batch
// promote/revert, the four UI actions). Testing Library discipline (spec 19
// §2 layer 2): roles/text/structure, never pixels. `../workers/readability-
// wire.ts` is mocked (this file's own convention, same as `api.ts`
// elsewhere) so every assertion is about the pane's own wiring, not a real
// server.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Tooltip from "@radix-ui/react-tooltip";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { WorkersPane } from "./WorkersPane.tsx";
import type { ReadabilitySuggestionsResult } from "../workers/readability-wire.ts";

const {
  suggestionsMock,
  promoteMock,
  revertMock,
  suggestNamesMock,
  rewriteFunctionMock,
  combineFilesMock,
  reviewMock,
} = vi.hoisted(() => ({
  suggestionsMock: vi.fn<() => Promise<ReadabilitySuggestionsResult>>(),
  promoteMock: vi.fn().mockResolvedValue({ txId: "x", tier: "confirmed" }),
  revertMock: vi.fn().mockResolvedValue({ txId: "x", revertedTxId: "y", restored: [] }),
  suggestNamesMock: vi.fn().mockResolvedValue({ suggestions: [] }),
  rewriteFunctionMock: vi.fn().mockResolvedValue({ accepted: true }),
  combineFilesMock: vi.fn().mockResolvedValue({ accepted: true }),
  reviewMock: vi.fn().mockResolvedValue({ opened: true, pending: 0 }),
}));

vi.mock("../workers/readability-wire.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workers/readability-wire.ts")>();
  return {
    ...actual,
    readabilityApi: {
      suggestions: suggestionsMock,
      promote: promoteMock,
      revert: revertMock,
      suggestNames: suggestNamesMock,
      rewriteFunction: rewriteFunctionMock,
      combineFiles: combineFilesMock,
      review: reviewMock,
    },
  };
});

const NAME_ROW: ReadabilitySuggestionsResult["suggestions"][number] = {
  kind: "name",
  suggestionId: "sug-1",
  bindingId: { fn: 3, reg: 2 },
  name: "loopCount",
  confidence: "high",
  evidence: "loop bound observed twice",
  tier: "suggested",
  ts: "2026-09-11T00:00:00.000Z",
};

const TX_ROW: ReadabilitySuggestionsResult["suggestions"][number] = {
  kind: "tx",
  tx: {
    id: "tx-1",
    op: "rewrite",
    tier: "suggested",
    who: "worker:haiku",
    ts: "2026-09-11T00:00:00.000Z",
    inputs: [{ module: 1 }],
    outputs: [{ path: "src/module_1.js", origins: [{ module: 1 }] }],
    evidence: "restated the loop body",
    prior: { files: [{ path: "src/module_1.js", sha256: "abc123" }] },
    equiv: { scope: "function", verdict: "PASS", oracle: "hbc2js equiv" },
  },
};

function wrapper(children: ReactNode): ReactNode {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <Tooltip.Provider delayDuration={400}>{children}</Tooltip.Provider>
    </QueryClientProvider>
  );
}

function renderPane(fn = 3): ReturnType<typeof render> {
  return render(wrapper(<WorkersPane fn={fn} />));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("WorkersPane readability section (spec 28 landing 4c)", () => {
  it("renders name and rewrite rows with confidence, evidence and equiv-status columns", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [NAME_ROW, TX_ROW], total: 2, backend: "fake" });
    renderPane();
    expect(await screen.findByText("loopCount")).toBeTruthy();
    expect(screen.getByText("loop bound observed twice")).toBeTruthy();
    const nameRow = screen.getByTestId("readability-row-sug-1");
    expect(nameRow.textContent).toContain("high");
    expect(screen.getByText("PASS")).toBeTruthy();
    expect(screen.getByText("restated the loop body")).toBeTruthy();
    // the rewrite row's before/after diff panel
    expect(screen.getByTestId("readability-diff-tx-1")).toBeTruthy();
  });

  it("renders rendered before/after TEXT when the route supplies priorContent/newContent (landing 4d)", async () => {
    const txWithContent: ReadabilitySuggestionsResult["suggestions"][number] = {
      ...TX_ROW,
      priorContent: { "src/module_1.js": "function old() { return 1; }" },
      newContent: { "src/module_1.js": "function neu() { return 1; }" },
    };
    suggestionsMock.mockResolvedValue({ suggestions: [txWithContent], total: 1, backend: "fake" });
    renderPane();
    await screen.findByTestId("readability-diff-tx-1");
    expect(screen.getByTestId("readability-diff-prior-text-tx-1").textContent).toContain("function old()");
    expect(screen.getByTestId("readability-diff-new-text-tx-1").textContent).toContain("function neu()");
  });

  it("falls back to path + hash when priorContent/newContent are absent", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [TX_ROW], total: 1, backend: "fake" });
    renderPane();
    await screen.findByTestId("readability-diff-tx-1");
    expect(screen.queryByTestId("readability-diff-prior-text-tx-1")).toBeNull();
    expect(screen.queryByTestId("readability-diff-new-text-tx-1")).toBeNull();
  });

  it("changing the confidence filter re-queries with the new filter", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [NAME_ROW], total: 1, backend: "fake" });
    renderPane();
    await screen.findByText("loopCount");
    suggestionsMock.mockClear();
    fireEvent.change(screen.getByLabelText("confidence filter"), { target: { value: "high" } });
    await waitFor(() => expect(suggestionsMock).toHaveBeenCalledWith(expect.objectContaining({ confidence: "high" }), undefined));
  });

  it("batch-selecting rows and pressing Promote selected promotes every checked row", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [NAME_ROW, TX_ROW], total: 2, backend: "fake" });
    renderPane();
    await screen.findByText("loopCount");
    fireEvent.click(screen.getByLabelText("select suggestion sug-1"));
    fireEvent.click(screen.getByLabelText("select suggestion tx-1"));
    fireEvent.click(screen.getByRole("button", { name: "Promote selected" }));
    await waitFor(() => expect(promoteMock).toHaveBeenCalledTimes(2));
    expect(promoteMock).toHaveBeenCalledWith({ suggestionId: "sug-1" }, "ui");
    expect(promoteMock).toHaveBeenCalledWith({ txId: "tx-1" }, "ui");
  });

  it("batch-selecting rows and pressing Revert selected reverts every checked row", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [NAME_ROW], total: 1, backend: "fake" });
    renderPane();
    await screen.findByText("loopCount");
    fireEvent.click(screen.getByLabelText("select suggestion sug-1"));
    fireEvent.click(screen.getByRole("button", { name: "Revert selected" }));
    await waitFor(() => expect(revertMock).toHaveBeenCalledWith({ suggestionId: "sug-1" }));
  });

  it("a single row's own Accept/Revert buttons call promote/revert for just that row", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [NAME_ROW], total: 1, backend: "fake" });
    renderPane();
    await screen.findByText("loopCount");
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(promoteMock).toHaveBeenCalledWith({ suggestionId: "sug-1" }, "ui"));
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => expect(revertMock).toHaveBeenCalledWith({ suggestionId: "sug-1" }));
  });

  it("the four UI actions enqueue through the readability api: suggest names, make readable, combine files, review", async () => {
    suggestionsMock.mockResolvedValue({ suggestions: [], total: 0, backend: "fake" });
    renderPane(3);
    await screen.findByText("No readability suggestions match this filter.");

    fireEvent.click(screen.getByRole("button", { name: "Suggest names" }));
    await waitFor(() => expect(suggestNamesMock).toHaveBeenCalledWith({ fn: 3 }));

    fireEvent.click(screen.getByRole("button", { name: "Make readable" }));
    await waitFor(() => expect(rewriteFunctionMock).toHaveBeenCalledWith(3));

    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    await waitFor(() => expect(reviewMock).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Combine files" }));
    fireEvent.change(screen.getByLabelText("combine inputs (comma-separated paths)"), { target: { value: "src/a.js, src/b.js" } });
    fireEvent.change(screen.getByLabelText("combine output path"), { target: { value: "combined.js" } });
    fireEvent.change(screen.getByLabelText("combine evidence"), { target: { value: "both are the loop helper" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() =>
      expect(combineFilesMock).toHaveBeenCalledWith(["src/a.js", "src/b.js"], ["combined.js"], "both are the loop helper"),
    );
  });
});
