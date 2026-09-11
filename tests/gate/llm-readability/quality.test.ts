// Spec 28 section 7 "Quality" target: on a hand-labelled sample, >= 80% of
// `high`-confidence names are judged accurate and ZERO name misrepresents a
// security-relevant target. The sample, its format and the pluggable rater are
// green today; the measurement over real proposals needs landing 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import {
  LABELLED_TARGET_KINDS,
  MODULE_ROLES,
  ReferenceNameRater,
  highConfidenceAccuracy,
  normaliseName,
} from "../../../src/readability/types.ts";
import type { Confidence } from "../../../src/name-overlay/store.ts";
import type { LabelledSample, QualityRater, RaterVerdict, LabelledTarget } from "../../../src/readability/types.ts";

const SAMPLE_PATH = join(repoRoot(), "tests", "fixtures", "llm-readability", "react-navigation-example-0.85.3.labels.json");
const MAP_PATH = join(
  repoRoot(),
  "tests",
  "fixtures",
  "bundles",
  "react-navigation-example-0.85.3",
  "react-navigation-example.map",
);
const HAIKU_BACKEND_PATH = join(repoRoot(), "src", "workers", "backends", "haiku.ts");

export const HIGH_CONFIDENCE_ACCURACY_TARGET = 0.8;

function sample(): LabelledSample {
  return JSON.parse(readFileSync(SAMPLE_PATH, "utf8")) as LabelledSample;
}

test("spec 28: the labelled sample conforms to the documented format", () => {
  const s = sample();
  assert.equal(s.app, "react-navigation-example-0.85.3");
  assert.ok(s.labelledBy.length > 0 && s.labelSource.length > 0, "a sample must say who labelled it and from what");
  assert.ok(s.targets.length >= 10, "a sample below ~10 targets cannot support an 80% claim");

  const ids = new Set<string>();
  let securityRelevant = 0;
  for (const t of s.targets) {
    assert.ok(!ids.has(t.id), `duplicate sample id ${t.id}`);
    ids.add(t.id);
    assert.ok((LABELLED_TARGET_KINDS as readonly string[]).includes(t.kind), `${t.id}: bad kind ${t.kind}`);
    assert.ok(t.source.startsWith("/"), `${t.id}: source must be a sourcemap path`);
    assert.ok(t.referenceName.length > 0, `${t.id}: no reference name`);
    assert.ok(Array.isArray(t.alsoAccept), `${t.id}: alsoAccept must be an array`);
    assert.equal(typeof t.securityRelevant, "boolean", `${t.id}: securityRelevant must be a boolean`);
    assert.ok(t.note.length > 0, `${t.id}: a label without a note is not reviewable`);
    if (t.role !== undefined) {
      assert.ok((MODULE_ROLES as readonly string[]).includes(t.role), `${t.id}: bad role ${t.role}`);
    }
    if (t.securityRelevant) securityRelevant += 1;
  }
  assert.ok(securityRelevant >= 1, "the sample must contain at least one security-relevant target to test that clause");
});

test("spec 28: every labelled target names a source that really is in the held-out app, and none is vendor code", () => {
  assert.ok(existsSync(MAP_PATH), "the held-out app's sourcemap is the label provenance and must be present");
  const map = JSON.parse(readFileSync(MAP_PATH, "utf8")) as { sources?: readonly string[] };
  const sources = new Set(map.sources ?? []);
  assert.ok(sources.size > 100, "sourcemap did not parse into a source list");
  for (const t of sample().targets) {
    assert.ok(sources.has(t.source), `${t.id}: ${t.source} is not a source of the held-out bundle`);
    assert.ok(!t.source.includes("node_modules"), `${t.id}: spec 28 section 3 names only src/ modules`);
  }
});

