// tools/irreducibility.mjs — how much of a .hbc file is genuinely irreducible?
//
//   node --experimental-strip-types tools/irreducibility.mjs <file.hbc> [--all]
//
// Ramsey (D7) structures an irreducible region by duplicating nodes, so
// `duplicatedBlocks` is the objective signal: zero means the CFG was reducible,
// non-zero means it was not and says how much duplication it cost. A function
// that also reports `dispatchVars` fell all the way back to D6's
// `for(;;) switch(ip)` because duplication blew the expansion cap.
//
// Written for T9 (irreducible-CFG stress fixtures, D13a): the point is to test a
// candidate fixture against a real measurement instead of assuming a source
// shape is irreducible. Validated against a positive control — see
// docs/lowering/irreducible-cfg.md.
import { readFileSync } from "node:fs";
import { parseHbc } from "../src/parse/module.ts";
import { analyseModule } from "../src/cfg/index.ts";
import { structure } from "../src/structure/index.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const showAll = args.includes("--all");
if (file === undefined) {
  console.error("usage: node --experimental-strip-types tools/irreducibility.mjs <file.hbc> [--all]");
  process.exit(2);
}

/** `duplicatedBlocks` is a collection, not a count — reading it as a number
 *  silently reports every file as reducible. */
function dupCount(st) {
  const d = st.duplicatedBlocks;
  if (typeof d === "number") return d;
  return d?.length ?? d?.size ?? 0;
}

const mod = parseHbc(new Uint8Array(readFileSync(file)));
const analysis = analyseModule(mod);
const rows = [];
let blocks = 0;
let duplicated = 0;
let skipped = 0;

for (let i = 0; i < mod.functions.length; i++) {
  let cfg;
  try {
    cfg = analysis.cfg(i);
  } catch {
    skipped++;
    continue;
  }
  const st = structure(cfg, { verify: false });
  const dup = dupCount(st);
  const dispatch = (st.dispatchVars ?? []).length;
  blocks += cfg.blocks.length;
  duplicated += dup;
  if (dup > 0 || dispatch > 0 || showAll) {
    const handlers = (analysis.decoded(i).handlers ?? []).length;
    rows.push(
      `  fn#${i} ${JSON.stringify(mod.functions[i].name ?? "")}: blocks=${cfg.blocks.length}` +
        ` duplicated=${dup} dispatchVars=${dispatch} handlers=${handlers}`,
    );
  }
}

const pct = blocks === 0 ? 0 : ((duplicated / blocks) * 100).toFixed(2);
console.log(
  `${file}: ${mod.functions.length} functions, ${blocks} blocks, ` +
    `${duplicated} duplicated (${pct}%)${skipped > 0 ? `, ${skipped} skipped` : ""}`,
);
console.log(rows.length > 0 ? rows.join("\n") : "  -> fully reducible (Ramsey duplicated nothing)");
