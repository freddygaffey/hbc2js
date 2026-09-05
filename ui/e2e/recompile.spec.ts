// ui/e2e/recompile.spec.ts — docs/specs/26-ui-full-ide.md L8's named e2e
// acceptance: the attended "Edit & recompile" flow shows spec 17 §13's
// warning and the `{kind:"edited-and-recompiled"}` watermark VERBATIM, and
// cancelling posts nothing at all.
//
// Runs against the throwaway fixture rig (prepare-fixture.mjs), never the
// live NSW rig: this spec writes (one logged `recompile_edit` comment row on
// the fixture project) and produces a scratch binary, so it is skipped under
// PW_READONLY exactly as the rename/live-update specs are.
import { test, expect, type Locator, type Page } from "@playwright/test";

const READONLY = process.env["PW_READONLY"] === "1";
const WAIT = process.env["PW_BASE_URL"] !== undefined ? 90_000 : 15_000;

const EDIT_SOURCE = "function patched(a, b) { return a + b; }\nprint(patched(1, 2));\n";

/** Same helper shape as smoke.spec.ts / live-update.spec.ts — duplicated
 *  rather than imported so no spec depends on another spec's internals. */
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

async function openEditPane(page: Page): Promise<void> {
  await page.goto("/");
  const firstFn = await openFirstModuleAndFn(page);
  await firstFn.click();
  await page.getByRole("tab", { name: "Edit", exact: true }).click();
  await expect(page.getByTestId("edit-pane")).toBeVisible({ timeout: WAIT });
}

test.describe("recompile_edit is attended, and its warning travels verbatim", () => {
  test.skip(READONLY, "this test compiles and writes - skipped on the read-only NSW run");

  test("the warning and watermark text are shown verbatim", async ({ page }) => {
    await openEditPane(page);
    await page.getByTestId("recompile-source").fill(EDIT_SOURCE);

    // Attended: the first press only asks for confirmation, it never posts.
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST" && r.url().includes("/api/tools/recompile-edit")) posts.push(r.url());
    });
    await page.getByTestId("recompile-run").click();
    await expect(page.getByTestId("recompile-confirm")).toBeVisible();
    expect(posts).toEqual([]);

    await page.getByTestId("recompile-confirm").click();
    const warning = page.getByTestId("recompile-warning");
    const failure = page.getByTestId("recompile-error");
    await expect(warning.or(failure)).toBeVisible({ timeout: WAIT });

    // A machine without `tools/hermesc/vNN` for this bundle's version cannot
    // recompile anything; the server says so and this spec has nothing left
    // to assert. Skipped loudly, never passed silently.
    if (await failure.isVisible()) {
      const reason = (await failure.textContent()) ?? "";
      test.skip(/no hermesc/.test(reason), `no hermesc toolchain for this bundle: ${reason}`);
      throw new Error(`recompile-edit failed for a reason other than a missing toolchain: ${reason}`);
    }

    // VERBATIM (spec 26 L8): the server's own sentence, whole - opening
    // clause, the spec reference, and the final clause - with no ellipsis or
    // other truncation marker anywhere in it.
    const text = ((await warning.textContent()) ?? "").trim();
    expect(text.startsWith("WARNING: recompile_edit PRODUCES A MODIFIED BINARY, not a read-only answer.")).toBe(true);
    expect(text).toContain("spec 17 §13");
    expect(text.endsWith("must never be distributed.")).toBe(true);
    expect(text).not.toMatch(/…|\.\.\.|\[truncated\]/);

    // The watermark, unmodified, with its base-bundle provenance intact.
    const watermark = JSON.parse((await page.getByTestId("recompile-watermark").textContent()) ?? "{}") as {
      kind?: string;
      baseBundleSha256?: string;
      editSha256?: string;
      fn?: number;
    };
    expect(watermark.kind).toBe("edited-and-recompiled");
    expect(watermark.baseBundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(watermark.editSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof watermark.fn).toBe("number");

    // The sandbox is reported and was torn down (spec 21 §2.1: no residue).
    await expect(page.getByTestId("recompile-sandbox")).toContainText("torn down");
    await expect(page.getByTestId("recompile-sandbox")).toContainText("yes");
    expect(posts.length).toBe(1);
  });

  test("cancel writes nothing", async ({ page }) => {
    await openEditPane(page);
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });

    await page.getByTestId("recompile-source").fill(EDIT_SOURCE);
    await page.getByTestId("recompile-run").click();
    await expect(page.getByTestId("recompile-confirm")).toBeVisible();

    // Cancel from the confirm step: the draft goes, and no POST was ever
    // made - so nothing was compiled, no scratch binary exists and no
    // `.hbcproj` row was written.
    await page.getByTestId("recompile-cancel").click();
    await expect(page.getByTestId("recompile-source")).toHaveValue("");
    await expect(page.getByTestId("recompile-run")).toBeVisible();
    await expect(page.getByTestId("recompile-warning")).toHaveCount(0);
    await expect(page.getByTestId("recompile-watermark")).toHaveCount(0);
    expect(posts).toEqual([]);
  });
});