test("spec 28: the default rater grades accurate / inaccurate / misleading, and is pluggable", () => {
  const rater = new ReferenceNameRater();
  const s = sample();
  const byId = new Map(s.targets.map((t) => [t.id, t]));

  const exact = byId.get("rn-ex-03");
  assert.ok(exact !== undefined);
  assert.equal(rater.rate(exact, "useNavigationBuilder.js").verdict, "accurate");
  // Normalisation is case- and separator-insensitive, not meaning-insensitive.
  assert.equal(rater.rate(exact, "use_navigation_builder.js").verdict, "accurate");
  assert.equal(rater.rate(exact, "helpers.js").verdict, "inaccurate");

  const alt = byId.get("rn-ex-06");
  assert.ok(alt !== undefined);
  assert.equal(rater.rate(alt, "DrawerNavigator.js").verdict, "accurate", "alsoAccept names count as accurate");

  const security = byId.get("rn-ex-08");
  assert.ok(security !== undefined);
  assert.equal(security.securityRelevant, true);
  assert.equal(rater.rate(security, "stringUtils.js").verdict, "misleading");

  // Pluggable: any object with {id, rate} is a rater. The interface, not the
  // implementation, is what spec 28 section 9.6 fixes.
  const alwaysAccurate: QualityRater = {
    id: "stub",
    rate(): RaterVerdict {
      return { verdict: "accurate", rationale: "stub" };
    },
  };
  assert.equal(alwaysAccurate.rate(security, "anything").verdict, "accurate");
  assert.equal(normaliseName("Foo-Bar_baz.js"), "foobarbazjs");
});

test("spec 28: high-confidence accuracy is computed over high-confidence proposals only, and is undefined when there are none", () => {
  const rater = new ReferenceNameRater();
  const s = sample();
  const proposals = new Map<string, { name: string; confidence: Confidence }>();
  // 4 high-confidence: 3 right, 1 wrong -> 0.75, below the 80% bar.
  proposals.set("rn-ex-03", { name: "useNavigationBuilder.js", confidence: "high" });
  proposals.set("rn-ex-04", { name: "StackRouter.js", confidence: "high" });
  proposals.set("rn-ex-05", { name: "TabRouter.js", confidence: "high" });
  proposals.set("rn-ex-09", { name: "misc.js", confidence: "high" });
  // A low-confidence wrong answer must not count against the bar.
  proposals.set("rn-ex-10", { name: "wrong.js", confidence: "low" });
  const got = highConfidenceAccuracy(rater, s, proposals);
  assert.ok(got !== undefined);
  assert.equal(got.n, 4);
  assert.equal(got.rate, 0.75);
  assert.ok(got.rate < HIGH_CONFIDENCE_ACCURACY_TARGET, "the helper must be able to report a FAILING run");

  assert.equal(highConfidenceAccuracy(rater, s, new Map()), undefined, "an empty set is no claim, not a vacuous 100%");

  const misleading = new Map<string, { name: string; confidence: Confidence }>([
    ["rn-ex-08", { name: "stringUtils.js", confidence: "high" }],
  ]);
  const bad = highConfidenceAccuracy(rater, s, misleading);
  assert.ok(bad !== undefined);
  assert.equal(bad.misleading, 1, "a misrepresented security-relevant target must be countable");
});

test("spec 28 section 7 (quality): >= 80% of high-confidence names on the labelled sample are accurate", (t) => {
  const s: LabelledSample = sample();
  const first: LabelledTarget | undefined = s.targets[0];
  assert.ok(first !== undefined);
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1 (naming path)`);
    return;
  }
  t.skip("landing 1 owns this: run the naming pass over the held-out app and feed its proposals to highConfidenceAccuracy");
});

test("spec 28 section 7 (quality): zero name misrepresenting a security-relevant function survives the verify pass", (t) => {
  if (!existsSync(HAIKU_BACKEND_PATH)) {
    t.skip(`${HAIKU_BACKEND_PATH} does not exist yet -- spec 28 LANDING 1; the adversarial re-check itself is LANDING 5`);
    return;
  }
  t.skip("landing 5 owns this: the adversarial re-check must drive `misleading` to zero on security-relevant targets");
});
