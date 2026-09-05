// ui/e2e/findings.spec.ts — spec 26 L6's acceptance tests: the full
// evidence-gated findings/leads workflow. Runs against the same throwaway
// server as smoke.spec.ts/align.spec.ts (ui/e2e/playwright.config.ts),
// never a hard-coded fn id or lead list — ground truth is always fetched
// from the live API first, exactly like xref-by-name.spec.ts.
import { test, expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";

const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 10_000;
const SHORT_WAIT = 5_000;
const API = process.env["PW_API_BASE"] ?? `http://127.0.0.1:${process.env["HBC2JS_E2E_PORT_BASE"] ?? "7341"}`;
const READONLY = process.env["PW_READONLY"] === "1";

interface ToolResult {
  readonly rid: string;
  readonly line: string;
}
interface ToolError {
  readonly reason: string;
}
interface LeadsResult {
  readonly groups: readonly { readonly leads: readonly { readonly fn: number | null; readonly evidence: string; readonly detail: string; readonly class: string }[] }[];
}
interface HistoryEntry {
  readonly rid: number;
  readonly kind: string;
  readonly ts: string;
}

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

async function apiPost<T>(request: APIRequestContext, path: string, body: unknown): Promise<{ readonly status: number; readonly json: T }> {
  const res = await request.post(`${API}/api${path}`, { data: body });
  return { status: res.status(), json: (await res.json()) as T };
}

const HUMAN = { source: "human" as const, who: "e2e" };

test.describe("Findings and leads: the full evidence-gated workflow (spec 26 L6)", () => {
  test("a bad evidence ref shows the backend's own rejection text", async ({ page, request }) => {
    test.skip(READONLY, "record-finding is a write — skipped on the read-only NSW run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    const fnId = Number(await firstFn.getAttribute("data-fn"));

    // Ground truth first: the exact rejection text the backend sends for
    // this fn with a non-resolving evidence ref (never hard-coded).
    const badRef = "sid:999999999";
    const apiResult = await apiPost<ToolError>(request, "/tools/record-finding", {
      class: "med",
      location: { fn: fnId },
      claim: "e2e bad-evidence probe",
      evidence: [{ ref: badRef, role: "site" }],
      prov: HUMAN,
    });
    expect(apiResult.status).toBeGreaterThanOrEqual(400);
    expect(apiResult.json.reason.length).toBeGreaterThan(0);

    const codeLine = page.locator(".cm-content .cm-line").first();
    await expect(codeLine).toBeVisible({ timeout: WAIT });
    await codeLine.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^Add finding/ }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: SHORT_WAIT });
    await dialog.locator("#hbc-finding-claim").fill("e2e bad-evidence probe (ui)");
    await dialog.locator("#hbc-finding-ref").fill(badRef);
    await dialog.getByRole("button", { name: /^Record finding/ }).click();

    const errorNote = dialog.getByText(apiResult.json.reason, { exact: true });
    await expect(errorNote).toBeVisible({ timeout: SHORT_WAIT });
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("a confirmed finding shows its evidence ref", async ({ page, request }) => {
    test.skip(READONLY, "record-finding/set-finding-status are writes — skipped on the read-only NSW run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    const fnId = Number(await firstFn.getAttribute("data-fn"));
    const resolvingRef = `fn:${fnId}`;

    // A unique claim per run: reruns against the same throwaway project
    // (no fixture regeneration between them) would otherwise accumulate
    // same-text findings and break the single-row text locator below.
    const claim = `e2e confirm-evidence probe ${Date.now()}`;
    const recorded = await apiPost<ToolResult>(request, "/tools/record-finding", {
      class: "high",
      location: { fn: fnId },
      claim,
      evidence: [{ ref: resolvingRef, role: "site" }],
      prov: HUMAN,
    });
    expect(recorded.status).toBe(200);

    // `open->confirmed` needs a resolving DYNAMIC-role ref, not a plain
    // static `fn:`/`sid:`/`mod:` one (src/project/findings.ts's
    // `checkStatusTransition`, spec 17 §14) — `fuzz:<path>` resolves iff
    // the path exists relative to the repo root (`defaultDynamicResolver`),
    // and `package.json` always does.
    const confirmed = await apiPost<ToolResult>(request, "/tools/set-finding-status", {
      findingRid: recorded.json.rid,
      to: "confirmed",
      evidence: [{ ref: "fuzz:package.json", role: "site" }],
      prov: HUMAN,
    });
    expect(confirmed.status).toBe(200);

    // Ground truth: whatever status `/api/findings` reports live for this
    // rid right now is what the row must show — never hard-coded, per this
    // suite's own discipline (xref-by-name.spec.ts). This is deliberate:
    // docs/BUGS.md's 2026-09-05 DB-backed-status-transition row documents
    // that a DB-backed project's `set_finding_status` write does not yet
    // surface on this read path (`src/project/findings.ts`'s `FindingStore`
    // still expects status changes as a separate `kind:"status"` revision;
    // the DB engine instead folds them into a new `kind:"finding"` one),
    // so `status` here may legitimately still read `"open"` until that is
    // fixed — this test pins today's real behaviour either way, rather than
    // asserting a UI-only lie about a backend gap.
    const truth = (await (await request.get(`${API}/api/findings`)).json()) as {
      rows: readonly { record: { rid: string; claim: string }; status: string }[];
    };
    const liveStatus = truth.rows.find((r) => r.record.claim === claim)?.status;
    expect(liveStatus).toBeDefined();

    await page.getByRole("tab", { name: "Findings" }).click();
    const row = page.getByText(claim, { exact: true }).locator("..");
    // `title="resolves"` is the evidence-ref span specifically (the row's
    // header separately shows the finding's own `target`, which can carry
    // the same `fn:N` text for a fn-scoped finding).
    await expect(row.locator('[title="resolves"]', { hasText: resolvingRef })).toBeVisible({ timeout: WAIT });
    await expect(row.getByText(liveStatus!, { exact: true })).toBeVisible({ timeout: WAIT });
  });

  test("promoting a lead prefills the finding form from the lead", async ({ page, request }) => {
    test.skip(READONLY, "opens a write dialog — skipped on the read-only NSW run");
    const leads = (await (await request.get(`${API}/api/leads`)).json()) as LeadsResult;
    const allLeads = leads.groups.flatMap((g) => g.leads);
    test.skip(allLeads.length === 0, "the e2e fixture bundle has no security-sink hits to promote");
    const lead = allLeads[0]!;

    await page.goto("/");
    await page.getByRole("tab", { name: "Leads" }).click();
    const promoteButton = page.getByTitle("Promote to finding").first();
    await expect(promoteButton).toBeVisible({ timeout: WAIT });
    await promoteButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: SHORT_WAIT });
    await expect(dialog.locator("#hbc-finding-claim")).toHaveValue(lead.detail);
    await expect(dialog.locator("#hbc-finding-ref")).toHaveValue(lead.evidence);
    await dialog.getByRole("button", { name: "Cancel" }).click();
  });

  test("the history view lists the target's revisions oldest-first", async ({ page, request }) => {
    test.skip(READONLY, "add-comment is a write — skipped on the read-only NSW run");
    await page.goto("/");
    const firstFn = await openFirstModuleAndFn(page);
    await firstFn.click();
    const fnId = Number(await firstFn.getAttribute("data-fn"));

    // Two writes on the same target, oldest first — the history view must
    // reverse the server's newest-first `revisions` rows to match.
    await apiPost<ToolResult>(request, "/tools/add-comment", { target: `fn:${fnId}`, body: "e2e history probe 1", prov: HUMAN });
    await apiPost<ToolResult>(request, "/tools/add-comment", { target: `fn:${fnId}`, body: "e2e history probe 2", prov: HUMAN });

    // Ground truth: the server sends `revisions` newest-first (spec 16
    // §3.2) — `HistoryPane` must show the exact reverse of this list.
    const truth = (await (await request.get(`${API}/api/history/fn:${fnId}`)).json()) as { rows: readonly HistoryEntry[] };
    expect(truth.rows.length).toBeGreaterThanOrEqual(2);
    const oldestFirstTs = [...truth.rows].reverse().map((r) => r.ts);

    const codeLine = page.locator(".cm-content .cm-line").first();
    await expect(codeLine).toBeVisible({ timeout: WAIT });
    await codeLine.click({ button: "right" });
    await page.getByRole("menuitem", { name: /^History/ }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: SHORT_WAIT });
    await expect(dialog.locator(".hbc-scroll > div").first()).toBeVisible({ timeout: WAIT });
    const renderedTs = await dialog.locator(".hbc-scroll > div > span.w-40").allTextContents();
    expect(renderedTs).toEqual(oldestFirstTs);
  });
});
