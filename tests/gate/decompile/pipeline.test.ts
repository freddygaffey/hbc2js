// The M4 pipeline end to end, and the CLI surface it exposes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { m4Binaries } from "../../support/m4.ts";
import { decompile, decompileTree, nodeCheck, parseForDecompile } from "../../../src/decompile.ts";
import { enabledPasses, REGISTRY } from "../../../src/passes/registry.ts";
import { ErrorCode, Hbc2jsError } from "../../../src/errors.ts";

const CLI = join(repoRoot(), "src", "cli.ts");

function fixture(name: string, file: string): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, file);
}

function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 1 << 26 });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

test("hbc2js <in.hbc> writes JavaScript that passes node --check", () => {
  const r = run([fixture("01-if-else-chain", "v94.hbc")]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\/\/ hbc2js -- decompiled from v94\.hbc/);
  assert.equal(nodeCheck(r.stdout).ok, true);
});

test("hbc2js --emit-tree prints the structurer's tree IR", () => {
  const r = run([fixture("02-while-loop", "v94.hbc"), "--emit-tree", "--function=0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^; fn#0 "global"/);
  assert.match(r.stdout, /loop \{/);
});

test("hbc2js --no-verify still produces the same code for a reducible function", () => {
  const withVerify = run([fixture("01-if-else-chain", "v94.hbc")]);
  const without = run([fixture("01-if-else-chain", "v94.hbc"), "--no-verify"]);
  assert.equal(withVerify.stdout, without.stdout);
});

test("the existing subcommands still work (the decompile command is additive)", () => {
  const info = run(["--info", fixture("01-if-else-chain", "v94.hbc")]);
  assert.equal(info.status, 0, info.stderr);
  assert.match(info.stdout, /version:\s+94/);
  const disasm = run(["disasm", fixture("01-if-else-chain", "v94.hbc")]);
  assert.equal(disasm.status, 0, disasm.stderr);
  assert.match(disasm.stdout, /^; hbc2js disassembly/);
});

test("--force-v98-table resolves the eight documented E_LAYOUT_AMBIGUOUS fixtures", () => {
  const path = fixture("20-let-const-tdz", "v98.hbc");
  assert.throws(
    () => parseForDecompile(new Uint8Array(readFileSync(path))),
    (e: unknown) => e instanceof Hbc2jsError && e.code === ErrorCode.E_LAYOUT_AMBIGUOUS,
  );
  const forced = decompile(new Uint8Array(readFileSync(path)), { resolveV98Ambiguity: true });
  assert.equal(forced.forcedOpcodeTable, true);
  assert.ok(forced.diagnostics.some((d) => d.code === "W_FORCED_OPCODE_TABLE"));
  assert.equal(nodeCheck(forced.code).ok, true);
});

test("every gate binary decompiles with strictEnv and reports no error diagnostics", () => {
  const failures: string[] = [];
  for (const b of m4Binaries(["", ".min"])) {
    try {
      const r = decompile(new Uint8Array(readFileSync(b.path)), { resolveV98Ambiguity: true, moduleName: b.path });
      // W_PASS_ABANDONED (M5): per-site abandonment is D12's designed outcome
      // for a site a rung's `check` refuses, not an error — expr-rebuild's
      // conservative deadness proof legitimately abandons many sites across
      // this corpus (see docs/AGENT-LOG.md's expr-rebuild entry).
      // W_PASS_VERSION_SKIP (F7) is the same kind of designed outcome: a rung
      // whose `versions` predicate excludes this module's bytecode version is
      // reported once per function rather than silently dropped. `yield-recovery`
      // (spec 25, v<=96 only) is the first registered rung that fires it.
      // W_NO_CAPTURE_HOSTED (F24-5) is one summary info line per module: a
      // function that captures nothing and is created in exactly one function
      // is emitted inside that function instead of at module level. It is a
      // placement statement, not a problem -- it exists so the count is
      // observable on a real bundle.
      const unexpected = r.diagnostics.filter((d) => d.code !== "W_NO_CAPTURE_HOSTED" && d.code !== "W_FORCED_OPCODE_TABLE" && d.code !== "W_ORPHAN_FUNCTION" && d.code !== "W_UNUSED_LABEL" && d.code !== "W_EXPANSION_CAP" && d.code !== "W_UNREACHABLE_BLOCK" && d.code !== "W_LOOP_LOCAL_ENV" && d.code !== "W_PASS_ABANDONED" && d.code !== "W_PASS_VERSION_SKIP" && d.code !== "W_PASS_REFUSED");
      if (unexpected.length > 0) failures.push(`${b.fixture} v${b.version}${b.variant}: ${unexpected.map((d) => d.code).join(", ")}`);
    } catch (e) {
      failures.push(`${b.fixture} v${b.version}${b.variant}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test("the pass registry lists the M5 passes in dependency order", () => {
  // Was "empty at M4"; spec 07 §2.3. The ordering/negative tests live in
  // tests/gate/passes/framework.test.ts.
  // D23: structure-recovery rungs all precede the renaming block
  // (`fn-naming`, `reg-split`, `var-naming`); `jsx-recover` is last of the
  // structure block but is opt-in — absent from every `enabledPasses`
  // selection below unless `optIn` names it. `reg-split` is default-on
  // (P-11b resolved by the D23 reorder), so it appears in every selection
  // below.
  assert.deepEqual(REGISTRY.map((p) => p.name), ["loop-cond", "for-header", "for-in", "for-of", "switch-raise", "if-chain", "try-shape", "label-clean", "expr-rebuild", "global-access", "globalthis-dead-store", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain", "object-literal", "yield-recovery", "async-recovery", "arguments-form", "literal-forms", "try-clean", "class-recover", "jsx-recover", "fn-naming", "reg-split", "var-naming"]);
  assert.deepEqual(enabledPasses({ stage: "A" }).map((p) => p.name), ["loop-cond", "for-header", "for-in", "for-of", "switch-raise", "if-chain", "try-shape", "label-clean"]);
  assert.deepEqual(enabledPasses({ skip: ["loop-cond"] }).map((p) => p.name), ["for-header", "for-in", "for-of", "switch-raise", "if-chain", "try-shape", "label-clean", "expr-rebuild", "global-access", "globalthis-dead-store", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain", "object-literal", "yield-recovery", "async-recovery", "arguments-form", "literal-forms", "try-clean", "class-recover", "fn-naming", "reg-split", "var-naming"]);
  assert.deepEqual(enabledPasses({ stage: "B" }).map((p) => p.name), ["expr-rebuild", "global-access", "globalthis-dead-store", "call-shape", "default-params", "destructure", "spread-rest", "template-literal", "optional-chain", "object-literal", "yield-recovery", "async-recovery", "arguments-form", "literal-forms", "try-clean", "class-recover", "fn-naming", "reg-split", "var-naming"]);
});

test("decompileTree covers every function of a module", () => {
  const text = decompileTree(new Uint8Array(readFileSync(fixture("23-generator-basic", "v94.hbc"))));
  for (let i = 0; i < 5; i++) assert.ok(text.includes(`; fn#${i} `), `fn#${i} missing`);
  assert.match(text, /switch b\d+ \(generator-state\)/);
});
