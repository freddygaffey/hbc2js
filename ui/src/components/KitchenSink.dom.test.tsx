// ui/src/components/KitchenSink.dom.test.tsx — spec 19 §2 layer 2 / spec 26
// L7's DOM test layer: Testing Library discipline (roles, accessible names,
// structure), never pixels — pixel coverage of the same route is
// ui/e2e/visual.spec.ts's "kitchen sink matches the baseline" tests.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KitchenSink } from "./KitchenSink.tsx";

afterEach(cleanup);

// KitchenSink supplies its own Tooltip.Provider (it is mounted standalone by
// main.tsx, never inside App.tsx's), so a bare render is enough here.
function renderSink(): ReturnType<typeof render> {
  return render(<KitchenSink />);
}

describe("KitchenSink (spec 20 §1.7 step 2)", () => {
  it("renders a labelled heading and the four severity swatches", () => {
    renderSink();
    expect(screen.getByRole("heading", { name: "Kitchen sink" })).toBeTruthy();
    for (const sev of ["crit", "high", "med", "ok"]) {
      expect(screen.getByTestId(`sev-${sev}`).textContent).toBe(sev);
    }
  });

  it("every ToolButton primitive is a real, accessibly-named button", () => {
    renderSink();
    const names = ["Default", "Active", "With tooltip", "Disabled"];
    for (const name of names) {
      const btn = screen.getByRole("button", { name });
      expect(btn.tagName).toBe("BUTTON");
    }
    expect(screen.getByRole("button", { name: "Disabled" }).hasAttribute("disabled")).toBe(true);
  });

  it("renders the four-step type ramp and both elevation levels", () => {
    renderSink();
    for (const step of ["xs", "sm", "base", "lg"]) {
      expect(screen.getByTestId(`type-${step}`)).toBeTruthy();
    }
    expect(screen.getByTestId("elevation-0")).toBeTruthy();
    expect(screen.getByTestId("elevation-1")).toBeTruthy();
  });
});
