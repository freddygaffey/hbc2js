// tests/fuzz/generator.test.ts — docs/specs/09-fuzzing.md §8 T2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generate } from "../../src/fuzzgen/generate.ts";
import { GRAMMAR_VERSION, BANNED_TOKENS } from "../../src/fuzzgen/grammar.ts";

test("T2(a): determinism — same (seed, grammarVersion) yields byte-identical program text", () => {
  for (const seed of [1, 42, 999, 123456]) {
    assert.equal(generate(seed, GRAMMAR_VERSION), generate(seed, GRAMMAR_VERSION));
  }
});

test("T2(b): 100 consecutive seeds yield at least 95 distinct program texts", () => {
  const texts = new Set<string>();
  for (let seed = 5000; seed < 5100; seed++) texts.add(generate(seed, GRAMMAR_VERSION));
  assert.ok(texts.size >= 95, `only ${texts.size}/100 distinct`);
});

test("T2(c): every generated program passes node --check", () => {
  for (let seed = 6000; seed < 6100; seed++) {
    const src = generate(seed, GRAMMAR_VERSION);
    const r = spawnSync(process.execPath, ["--check"], { input: src, encoding: "utf8" });
    assert.equal(r.status, 0, `seed ${seed} failed --check: ${r.stderr}\n---\n${src}`);
  }
});

test("T2(d): no banned token appears in 100 generated programs", () => {
  for (let seed = 7000; seed < 7100; seed++) {
    const src = generate(seed, GRAMMAR_VERSION);
    for (const tok of BANNED_TOKENS) {
      assert.ok(!src.includes(tok), `seed ${seed} contains banned token ${JSON.stringify(tok)}`);
    }
  }
});
