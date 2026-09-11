// Spec 28 section 7 "Coverage" target: >= 70% of `src/` registers and >= 80%
// of `src/` modules get a real name, measured on the NSW app and on a held-out
// app. Both need landing 1's HaikuBackend, so both are RED-SKIPPED; the NSW leg
// additionally needs a bundle that is NOT in this repo and never will be.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

/** The NSW bundle is proprietary: it lives outside the repo and the test reads
 *  its path from the environment. Unset means skip-with-reason, on every
 *  machine and in CI, forever -- not a failure and not an oracle gap. */
export const NSW_ENV = "HBC2JS_NSW_HBC";

const HAIKU_BACKEND_PATH = join(repoRoot(), "src", "workers", "backends", "haiku.ts");
const HELD_OUT_HBC = join(
  repoRoot(),
  "tests",
  "fixtures",
  "bundles",
  "react-navigation-example-0.85.3",
  "react-navigation-example.hbc",
);

export const REGISTER_COVERAGE_TARGET = 0.7;
export const MODULE_COVERAGE_TARGET = 0.8;

test("spec 28 section 7 (coverage): NSW src registers >= 70% and modules >= 80% named", (t) => {
  const bundle = process.env[NSW_ENV];
  if (bundle === undefined || bundle === "") {
    t.skip(
      `${NSW_ENV} is unset: the NSW bundle is proprietary and is never committed (CLAUDE.md). ` +
        `Set ${NSW_ENV}=/path/to/bundle.hbc on a machine that has it to run this target.`,
    );
    return;
  }
  if (!existsSync(bundle)) {
    t.skip(`${NSW_ENV}=${bundle} does not exist`);
    return;
  }
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1 (naming path)`);
    return;
  }
  t.skip("landing 1 owns this: run `name llm-fill --only src` over the NSW project and assert the two ratios");
});

test("spec 28 section 7 (coverage): the held-out app hits the same two ratios", (t) => {
  // The held-out app IS in the repo, so only the landing is missing.
  assert.ok(existsSync(HELD_OUT_HBC), "the held-out app fixture must be present (tests/fixtures/bundles/...)");
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1 (naming path)`);
    return;
  }
  t.skip("landing 1 owns this: same measurement on react-navigation-example-0.85.3, which the skills were not tuned on");
});

test("spec 28 section 7 (coverage): the targets are stated once, in code, so a landing cannot quietly lower them", () => {
  assert.equal(REGISTER_COVERAGE_TARGET, 0.7);
  assert.equal(MODULE_COVERAGE_TARGET, 0.8);
  const spec = join(repoRoot(), "docs", "specs", "28-llm-readability.md");
  assert.ok(existsSync(spec));
});
