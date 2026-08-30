#!/usr/bin/env node
// docs/TASKS.md T1 / docs/TEST-CORPUS.md §1b — harvests facebook/hermes's MIT
// `test/hermes/*.js` lit tests into tests/sweep/hermes-lit/cases/, converting
// their `// CHECK`/`// CHECK-NEXT`/`// CHECK-LABEL`/`// CHECK-EMPTY` FileCheck
// directives into a plain `expected.txt` of stdout, then *empirically*
// verifying each candidate actually produces that exact output under Node
// with the project's standard `print` shim before writing it out.
//
// This is a bulk *filter*, not a blind importer (see docs/TEST-CORPUS.md §1b's
// caveat: many lit tests check compiler/bytecode-dump output, not runtime
// stdout, and are not convertible at all). The inclusion rule, precisely:
//
//   1. The file has at least one `// RUN:` line that plainly interprets the
//      source with `%hermes` (never `%hermesc`) and pipes to `%FileCheck` —
//      no `-target=HBC` / `-dump-` / `-emit-binary` (those run the compiler's
//      bytecode/AST dump, not the program), no `(! ... )` negative-test
//      wrapper (those assert a *failure*, not stdout), no `-X...` experimental
//      flag (gates non-default Hermes behaviour we cannot promise Node
//      matches), and no `--check-prefix=` (a non-default FileCheck prefix
//      our fixed CHECK-only extraction would silently miss).
//   2. Every `// CHECK...` line in the file is one of the four directives
//      above — CHECK-NOT/CHECK-DAG/CHECK-SAME/CHECK-COUNT encode "absent
//      somewhere"/"unordered"/"same line" semantics that don't fit a linear
//      expected.txt, so a file using them is skipped whole.
//   3. No CHECK line contains a `{{...}}` FileCheck regex (addresses, ids,
//      timings) — those aren't literal text, so no exact expected.txt line
//      can represent them.
//   4. The file never references `HermesInternal` (a Hermes-only global with
//      no Node equivalent; out of scope per docs/TEST-CORPUS.md §1b).
//
// Every syntactic survivor is then *run*: `node` executes the file (RUN/CHECK
// comment lines stripped, `print` shim prepended) and its stdout is diffed
// byte-for-byte against the CHECK-derived expected.txt. Only an exact match
// is written to tests/sweep/hermes-lit/cases/<name>/{source.js,expected.txt}.
// Everything else — syntactic exclusions and empirical mismatches alike — is
// counted and reasoned in the PROVENANCE.md this script (re)generates.
//
// Usage:
//   node tools/harvest-hermes-lit.ts <path-to-hermes-checkout>/test/hermes [--commit <sha>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { join, basename } from "node:path";
import { repoRoot } from "../src/util/paths.ts";

const ROOT = repoRoot();
const OUT_DIR = join(ROOT, "tests/sweep/hermes-lit");
const CASES_DIR = join(OUT_DIR, "cases");
const PRINT_SHIM = "globalThis.print ??= (...a)=>console.log(...a);\n";

const ALLOWED_CHECK_KINDS = new Set(["CHECK", "CHECK-NEXT", "CHECK-LABEL", "CHECK-EMPTY"]);

interface Verdict {
  readonly file: string;
  readonly kept: boolean;
  readonly reason: string;
}

