// ui/e2e/live-update.spec.ts — spec 26 L1's acceptance e2e: "an out-of-band
// write appears in the pane, not only in the activity feed". Drives a write
// through `McpTools` directly, from a SECOND `McpContext` in THIS test
// process, over the SAME `.hbcproj` the running ui-server (its own child
// process, playwright.config.ts's `webServer`) has open — the genuine
// "second process, no access to the in-process write bus" case spec 21
// §1.3 names, so this exercises the log-as-authority poll/SSE-tail
// convergence path, not (only) the doorbell (tests/ui-server/events-bus.
// test.ts covers the doorbell itself at the unit level).
import { test, expect, type Locator, type Page } from "@playwright/test";
import { PROJECT_DIR } from "./prepare-fixture.mjs";
import { McpContext } from "../../src/mcp/context.ts";

const READONLY = process.env["PW_READONLY"] === "1";
const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;

/** Same shape as smoke.spec.ts's own helper — duplicated rather than
 *  imported so this file has no cross-file coupling to another spec's
 *  internals. */
async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) {
    await firstModule.click();
  }
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

test.describe("live update: out-of-band writes reach the pane, not only Activity", () => {
  test.skip(READONLY, "this test writes to the project — skipped on the read-only NSW run");

  test("an out-of-band write appears in the pane, not only in the activity feed", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    const fn = Number(await firstFn.getAttribute("data-fn"));
    expect(Number.isInteger(fn)).toBe(true);
    await firstFn.click();

    // Context pane visible with this fn's (pre-write) name row.
    const nameLabel = page.locator("span.w-28", { hasText: /^name$/ });
    await expect(nameLabel.locator("xpath=following-sibling::span[1]")).toBeVisible({ timeout: WAIT });

    // The out-of-band write: a SEPARATE McpContext/McpTools pair over the
    // SAME project dir, in this Node process — never through the running
    // ui-server's HTTP surface, and never through its in-process write bus.
    const mcp = new McpContext(PROJECT_DIR);
    try {
      mcp.tools.setName({
        target: `fn:${fn}`,
        name: "zz_outOfBand",
        prov: { source: "tool", who: "live-update-e2e" },
      });
    } finally {
      // McpContext holds its own DB handle open for its process lifetime;
      // there is no explicit close on the public surface (mirrors how
      // short-lived CLI invocations use it) — nothing to release here.
    }

    // No manual refresh: the running ui-server's log poll/SSE tail picks
    // up the second process's write and the Context pane updates on its
    // own (spec 26 L1 (iii)/(iv), spec 21 §1.2's "hand edits/other
    // processes also appear live" guarantee).
    await expect(nameLabel.locator("xpath=following-sibling::span[1]")).toHaveText("zz_outOfBand", { timeout: WAIT });
  });
});
