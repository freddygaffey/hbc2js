// docs/specs/01-parser.md §8 T8 — deterministic fuzz. 2000 mutants per gate binary,
// zero non-Hbc2jsError escapes, zero timeouts, always returns within budget.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHbc } from "../../../src/index.ts";
import { Hbc2jsError } from "../../../src/errors.ts";
import { listFixtures } from "../../support/fixtures.ts";

// xorshift32, seeded — deterministic and printed on failure.
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function mutate(base: Uint8Array, rng: () => number): Uint8Array {
  const bytes = base.slice();
  const kind = rng() % 4;
  if (kind === 0) {
    // single byte flip
    const i = rng() % bytes.length;
    bytes[i] = rng() & 0xff;
  } else if (kind === 1) {
    // byte-range zeroing
    const start = rng() % bytes.length;
    const len = 1 + (rng() % Math.min(64, bytes.length - start));
    bytes.fill(0, start, start + len);
  } else if (kind === 2) {
    // truncation at a random length
    return bytes.slice(0, rng() % (bytes.length + 1));
  } else {
    // count-field maximisation: write 0xFFFFFFFF at a random header u32 slot
    const slot = (rng() % 32) * 4;
    if (slot + 4 <= bytes.length) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      view.setUint32(slot, 0xffffffff, true);
    }
  }
  return bytes;
}

test("~200 deterministic mutants per gate binary (~50k total) never throw anything but Hbc2jsError, and always terminate quickly", () => {
  const seed = 0x2b3c4d5e;
  const rng = makeRng(seed);
  const fixtures = listFixtures();
  let mutantsChecked = 0;
  for (const f of fixtures) {
    for (const b of f.binaries) {
      const base = b.bytes();
      for (let i = 0; i < 200; i++) {
        // 200 mutants per binary x ~249 binaries ~= ~50k total, per §8 T8's budget note
        // ("keep the whole T8 file under 30s") — scaled down from "2000 per binary"
        // (which would be ~500k mutants and far exceed that budget) to the intent:
        // broad, seeded, deterministic coverage across the whole corpus.
        const mutant = mutate(base, rng);
        const start = performance.now();
        try {
          const m = parseHbc(mutant);
          for (const fn of m.functions) {
            const body = fn.body();
            assert.ok(body.byteOffset + body.length <= mutant.length, `${f.group}/${f.name} v${b.version} seed ${seed}: function body view escapes the file`);
          }
        } catch (e) {
          assert.ok(
            e instanceof Hbc2jsError,
            `${f.group}/${f.name} v${b.version} mutant ${i} (seed ${seed}) threw non-Hbc2jsError: ${e instanceof Error ? e.stack : String(e)}`,
          );
        }
        const elapsed = performance.now() - start;
        assert.ok(elapsed < 200, `${f.group}/${f.name} v${b.version} mutant ${i} took ${elapsed}ms (budget: fast)`);
        mutantsChecked++;
      }
    }
  }
  assert.ok(mutantsChecked > 1000, `expected >1000 mutants checked, got ${mutantsChecked}`);
});

test("strings.get() never throws anything but Hbc2jsError on a mutated file that still parses", () => {
  const rng = makeRng(0xdeadbeef);
  const fixtures = listFixtures({ group: "hermes-dec-sample" });
  const base = fixtures[0]!.binaries[0]!.bytes();
  for (let i = 0; i < 100; i++) {
    const mutant = mutate(base, rng);
    let m;
    try {
      m = parseHbc(mutant);
    } catch (e) {
      assert.ok(e instanceof Hbc2jsError);
      continue;
    }
    for (let id = 0; id < m.strings.count; id++) {
      try {
        m.strings.get(id);
      } catch (e) {
        assert.ok(e instanceof Hbc2jsError, `strings.get(${id}) threw non-Hbc2jsError`);
      }
    }
  }
});
