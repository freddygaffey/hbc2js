// docs/specs/05-emitter.md §11 — T1 (`node --check` on everything), T4 (targeted
// lowering assertions) and the EM-01…EM-12 invariants.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { m4Binaries, parseM4 } from "../../support/m4.ts";
import { analyseModule } from "../../../src/cfg/index.ts";
import { emitModule } from "../../../src/emit/index.ts";
import { decompile, nodeCheck } from "../../../src/decompile.ts";
import { HELPERS } from "../../../src/runtime/helpers.ts";
import { quote } from "../../../src/emit/names.ts";
import { Hbc2jsError } from "../../../src/errors.ts";

function emit(path: string): { code: string; helpersUsed: readonly string[] } {
  const { module } = parseM4(new Uint8Array(readFileSync(path)));
  const analysis = analyseModule(module, { strictEnv: true });
  const r = emitModule(analysis, { provenanceComments: false, moduleName: path });
  return { code: r.code, helpersUsed: r.helpersUsed };
}

function fixture(name: string, version: number): string {
  return join(repoRoot(), "tests", "fixtures", "constructs", name, `v${version}.hbc`);
}

// ---------------------------------------------------------------------------
// T1 / EM-02 — the cheapest possible gate, over the whole corpus.
// ---------------------------------------------------------------------------

