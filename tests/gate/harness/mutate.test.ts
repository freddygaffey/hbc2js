// docs/specs/06-harness.md §11 item 1 — port of tools/equiv/test/equiv.test.mjs's
// mutation-operator test (part 4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mutants, isCodeMask, syntaxOk, OPERATOR_IDS } from "../../../src/harness/mutate.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { m4Binaries, readBinary } from "../../support/m4.ts";
import { decompile } from "../../../src/decompile.ts";

test("mutation operators never fire inside comments or string literals", () => {
  const src = `// break the loop here\nconst s = 'do not break this';\nfor (;;) { break; }\n`;
  const mask = isCodeMask(src);
  const first = src.indexOf("break"); // in the comment
  const second = src.indexOf("break", first + 1); // in the string
  const third = src.lastIndexOf("break"); // real code
  assert.equal(mask[first], 0);
  assert.equal(mask[second], 0);
  assert.equal(mask[third], 1);
  const ms = mutants(src, 3, 0).filter((m) => m.operator === "break-to-continue");
  for (const m of ms) assert.match(m.text, /\/\/ break the loop here/);
});

test("mutants() only ever returns syntactically valid, distinct-from-source candidates", () => {
  const src = `function f(a, b) {\n  if (a < b) {\n    return a + b;\n  }\n  return a - b;\n}\nprint(f(1, 2));\n`;
  const ms = mutants(src, 8, 0);
  assert.ok(ms.length > 0, "at least one operator should apply to this source");
  for (const m of ms) {
    assert.notEqual(m.text, src);
    assert.equal(syntaxOk(m.text), true, `mutant from ${m.operator} must be syntactically valid`);
    assert.ok(OPERATOR_IDS.includes(m.operator));
  }
});

test("syntaxOk rejects genuinely broken JS", () => {
  assert.equal(syntaxOk("function ("), false);
  assert.equal(syntaxOk("const x = 1;"), true);
});

// review M4, timing win 1: `syntaxOk` stopped spawning `node --check` per
// candidate (~33 s of the gate) and compiles with `vm.Script` instead. Prove
// the two parsers agree on everything the harness actually feeds it — the
// emitted output of every gate binary plus the fixture sources — and pin the
// two documented places `vm.Script` is deliberately stricter.
test("syntaxOk agrees with `node --check` on real candidates and fixture sources", () => {
  const nodeCheckOk = (text: string): boolean => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hbc2js-syntaxok-"));
    const f = path.join(dir, "candidate.js");
    try {
      fs.writeFileSync(f, text);
      execFileSync(process.execPath, ["--check", f], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  const samples: { label: string; text: string }[] = [];
  for (const b of m4Binaries().slice(0, 12)) {
    samples.push({ label: `${b.fixture} v${b.version} (emitted)`, text: decompile(readBinary(b), { resolveV98Ambiguity: true, moduleName: b.fixture }).code });
    const src = path.join(path.dirname(b.path), "source.js");
    if (fs.existsSync(src)) samples.push({ label: `${b.fixture} source.js`, text: fs.readFileSync(src, "utf8") });
  }
  samples.push({ label: "broken", text: "function (" }, { label: "mutant", text: mutants(samples[1]!.text, 1, 0)[0]?.text ?? "const x = 1;" });
  assert.ok(samples.length > 10);
  for (const s of samples) assert.equal(syntaxOk(s.text), nodeCheckOk(s.text), `${s.label}: syntaxOk and node --check disagree`);

  // The two documented, deliberate strictnesses — both reject a program
  // `node --check` accepts, never the reverse.
  assert.equal(nodeCheckOk("return 1;"), true);
  assert.equal(syntaxOk("return 1;"), false, "top-level return: vm.Script has no CommonJS wrapper");
  assert.equal(nodeCheckOk("await 1;"), true);
  assert.equal(syntaxOk("await 1;"), false, "top-level await: vm.Script does not fall back to ESM");
});
