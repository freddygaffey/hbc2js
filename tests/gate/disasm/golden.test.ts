// docs/specs/02-disassembler.md §7.D — canonical-mode golden snapshots, committed
// as plain text (byte-stable across two runs and across macOS/Linux). Independent
// of the two external oracles: this is what makes an unintended change in *our*
// own format visible in review. `UPDATE_GOLDEN=1` rewrites the committed files,
// matching tests/support/golden.ts's convention (kept independent here since that
// helper is JSON-only).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseHbc } from "../../../src/index.ts";
import { printModule } from "../../../src/disasm/print.ts";
import { listFixtures } from "../../support/fixtures.ts";
import { isKnownAmbiguousV98 } from "../../support/known-issues.ts";
import { repoRoot } from "../../support/paths.ts";

function goldenPath(group: string, name: string, version: number, variant: "" | "public"): string {
  const file = variant === "public" ? `v${version}-public.txt` : `v${version}.txt`;
  return join(repoRoot(), "tests", "golden", "disasm", group, name, file);
}

function render(bytes: Uint8Array, forceTable: "hbc98-late" | undefined, moduleName: string): string {
  const mod = parseHbc(bytes, forceTable !== undefined ? { opcodeTable: forceTable } : undefined);
  const chunks: string[] = [];
  printModule(mod, { write: (s: string): boolean => (chunks.push(s), true) } as NodeJS.WritableStream, { mode: "canonical", moduleName });
  return chunks.join("");
}

test("canonical golden snapshots exist and are byte-stable for every gate (fixture, version)", () => {
  const fixtures = listFixtures();
  let checked = 0;
  for (const f of fixtures) {
    for (const b of f.binaries) {
      const forceTable = isKnownAmbiguousV98(f.group, f.name, b.version) ? "hbc98-late" : undefined;
      const moduleName = `${f.name}/v${b.version}${b.variant === "public" ? "-public" : ""}.hbc`;
      const actual = render(b.bytes(), forceTable, moduleName);
      const second = render(b.bytes(), forceTable, moduleName);
      assert.equal(actual, second, `${f.group}/${f.name} v${b.version}: canonical output not stable across two runs`);

      const path = goldenPath(f.group, f.name, b.version, b.variant);
      if (process.env["UPDATE_GOLDEN"] === "1") {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, actual, "utf8");
      } else {
        assert.ok(existsSync(path), `missing golden file ${path} — run with UPDATE_GOLDEN=1 to create it`);
        const expected = readFileSync(path, "utf8");
        assert.equal(actual, expected, `${f.group}/${f.name} v${b.version}: canonical output diverged from committed golden (${path})`);
      }
      checked++;
    }
  }
  assert.ok(checked > 0);
});