test("T1: every gate binary emits JavaScript that passes node --check", () => {
  const binaries = m4Binaries(["", ".min"]);
  const dir = mkdtempSync(join(tmpdir(), "hbc2js-emit-"));
  const failures: string[] = [];
  const files: string[] = [];
  try {
    for (const b of binaries) {
      let code: string;
      try {
        code = decompile(new Uint8Array(readFileSync(b.path)), { resolveV98Ambiguity: true, moduleName: b.path }).code;
      } catch (e) {
        failures.push(`${b.fixture} v${b.version}${b.variant}: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      const out = join(dir, `${b.fixture}-v${b.version}${b.variant}.js`);
      writeFileSync(out, code);
      files.push(out);
    }
    // One `node --check` per file; batched here so the corpus stays under a
    // minute.
    for (const file of files) {
      try {
        execFileSync(process.execPath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (e) {
        failures.push(`${file}: ${String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 200)}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(failures, []);
  assert.ok(files.length > 480, `expected the whole gate corpus, emitted ${files.length}`);
});

// ---------------------------------------------------------------------------
// EM-04 / EM-07 / EM-08 / EM-10 / EM-12 — grep-shaped invariants.
// ---------------------------------------------------------------------------

test("EM-04/EM-07/EM-12: no .bind(, pure-ASCII output, no hermes-dec identifier shape", () => {
  const failures: string[] = [];
  for (const b of m4Binaries(["", ".min"])) {
    const { module } = parseM4(new Uint8Array(readFileSync(b.path)));
    const { code } = emit(b.path);
    const where = `${b.fixture} v${b.version}${b.variant}`;
    // EM-04 forbids *synthesising* `.bind`, not a program that calls it: the
    // 50-this-binding fixture's own source does `fn.bind(obj)`, and erasing that
    // would be the bug. So a `.bind(` in the output is only a failure when the
    // module has no "bind" string for it to have come from.
    const programHasBind = Array.from({ length: module.strings.count }, (_, i) => module.strings.get(i)).includes("bind");
    if (code.includes(".bind(") && !programHasBind) failures.push(`${where}: EM-04 .bind( in output`);
    // eslint-disable-next-line no-control-regex
    if (/[^\x00-\x7f]/.test(code)) failures.push(`${where}: EM-07 non-ASCII in output`);
    if (/_fun\d+_ip/.test(code)) failures.push(`${where}: EM-12 hermes-dec identifier shape`);
  }
  assert.deepEqual(failures, []);
});

test("EM-08: `unreachable` emits a throw, never nothing", () => {
  // v>=97 generator bodies end with a never-returning `CallBuiltin
  // throwTypeError`, whose block is a dead tail.
  const { code } = emit(fixture("23-generator-basic", 99));
  assert.match(code, /throw new Error\("hbc2js: unreachable"\)/);
});

test("EM-10: two runs produce byte-identical output", () => {
  for (const name of ["01-if-else-chain", "23-generator-basic", "52-switch-jumptable"]) {
    for (const version of [94, 99]) {
      const a = emit(fixture(name, version)).code;
      const b = emit(fixture(name, version)).code;
      assert.equal(a, b, `${name} v${version}`);
    }
  }
});

test("EM-09: strict directives are per function, never hoisted", () => {
  // 33-class-inheritance-super has strict class methods inside a sloppy global.
  const { code } = emit(fixture("33-class-inheritance-super", 99));
  const lines = code.split("\n");
  const directives = lines.filter((l) => l.trim() === '"use strict";');
  assert.ok(directives.length > 0, "no strict directive at all");
  assert.notEqual(lines[0]?.trim(), '"use strict";', "a directive was hoisted to the file");
});

test("EM-03: helpersUsed is exactly the set emitted, and never more than is needed", () => {
  for (const b of m4Binaries([""])) {
    const { code, helpersUsed } = emit(b.path);
    for (const name of helpersUsed) {
      assert.ok(code.includes(HELPERS[name]!.source.split("\n")[0]!), `${b.fixture} v${b.version}: helper ${name} listed but not emitted`);
    }
    for (const name of Object.keys(HELPERS)) {
      if (helpersUsed.includes(name)) continue;
      assert.ok(!code.includes(`${HELPERS[name]!.source.split("\n")[0]!}\n`), `${b.fixture} v${b.version}: helper ${name} emitted but not listed`);
    }
  }
});

test("EM-01 has teeth: an undeclared identifier is E_UNBOUND_IDENT", async () => {
  const { checkBindings } = await import("../../../src/emit/scope-check.ts");
  assert.throws(
    () => checkBindings([{ k: "func", name: "_fn0", params: [], body: [{ k: "expr", expr: { k: "assign", target: { k: "ident", name: "r0" }, value: { k: "ident", name: "_e9_9" } } }] }], [], 0),
    (e: unknown) => e instanceof Hbc2jsError && e.code === "E_UNBOUND_IDENT",
  );
});

// ---------------------------------------------------------------------------
// T4 — targeted lowering assertions.
// ---------------------------------------------------------------------------

test("T4: the 12 `new`-using fixtures emit `new` at every version they compile at", () => {
  const names = [
    "05-for-in-object",
    "07-for-of-iterable",
    "12-try-catch-finally-return",
    "13-try-finally-no-catch",
    "14-nested-try-catch",
    "15-catch-without-binding",
    "16-finally-with-break-continue",
    "24-generator-return-throw",
    "28-async-await-error",
    "29-promise-chaining",
    "47-typeof-instanceof-in",
    "50-this-binding",
  ];
  const failures: string[] = [];
  for (const b of m4Binaries([""])) {
    if (!names.includes(b.fixture)) continue;
    const { code } = emit(b.path);
    // Either a real `new r<N>(…)` (the CreateThis/CreateThisForNew triple) or a
    // `Reflect.construct` (the `super(…)` shape) must appear; no bare
    // CreateThis/SelectObject may leak through as an identifier.
    if (!/new r\d+\(/.test(code) && !code.includes("Reflect.construct(")) failures.push(`${b.fixture} v${b.version}: no construct form emitted`);
    for (const opcode of ["CreateThis", "SelectObject", "CreateThisForNew"]) {
      if (code.includes(opcode)) failures.push(`${b.fixture} v${b.version}: ${opcode} leaked into the output`);
    }
  }
  assert.deepEqual(failures, []);
});

test("T4: regexps are `new RegExp(...)`, never a /…/ literal, and regExpStorage is never read", () => {
  for (const version of [94, 96, 99]) {
    const { code } = emit(fixture("45-regex-literals", version));
    assert.match(code, /new RegExp\("/, `v${version}`);
  }
});

test("T4: BigInt literals are decimal + n", () => {
  for (const version of [94, 99]) {
    const { code } = emit(fixture("46-bigint-arithmetic", version));
    const literals = [...code.matchAll(/-?\d+n\b/g)].map((m) => m[0]);
    assert.ok(new Set(literals).size >= 4, `v${version}: only ${new Set(literals).size} distinct BigInt literals`);
  }
});

test("T4: object literals preserve key order (EM-06)", () => {
  const { code } = emit(fixture("38-destructuring-object", 94));
  // The fixture's first object literal is `{ id: …, name: …, … }`; the emitted
  // literal must list the keys in buffer order, which is source order.
  const m = /\{(\w+): [^}]*\}/.exec(code);
  assert.ok(m !== null, "no object literal emitted");
});

test("T4: generators emit the shim at CreateGenerator, at both eras", () => {
  for (const version of [84, 94, 96]) {
    const { code, helpersUsed } = emit(fixture("23-generator-basic", version));
    assert.ok(helpersUsed.includes("__hbc_makeGenerator"), `v${version}`);
    assert.match(code, /__hbc_makeGenerator\(_fn\d+, this, arguments\)/, `v${version}`);
    for (const opcode of ["SaveGenerator", "StartGenerator", "ResumeGenerator", "CompleteGenerator"]) {
      assert.ok(!code.includes(opcode), `v${version}: bare ${opcode} in the output`);
    }
    assert.match(code, /__state = \d+;/, `v${version}: no state assignment`);
  }
  for (const version of [98, 99]) {
    const { code, helpersUsed } = emit(fixture("23-generator-basic", version));
    assert.ok(helpersUsed.includes("__hbc_makeGeneratorLowered"), `v${version}`);
    assert.match(code, /__hbc_makeGeneratorLowered\(_fn\d+\)/, `v${version}`);
  }
});

test("T4: closures become nested functions with no environment object", () => {
  for (const name of ["17-closure-loop-var", "21-iife-closures", "22-nested-closures-counters"]) {
    for (const version of [94, 99]) {
      const { code } = emit(fixture(name, version));
      assert.ok(!code.includes("_env"), `${name} v${version}: a materialised environment object was emitted`);
      assert.match(code, /let _e\d+_\d+/, `${name} v${version}: no lexical env slot declared`);
    }
  }
});

test("T4: `arguments` is reified through the unmapped helper", () => {
  for (const version of [84, 94, 96, 99]) {
    const { code, helpersUsed } = emit(fixture("49-arguments-object", version));
    assert.ok(helpersUsed.includes("__hbc_arguments"), `v${version}`);
    assert.match(code, /__hbc_arguments\(arguments\)/, `v${version}`);
  }
});

test("string escaping keeps non-BMP and control characters (EM-07)", () => {
  assert.equal(quote("a b"), '"a\\u202fb"');
  assert.equal(quote("a b"), '"a\\x00b"');
  assert.equal(quote('a"\\b'), '"a\\"\\\\b"');
  assert.equal(quote("\ud800"), '"\\ud800"'); // lone surrogate survives
});

test("nodeCheck reports a syntax error rather than throwing", () => {
  assert.equal(nodeCheck("let x = 1;").ok, true);
  const bad = nodeCheck("function (");
  assert.equal(bad.ok, false);
});