function isEligibleRunLine(line: string): boolean {
  const body = line.replace(/^\/\/\s*RUN:\s*/, "");
  if (/\(\s*!/.test(body)) return false; // negative/expect-failure test
  if (/%hermesc\b/.test(body)) return false; // compile-only invocation
  if (!/%hermes\b/.test(body)) return false;
  if (/-target=HBC|-dump-|-emit-binary/.test(body)) return false; // compiler-diagnostic output, not runtime stdout
  if (/-X[\w-]+/.test(body)) return false; // experimental flag: non-default Hermes behaviour
  if (/check-prefix/i.test(body)) return false; // non-default FileCheck prefix we don't parse
  if (!/FileCheck/.test(body)) return false;
  return true;
}

function classify(src: string): { eligible: boolean; reason: string } {
  const lines = src.split("\n");
  const runLines = lines.filter((l) => /^\/\/\s*RUN:/.test(l.trim()));
  if (runLines.length === 0) return { eligible: false, reason: "no RUN line" };
  if (!runLines.some((l) => isEligibleRunLine(l.trim()))) {
    return { eligible: false, reason: "no plain `%hermes ... | %FileCheck` RUN line (compiler-diagnostic-only, negative test, or experimental flag)" };
  }
  if (/HermesInternal/.test(src)) return { eligible: false, reason: "references HermesInternal (no Node equivalent)" };

  const checkLines = lines.filter((l) => /^\/\/\s*CHECK/.test(l.trim()));
  if (checkLines.length === 0) return { eligible: false, reason: "no CHECK directives to convert" };
  for (const l of checkLines) {
    const m = l.trim().match(/^\/\/\s*(CHECK(?:-[A-Z]+)?):/);
    if (!m || !ALLOWED_CHECK_KINDS.has(m[1]!)) {
      return { eligible: false, reason: `uses unsupported directive (${m ? m[1] : l.trim()}) — not representable as a linear expected.txt` };
    }
  }
  if (checkLines.some((l) => l.includes("{{"))) {
    return { eligible: false, reason: "CHECK line contains a {{...}} FileCheck regex, not literal text" };
  }
  return { eligible: true, reason: "ok" };
}

function deriveExpected(src: string): string {
  const out: string[] = [];
  for (const raw of src.split("\n")) {
    const l = raw.trim();
    const m = l.match(/^\/\/\s*CHECK(-NEXT|-LABEL|-EMPTY)?:\s?(.*)$/);
    if (!m) continue;
    if (m[1] === "-EMPTY") {
      out.push("");
    } else {
      out.push(m[2] ?? "");
    }
  }
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

function stripDirectives(src: string): string {
  return src
    .split("\n")
    .filter((l) => !/^\/\/\s*(RUN|CHECK)/.test(l.trim()))
    .join("\n");
}

function runUnderNode(source: string): { ok: boolean; stdout: string; error?: string } {
  try {
    const stdout = execFileSync(process.execPath, ["--input-type=commonjs", "-"], {
      input: PRINT_SHIM + source,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (e) {
    const err = e as { stdout?: string; message?: string };
    return { ok: false, stdout: err.stdout ?? "", error: err.message ?? String(e) };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const srcDir = args[0];
  if (!srcDir) {
    console.error("usage: node tools/harvest-hermes-lit.ts <path-to-hermes-checkout>/test/hermes [--commit <sha>]");
    process.exit(1);
  }
  const commitIdx = args.indexOf("--commit");
  const commit = commitIdx >= 0 ? args[commitIdx + 1] : undefined;

  const licensePath = join(srcDir, "..", "..", "LICENSE");
  if (!existsSync(licensePath)) {
    console.error(`expected a LICENSE file at ${licensePath} (hermes checkout root) — not found`);
    process.exit(1);
  }
  const licenseSha = createHash("sha256").update(readFileSync(licensePath)).digest("hex");

  const files = readdirSync(srcDir)
    .filter((f) => f.endsWith(".js"))
    .sort();

  rmSync(CASES_DIR, { recursive: true, force: true });
  mkdirSync(CASES_DIR, { recursive: true });

  const verdicts: Verdict[] = [];
  const excludeReasonCounts = new Map<string, number>();

  for (const file of files) {
    const full = join(srcDir, file);
    const src = readFileSync(full, "utf8");
    const { eligible, reason } = classify(src);
    if (!eligible) {
      verdicts.push({ file, kept: false, reason });
      excludeReasonCounts.set(reason, (excludeReasonCounts.get(reason) ?? 0) + 1);
      continue;
    }

    const expected = deriveExpected(src);
    const stripped = stripDirectives(src);
    const result = runUnderNode(stripped);
    if (!result.ok) {
      const reason2 = `syntactically eligible but errored under Node: ${result.error?.split("\n")[0]}`;
      verdicts.push({ file, kept: false, reason: reason2 });
      excludeReasonCounts.set("errored under Node", (excludeReasonCounts.get("errored under Node") ?? 0) + 1);
      continue;
    }
    if (result.stdout !== expected) {
      const reason2 = "syntactically eligible but stdout did not exactly match the CHECK-derived expected.txt";
      verdicts.push({ file, kept: false, reason: reason2 });
      excludeReasonCounts.set("stdout mismatch vs CHECK-derived expected.txt", (excludeReasonCounts.get("stdout mismatch vs CHECK-derived expected.txt") ?? 0) + 1);
      continue;
    }

    const name = basename(file, ".js");
    const dir = join(CASES_DIR, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "source.js"), stripped.endsWith("\n") ? stripped : stripped + "\n");
    writeFileSync(join(dir, "expected.txt"), expected);
    verdicts.push({ file, kept: true, reason: "ok" });
  }

  const kept = verdicts.filter((v) => v.kept);
  const excluded = verdicts.filter((v) => !v.kept);

  copyFileSync(licensePath, join(OUT_DIR, "LICENSE"));

  const provenanceLines: string[] = [];
  provenanceLines.push("<!-- GENERATED by tools/harvest-hermes-lit.ts — DO NOT EDIT -->");
  provenanceLines.push("# tests/sweep/hermes-lit provenance");
  provenanceLines.push("");
  provenanceLines.push("Harvested from facebook/hermes's MIT `test/hermes/*.js` lit tests");
  provenanceLines.push("(docs/TEST-CORPUS.md §1b, docs/DECISIONS.md D13/D16). Hermes itself is");
  provenanceLines.push("MIT and is used as source material here, not as a behaviour oracle read");
  provenanceLines.push("for implementation (that rule is about hermes-dec, which is AGPL — see");
  provenanceLines.push("docs/AGENT-BRIEF.md's hard rules).");
  provenanceLines.push("");
  provenanceLines.push(`- Source: https://github.com/facebook/hermes/tree/${commit ?? "<unrecorded>"}/test/hermes`);
  if (commit) provenanceLines.push(`- Commit: ${commit}`);
  provenanceLines.push(`- LICENSE sha256: ${licenseSha}`);
  provenanceLines.push(`- Top-level \`test/hermes/*.js\` files scanned: ${files.length}`);
  provenanceLines.push(`- Harvested (kept): ${kept.length}`);
  provenanceLines.push(`- Excluded: ${excluded.length}`);
  provenanceLines.push("");
  provenanceLines.push("## Exclusion reasons");
  provenanceLines.push("");
  provenanceLines.push("| Reason | Count |");
  provenanceLines.push("|---|---|");
  for (const [reason, count] of [...excludeReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
    provenanceLines.push(`| ${reason} | ${count} |`);
  }
  provenanceLines.push("");
  provenanceLines.push("## Inclusion rule");
  provenanceLines.push("");
  provenanceLines.push("See the header comment in `tools/harvest-hermes-lit.ts` for the full rule.");
  provenanceLines.push("Short version: a file is harvested only if (1) it has a plain");
  provenanceLines.push("`%hermes ... | %FileCheck` RUN line (not a compiler/bytecode-dump");
  provenanceLines.push("invocation, not a negative/expect-failure test, not gated behind an");
  provenanceLines.push("experimental `-X...` flag), (2) every `// CHECK...` directive it uses is");
  provenanceLines.push("one of `CHECK`/`CHECK-NEXT`/`CHECK-LABEL`/`CHECK-EMPTY` (linear,");
  provenanceLines.push("literal-text semantics — `CHECK-NOT`/`CHECK-DAG`/`CHECK-SAME`/");
  provenanceLines.push("`CHECK-COUNT` and `{{...}}` regexes are not representable as a plain");
  provenanceLines.push("expected.txt), (3) it never touches `HermesInternal`, and (4) running it");
  provenanceLines.push("under Node (RUN/CHECK comments stripped, print shim prepended) produces");
  provenanceLines.push("stdout that **exactly** matches the CHECK-derived expected.txt — this is");
  provenanceLines.push("an empirical filter, not just a syntactic one, so lit tests whose Hermes");
  provenanceLines.push("output differs from Node's (numeric formatting, Symbol/Proxy/property-order");
  provenanceLines.push("edge cases, non-strict-mode divergences) are excluded rather than harvested");
  provenanceLines.push("with a wrong expected.txt.");
  provenanceLines.push("");
  provenanceLines.push("## Excluded files (reason)");
  provenanceLines.push("");
  for (const v of excluded.sort((a, b) => a.file.localeCompare(b.file))) {
    provenanceLines.push(`- \`${v.file}\`: ${v.reason}`);
  }
  provenanceLines.push("");

  writeFileSync(join(OUT_DIR, "PROVENANCE.md"), provenanceLines.join("\n"));

  console.log(`scanned ${files.length}, kept ${kept.length}, excluded ${excluded.length}`);
  for (const [reason, count] of excludeReasonCounts) console.log(`  ${count}\t${reason}`);
}

main();
