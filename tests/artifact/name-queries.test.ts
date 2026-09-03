// tests/artifact/name-queries.test.ts — A7 (docs/specs/10-artifact-format.md
// §7): `name list <fn>` / `name context <fn> <reg>` truth. On a construct
// fixture: `list` returns exactly the registers the gate considers nameable —
// never a register the gate refuses with `no-binding` (the QUEUE's wasted
// `{0,9}` probe class never appears); `context`'s site count equals an
// independent AST recount of that register's def/use sites.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { parseHbc } from "../../src/parse/module.ts";
import { analyseModule } from "../../src/cfg/index.ts";
import { rawFrameBodies } from "../../src/name-overlay/frames.ts";
import { gateForFrame } from "../../src/name-overlay/gate.ts";
import { regId } from "../../src/name-overlay/id.ts";
import { registerUses, isRegisterName } from "../../src/passes/ast.ts";
import { listNameable, contextSites } from "../../src/artifact/frame-queries.ts";

const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");
const bytes = readFileSync(FIXTURE_HBC);
const module = parseHbc(bytes);
const analysis = analyseModule(module, { strictEnv: true });
const frames = rawFrameBodies(analysis);

test("A7 name list: every listed register passed the gate's no-binding refusal (never a wasted {0,9}-class probe)", () => {
  let checkedAnyFn = 0;
  for (const [fn, body] of frames) {
    const uses = registerUses(body);
    const allRegs = new Set<number>();
    for (const name of uses.keys()) if (isRegisterName(name)) allRegs.add(Number(name.slice(1)));
    if (allRegs.size === 0) continue;
    checkedAnyFn++;

    const listed = listNameable(frames, fn);
    const listedRegs = new Set(listed.map((r) => r.reg));

    // Independent recount: directly gate every register this frame's own
    // registerUses walk found, and confirm `list` agrees exactly — never
    // includes a `no-binding` register, never omits a non-`no-binding` one.
    for (const reg of allRegs) {
      const verdict = gateForFrame(body, regId(fn, reg), "x", false);
      const shouldBeListed = !(!verdict.ok && verdict.reason === "no-binding");
      assert.equal(listedRegs.has(reg), shouldBeListed, `fn ${fn} reg ${reg}: gate ${verdict.ok ? "ok" : verdict.reason} but listed=${listedRegs.has(reg)}`);
    }
    // Every listed row's own `uses` count matches the same registerUses tally
    // `list` derived it from.
    for (const row of listed) {
      const u = uses.get(`r${row.reg}`);
      assert.equal(row.uses, (u?.reads ?? 0) + (u?.writes ?? 0));
    }
  }
  assert.ok(checkedAnyFn > 0, "fixture must have at least one function with register uses to check");
});

test("A7 name context: site count equals an independent AST recount of that register's def/use sites", () => {
  let checkedAnySite = false;
  for (const [fn, body] of frames) {
    const uses = registerUses(body);
    for (const name of uses.keys()) {
      if (!isRegisterName(name)) continue;
      const reg = Number(name.slice(1));
      const sites = contextSites(frames, fn, reg);
      const u = uses.get(name)!;
      const expected = u.reads + u.writes;
      if (expected === 0) continue;
      checkedAnySite = true;
      // contextSites IS the independent recount (kept deliberately separate
      // from registerUses's counting traversal, per its own doc comment) —
      // assert the two independent walks agree on the total site count.
      assert.equal(sites.length, expected, `fn ${fn} reg ${reg}: context sites ${sites.length} != registerUses count ${expected}`);
    }
  }
  assert.ok(checkedAnySite, "fixture must have at least one register with def/use sites to check");
});
