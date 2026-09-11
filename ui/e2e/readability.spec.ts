// ui/e2e/readability.spec.ts — spec 28 landing 4d: proves the readability
// pane end to end against the REAL `ui-server` process this rig starts
// (`playwright.config.ts`'s `webServer` — no `--llm-backend` flag needed:
// its env already pins `HBC2JS_LLM_BACKEND=heuristic`, and
// `buildReadabilityCtx` (src/ui-server/server.ts) reads that same env var
// when no explicit `--llm-backend` is given).
//
// What this file does NOT cover, and why: the brief's full round trip
// ("run suggest names, see a suggestion row with confidence/evidence/equiv
// columns, promote it, see the tier flip, revert it, see it gone") needs a
// backend whose reply `suggest_names` can actually PARSE as the readability
// JSON envelope (`{names:[...], abstained}`, `src/readability/types.ts`'s
// `parseReadabilityResult`). `HeuristicBackend.run` (the one this rig pins,
// and `FakeBackend`'s own default reply, checked the same way in
// `tests/ui-server/server-readability.test.ts`) returns a bare name
// STRING for `suggest-name`/`name-module` jobs (`deriveName`), which is
// not JSON at all — `runNamePass` correctly treats that as an abstention,
// so `suggest_names` deterministically proposes ZERO names against this
// rig's pinned backend. That is itself a real, deterministic outcome (not
// flakiness). A suggestion-row/promote/revert/tier-flip test needs either a
// real LLM backend (out of scope for a CI rig, spec 28's own rule: never a
// real model in a gate) or a pre-seeded transaction — the DB-side round
// trip is already proven without a browser in `tests/gate/llm-readability/
// surfaces.test.ts`'s exit-criterion test and `tests/ui-server/
// readability-routes.test.ts`'s promote/revert test.
//
// PERFORMANCE FINDING (docs/BUGS.md, filed alongside this file): a cold
// `suggest_names`/`rewrite_function`/`classify_module` call re-parses AND
// re-analyses the WHOLE `.hbc` file from scratch every time
// (`src/readability/surfaces.ts`'s `loadAnalysis`, no cache, unlike
// `ArtifactService.warmFrames` everything else in `ui-server` shares) --
// measured over 70s wall on this rig's own 435-module/4,199-function
// fixture bundle. Landing 4d's own P-61 fix (JOB_KINDS/WorkerRunner) makes
// this an ASYNC job instead of a blocking HTTP call, which is exactly why
// this file can assert the enqueue succeeded (fast, deterministic) without
// waiting out that 70s: waiting for full completion in a browser test would
// make this suite unacceptably slow for no proof-of-wiring gained beyond
// what the enqueue assertion below already gives, and
// `tests/ui-server/server-readability.test.ts` already proves a real
// background pool claims and finishes this exact job kind end to end.
import { test, expect, type Locator, type Page } from "@playwright/test";
import { API_PORT } from "./prepare-fixture.mjs";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;
const READONLY = process.env["PW_READONLY"] === "1";
const usingFixture = process.env["PW_BASE_URL"] === undefined;

async function openFirstModuleAndFn(page: Page): Promise<Locator> {
  const firstModule = page.locator("[data-module]").first();
  await expect(firstModule).toBeVisible({ timeout: WAIT });
  const firstFn = page.locator("[data-fn]").first();
  if (!(await firstFn.isVisible().catch(() => false))) await firstModule.click();
  await expect(firstFn).toBeVisible({ timeout: WAIT });
  return firstFn;
}

const codeView = (page: Page): Locator => page.getByTestId("code-view").first();

test.describe("Readability section: live wiring (spec 28 landing 4d)", () => {
  test.skip(READONLY, "the NSW rig has no --llm-backend pin and this suite must never call a real model");

  test("the Readability section renders under the AI tab, over a real ui-server process", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await expect(codeView(page).locator(".cm-content")).not.toBeEmpty({ timeout: WAIT });

    await page.getByRole("tab", { name: "AI" }).click();
    await expect(page.getByText("Readability", { exact: true })).toBeVisible({ timeout: WAIT });
    // Not the "not configured" 503 state (docs/UI.md's "absent, not faked"
    // convention) — the section's own action buttons must be present.
    await expect(page.getByRole("button", { name: "Suggest names" })).toBeVisible({ timeout: WAIT });
  });

  test("Review completes against the live routes (deterministic: a fresh project starts with zero suggestions)", async ({ page }) => {
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await page.getByRole("tab", { name: "AI" }).click();
    await expect(page.getByRole("button", { name: "Review" })).toBeVisible({ timeout: WAIT });

    await page.getByRole("button", { name: "Review" }).click();
    // `GET /api/readability/actions/review` -> `{opened:true, pending:N}`,
    // rendered as the one-line status toast (ui/src/actions/ActionsProvider.tsx).
    await expect(page.getByText(/^review: \d+ suggestion\(s\) pending$/)).toBeVisible({ timeout: WAIT });
  });

  test("Suggest names reaches the live suggest_names surface: it ENQUEUES a real readability-suggest-names job (spec 28 landing 4d, P-61)", async ({
    page,
  }) => {
    test.skip(!usingFixture, "needs the fixture rig's own API port, not the read-only NSW preview");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    await page.getByRole("tab", { name: "AI" }).click();
    await expect(page.getByRole("button", { name: "Suggest names" })).toBeVisible({ timeout: WAIT });

    const jobsBefore = (await (await page.request.get(`http://127.0.0.1:${String(API_PORT)}/api/jobs`)).json()) as {
      rows: readonly { readonly id: string; readonly kind: string }[];
    };

    await page.getByRole("button", { name: "Suggest names" }).click();

    // POST /api/readability/actions/suggest-names must reach the live
    // server and enqueue (202 -> a real `readability-suggest-names` row in
    // the SAME `/api/jobs` the ordinary jobs rail polls) — this file's own
    // header explains why the test asserts the enqueue, not the ~70s cold
    // completion, and how the completion path is proven elsewhere.
    await expect(async () => {
      const jobsAfter = (await (await page.request.get(`http://127.0.0.1:${String(API_PORT)}/api/jobs`)).json()) as {
        rows: readonly { readonly id: string; readonly kind: string; readonly status: string }[];
      };
      const before = new Set(jobsBefore.rows.map((r) => r.id));
      const newJob = jobsAfter.rows.find((r) => r.kind === "readability-suggest-names" && !before.has(r.id));
      expect(newJob).toBeTruthy();
      expect(["queued", "running", "done"]).toContain(newJob?.status);
    }).toPass({ timeout: WAIT });
  });
});
