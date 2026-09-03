// The REAL EvidenceResolver — docs/specs/11-project-store.md §4.1, §7 step 4:
// `fn:`/`reg:`/`sid:`/`mod:` refs resolve against a real artifact's index
// via `ArtifactEvidenceResolver` (`src/project/evidence-resolver.ts`); an
// unknown-kind ref is unresolvable, never guessed; `trace:`/`fuzz:`/`repro:`
// refs go to the injected `DynamicResolver`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { cachedSplitProject as splitProject } from "../support/decompiled.ts";
import { writeArtifact } from "../../src/artifact/write.ts";
import { ArtifactService } from "../../src/artifact/service.ts";
import { ArtifactEvidenceResolver } from "../../src/project/evidence-resolver.ts";
import { hasResolvingEvidence } from "../../src/project/evidence-resolver.ts";

const RN_TEMPLATE = join(repoRoot(), "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");
const bytes = readFileSync(RN_TEMPLATE);
const splitResult = splitProject(bytes, { moduleName: "index.android.hbc" });
const outDir = mkdtempSync(join(tmpdir(), "hbc2js-evidence-resolver-"));
writeArtifact({ bytes, splitResult, outDir, passes: {}, strictEnv: false, form: "flat" });
const svc = new ArtifactService(outDir);

test.after(() => rmSync(outDir, { recursive: true, force: true }));

const functionRows = readFileSync(join(outDir, "index", "functions.jsonl"), "utf8").trim().split("\n").slice(1).map((l) => JSON.parse(l) as { fn: number });
const stringsIndex = JSON.parse(readFileSync(join(outDir, "index", "strings.json"), "utf8")) as { entries: readonly { sid: number }[] };
const modulesIndex = JSON.parse(readFileSync(join(outDir, "index", "modules.json"), "utf8")) as { modules: readonly { id: number }[] };
const realFn = functionRows[0]!.fn;
const realSid = stringsIndex.entries[0]!.sid;
const realMod = modulesIndex.modules[0]!.id;
const NO_SUCH = 999_999_999;

test("resolves fn: against real vs absent function indices", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(r.resolves(`fn:${realFn}`), true);
  assert.equal(r.resolves(`fn:${NO_SUCH}`), false);
});

test("resolves reg: iff the owning function is real", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(r.resolves(`reg:${realFn}:0`), true);
  assert.equal(r.resolves(`reg:${NO_SUCH}:0`), false);
  assert.equal(r.resolves(`reg:${realFn}:-1`), false);
});

test("resolves sid: against real vs absent string ids", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(r.resolves(`sid:${realSid}`), true);
  assert.equal(r.resolves(`sid:${NO_SUCH}`), false);
});

test("resolves mod: against real vs absent module ids", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(r.resolves(`mod:${realMod}`), true);
  assert.equal(r.resolves(`mod:${NO_SUCH}`), false);
});

test("an unknown-kind ref is unresolvable, never guessed", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(r.resolves("bogus:whatever"), false);
  assert.equal(r.resolves("no-colon-at-all"), false);
});

test("trace:/fuzz:/repro: refs are unresolvable by default (no dynamic backing store exists yet) — never guessed true", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(r.resolves("trace:campaign1/seed-777007"), false);
  assert.equal(r.resolves("repro:whatever"), false);
});

test("a fuzz: ref resolves against a real on-disk path (the default DynamicResolver's own rule)", () => {
  const r = new ArtifactEvidenceResolver(svc);
  const realPath = join("tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc").replace(/\\/g, "/");
  assert.equal(r.resolves(`fuzz:${realPath}`), true);
  assert.equal(r.resolves("fuzz:no/such/path/at/all"), false);
});

test("an injected DynamicResolver overrides trace:/fuzz:/repro: resolution", () => {
  const r = new ArtifactEvidenceResolver(svc, { resolves: (ref) => ref === "trace:campaign1/seed-777007" });
  assert.equal(r.resolves("trace:campaign1/seed-777007"), true);
  assert.equal(r.resolves("trace:campaign1/seed-unknown"), false);
});

test("hasResolvingEvidence composes with the real resolver exactly like the mock (P2's rule, real backing)", () => {
  const r = new ArtifactEvidenceResolver(svc);
  assert.equal(hasResolvingEvidence([{ ref: `fn:${NO_SUCH}` }, { ref: `sid:${realSid}` }], r), true);
  assert.equal(hasResolvingEvidence([{ ref: `fn:${NO_SUCH}` }], r), false);
  assert.equal(hasResolvingEvidence([], r), false);
});
