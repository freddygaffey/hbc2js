// ui/src/graph/open-in-listing.dom.test.tsx — bur 14 (docs/UI-BURS.md #14):
// unit coverage for the pure pieces of "double-click a graph node jumps to
// the code" that do not need a mounted React Flow canvas at all —
// GraphPane.tsx's own Playwright coverage (../../e2e/graph-open-in-
// listing.spec.ts) is the end-to-end assertion, this is the fast layer
// underneath it (spec 19 §2 layer 2 discipline: no pixels, just state).
//
// `.dom.test.tsx` (not `.test.ts`) only because `vitest.config.ts`'s
// `include` is scoped to that suffix (spec 26 L7) — nothing here actually
// touches the DOM; jsdom is simply the environment `npm run test:dom` runs
// under.
import { afterEach, describe, expect, it } from "vitest";
import { getSelection, resetSelection } from "../state/selection.ts";
import {
  getGraphState, openGraphTargetInListing, resetGraphState, selectionForGraphTarget, setGraphMaximised,
} from "./store.ts";

afterEach(() => {
  resetSelection();
  resetGraphState();
});

describe("selectionForGraphTarget (bur 14)", () => {
  it("a fn graph target becomes a fn selection", () => {
    expect(selectionForGraphTarget({ kind: "fn", ref: 42 })).toEqual({ kind: "fn", fn: 42 });
  });

  it("a module graph target becomes a module selection", () => {
    expect(selectionForGraphTarget({ kind: "module", ref: 7 })).toEqual({ kind: "module", moduleId: "7" });
  });
});

describe("openGraphTargetInListing (bur 14)", () => {
  it("selects the target so the listing's own scroll/highlight machinery picks it up", () => {
    openGraphTargetInListing({ kind: "fn", ref: 42 });
    expect(getSelection()).toMatchObject({ kind: "fn", fn: 42 });
  });

  it("un-maximises the graph pane, which otherwise hides the listing behind it", () => {
    setGraphMaximised(true);
    expect(getGraphState().maximised).toBe(true);
    openGraphTargetInListing({ kind: "fn", ref: 42 });
    expect(getGraphState().maximised).toBe(false);
  });

  it("leaves a non-maximised graph alone", () => {
    setGraphMaximised(false);
    openGraphTargetInListing({ kind: "module", ref: 3 });
    expect(getGraphState().maximised).toBe(false);
    expect(getSelection()).toMatchObject({ kind: "module", moduleId: "3" });
  });
});
