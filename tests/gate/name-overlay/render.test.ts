// Naming overlay against a real bundle — the gate, identity stability, frame
// isolation, behaviour-preserving render, and render collision. Spec §11 items
// 1,2,3(structural),4,7,8. Execution equivalence (§11.3 second half) is the
// trace-oracle's job on the runnable-fixture sweep; here we assert the render
// is a pure textual alpha-rename, which is the structural half.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { parseForDecompile } from "../../../src/decompile.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { NameService, OverlayStore, regId } from "../../../src/name-overlay/index.ts";
import { rawFrameBodies } from "../../../src/name-overlay/index.ts";

const FIXTURE = "04-for-loop-basic";

function fixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", name, "v94.hbc")));
}

function analysisFor(name: string): ReturnType<typeof analyseModule> {
  return analyseModule(parseForDecompile(fixtureBytes(name), {}).module, { strictEnv: true });
}

function service(name = FIXTURE): NameService {
  return new NameService(analysisFor(name), new OverlayStore({ bundle: name }));
}

test("identity: the same bundle yields identical raw register frames across runs (spec §11.1)", () => {
  const a = rawFrameBodies(analysisFor(FIXTURE));
  const b = rawFrameBodies(analysisFor(FIXTURE));
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
  // fn0's register-decl frame is identical structurally: a name keyed to
  // {fn:0,reg:9} in run A addresses the very same binding in run B.
  const declA = a.get(0)!.find((s) => s.k === "decl");
  const declB = b.get(0)!.find((s) => s.k === "decl");
  assert.deepEqual(declA, declB);
});

test("gate: a globalThis-alias register is refused and is overridable (spec §11.2)", () => {
  const svc = service();
  // r6 = globalThis in fn0 of this fixture.
  const refused = svc.setName(regId(0, 6), "g", { confidence: "high", evidence: "", source: "llm" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, "globalthis-alias");
    assert.equal(refused.overridable, true);
  }
  assert.equal(svc.getName(regId(0, 6)), null, "a refused name is not stored");
});

test("gate override stamps overridden + forces low confidence (spec §6/§11.2)", () => {
  const svc = service();
  const out = svc.setName(regId(0, 6), "g", { confidence: "high", evidence: "", source: "human", override: true });
  assert.equal(out.ok, true);
  const rec = svc.getName(regId(0, 6))!;
  assert.equal(rec.gate, "overridden");
  assert.equal(rec.confidence, "low"); // forced low even though "high" was requested
});

test("gate: an absent/non-binding register is refused, not silently applied (spec §11.8)", () => {
  const svc = service();
  const refused = svc.setName(regId(0, 999), "nope", { confidence: "med", evidence: "", source: "llm" });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, "no-binding");
    assert.equal(refused.overridable, false); // there is nothing to name
  }
});

test("gate: a reserved/emitter-shaped name is refused unconditionally (spec §6)", () => {
  const svc = service();
  for (const bad of ["return", "r5", "_fn0", "1abc"]) {
    const r = svc.setName(regId(0, 9), bad, { confidence: "med", evidence: "", source: "llm", override: true });
    assert.equal(r.ok, false, `expected ${bad} refused`);
    if (!r.ok) assert.equal(r.overridable, false);
  }
});

test("render is a pure textual alpha-rename of the named register (spec §11.3 structural)", () => {
  const before = service().render({ fn: 0 }).code;
  const svc = service();
  const set = svc.setName(regId(0, 9), "loopLimit", { confidence: "med", evidence: "loop bound", source: "llm" });
  assert.equal(set.ok, true);
  const after = svc.render({ fn: 0 }).code;
  // r9 stays `r9` at baseline (var-naming does not name it), so the only change
  // is r9 -> loopLimit everywhere in the frame, textually.
  assert.ok(before.includes("r9"), "precondition: r9 is a raw register in the baseline render");
  assert.equal(after, before.replace(/\br9\b/g, "loopLimit"));
});

test("frame isolation: naming {fn:0,reg:9} never touches another frame's reg 9 (spec §11.4)", () => {
  // A bundle with several frames that reuse register numbers.
  const svc = service("22-nested-closures-counters");
  const frames = rawFrameBodies(analysisFor("22-nested-closures-counters"));
  const fnIds = [...frames.keys()].sort((a, b) => a - b);
  assert.ok(fnIds.length >= 2, "fixture must have multiple frames");
  const target = fnIds[0]!;
  const other = fnIds[1]!;
  const beforeOther = svc.render({ fn: other }).code;
  // Name every reg 0..15 that is a live binding in `target`.
  let named = 0;
  for (let reg = 0; reg < 16; reg++) {
    const r = svc.setName(regId(target, reg), `t_${reg}`, { confidence: "low", evidence: "", source: "llm", override: true });
    if (r.ok) named++;
  }
  assert.ok(named > 0, "expected at least one nameable register in the target frame");
  const afterOther = svc.render({ fn: other }).code;
  assert.equal(afterOther, beforeOther, "the other frame's render is unchanged");
  assert.equal(svc.getName(regId(other, 0)), null, "the other frame's reg 0 was never named");
});

test("render collision: two names colliding in one frame disambiguate + flag (spec §11.7)", () => {
  const svc = service();
  // r8 = 2 and r9 = 10 are both live single-literal registers in fn0.
  assert.equal(svc.setName(regId(0, 8), "dup", { confidence: "low", evidence: "", source: "llm" }).ok, true);
  assert.equal(svc.setName(regId(0, 9), "dup", { confidence: "low", evidence: "", source: "llm" }).ok, true);
  const out = svc.render({ fn: 0 });
  assert.ok(out.code.includes("dup") && out.code.includes("dup_2"), "one name keeps `dup`, the other is suffixed");
  assert.equal(out.collisions.length, 1);
  assert.equal(out.collisions[0]!.wanted, "dup");
  assert.equal(out.collisions[0]!.rendered, "dup_2");
  // Deterministic: the lower register number wins the bare name.
  assert.equal(out.collisions[0]!.id.reg, 9);
});
