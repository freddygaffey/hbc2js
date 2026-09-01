// tools/app-metrics.mjs — "app decompile metrics": decompile a whole real
// React Native app bundle end-to-end, with every M5 readability pass on, and
// score how well it went. Unlike tools/passes-metrics.mjs (a small
// per-construct corpus, on/off comparisons for one pass at a time) this runs
// once, on one large real bundle, the way a user actually invokes `hbc2js`
// (`--lenient-env`, all passes) — so a regression or an improvement in real
// decompile behaviour is visible per commit, not just on the synthetic
// corpus. CI wiring: .github/workflows/ci.yml's `app-metrics` job (ubuntu
// only) runs this on `tests/fixtures/bundles/rn-template-0.72/index.android.hbc`
// and writes the markdown table to $GITHUB_STEP_SUMMARY — see docs/TESTING.md's
// "App metrics" section for the column meanings and how to run this locally.
//
//   node tools/app-metrics.mjs [bundle.hbc] [--json] [--split]
//
// Never fails on metric *values* — only on the tool itself crashing (a bug
// in this script, not in the decompiler under test: an outright decompile
// failure is captured as the headline "decompile" metric instead of thrown,
// by design — see the SCOPE GUARD note in the commit that added this file).
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { decompile, nodeCheck } from "../src/decompile.ts";
import { Hbc2jsError } from "../src/errors.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const DEFAULT_BUNDLE = join(ROOT, "tests", "fixtures", "bundles", "rn-template-0.72", "index.android.hbc");

/** A repo-relative display path so the JSON/markdown report (including the
 *  committed baseline, docs/metrics/app-metrics-baseline.json) doesn't bake
 *  in whichever machine/worktree produced it. */
function displayPath(p) {
  const rel = relative(ROOT, p);
  return rel.startsWith("..") ? p : rel;
}

function parseArgs(argv) {
  let bundle = DEFAULT_BUNDLE;
  let json = false;
  let split = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--split") split = true;
    else if (!a.startsWith("--")) bundle = a;
  }
  return { bundle, json, split };
}

/** Occurrences of `pattern` in `text`, per 1000 lines of `text` (0 lines ->
 *  0, never divide by zero). Mirrors tools/passes-metrics.mjs's convention
 *  of counting textual occurrences on the emitted JS itself — cheap, and the
 *  point here is a readability *signal*, not a semantic AST walk. */
function per1kLines(text, lineCount, pattern) {
  const n = (text.match(pattern) ?? []).length;
  const per1k = lineCount === 0 ? 0 : (n / lineCount) * 1000;
  return { count: n, per1kLines: per1k };
}

function pct(n, total) {
  return total === 0 ? 0 : (n / total) * 100;
}

/** Runs the decompile itself: the one step allowed to "fail" as a *metric*
 *  (an unresolved-env refusal etc. would be a hard error without
 *  --lenient-env, but a corpus of possible surprises is exactly what this
 *  job exists to surface) rather than crash the tool. */
function runDecompile(bundlePath) {
  const bytes = new Uint8Array(readFileSync(bundlePath));
  const t0 = performance.now();
  try {
    const result = decompile(bytes, {
      moduleName: "app",
      strictEnv: false, // --lenient-env
      resolveV98Ambiguity: true,
    });
    const wallMs = performance.now() - t0;
    return { ok: true, wallMs, bytes, result };
  } catch (e) {
    const wallMs = performance.now() - t0;
    const code = e instanceof Hbc2jsError ? e.code : e instanceof Error ? e.constructor.name : "UNKNOWN";
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, wallMs, bytes, error: { code, message } };
  }
}

/** --split + deps classification (D17i stage 1/2): best-effort, skipped
 *  gracefully (not a metrics failure) if either throws — e.g. a bundle
 *  shape `--split`'s Metro-`__d()` scan doesn't recognise. */
async function runSplitAndClassify(bundlePath) {
  try {
    const [{ splitProject }, { runDeps }] = await Promise.all([import("../src/split/index.ts"), import("../src/deps/index.ts")]);
    const bytes = new Uint8Array(readFileSync(bundlePath));
    const split = splitProject(bytes, { moduleName: "app" });
    const deps = await runDeps(bundlePath, { offline: true });
    const summary = deps.classification?.summary ?? null;
    return {
      ok: true,
      moduleCount: split.modules.length,
      fileCount: split.files.size,
      classification:
        summary === null
          ? null
          : {
              libraryModuleCount: summary.libraryModuleCount,
              customModuleCount: summary.customModuleCount,
              unknownModuleCount: summary.unknownModuleCount,
              percentLibraryByWeight: summary.percentLibraryByWeight,
              percentCustomByWeight: summary.percentCustomByWeight,
            },
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function measureApp(bundlePath, opts = {}) {
  if (!existsSync(bundlePath)) {
    throw new Error(`app-metrics: bundle not found: ${bundlePath}`);
  }
  const decompileRun = runDecompile(bundlePath);
  const bundleBytes = decompileRun.bytes.length;

  if (!decompileRun.ok) {
    return {
      bundle: displayPath(bundlePath),
      bundleBytes,
      decompile: { ok: false, wallMs: decompileRun.wallMs, error: decompileRun.error },
    };
  }

  const { result, wallMs } = decompileRun;
  const code = result.code;
  const lineCount = code.length === 0 ? 0 : code.split("\n").length;
  const totalFunctions = result.module.functions.length;
  const stubbed = result.decompileDiagnostics;
  const unresolvedEnv = result.diagnostics.filter((d) => d.code === "W_ENV_UNRESOLVED").length;
  const check = nodeCheck(code);

  const readability = {
    registers: per1kLines(code, lineCount, /\br\d+\b/g),
    reflectApply: per1kLines(code, lineCount, /Reflect\.apply\(/g),
    anonFnNames: per1kLines(code, lineCount, /\b_fn\d+\b/g),
    hbcHelperCalls: per1kLines(code, lineCount, /\b__hbc_\w+\(/g),
  };

  const out = {
    bundle: displayPath(bundlePath),
    bundleBytes,
    decompile: { ok: true, wallMs },
    totalFunctions,
    stubbedFunctions: { count: stubbed, pct: pct(stubbed, totalFunctions) },
    unresolvedEnvMarkers: unresolvedEnv,
    outputBytes: Buffer.byteLength(code),
    lineCount,
    nodeCheck: check.ok ? { ok: true } : { ok: false, message: check.message },
    readability,
    helpersUsed: result.helpersUsed.length,
  };

  if (opts.split === true) {
    out.split = await runSplitAndClassify(bundlePath);
  }

  return out;
}

function fmt(n, digits = 1) {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

function toMarkdown(m) {
  const lines = [];
  lines.push(`# App decompile metrics`);
  lines.push("");
  lines.push(`Bundle: \`${m.bundle}\` (${m.bundleBytes.toLocaleString()} bytes)`);
  lines.push("");
  if (!m.decompile.ok) {
    lines.push(`**decompile: FAILED — ${m.decompile.error.code}**`);
    lines.push("");
    lines.push("```");
    lines.push(m.decompile.error.message.split("\n").slice(0, 20).join("\n"));
    lines.push("```");
    return lines.join("\n") + "\n";
  }
  lines.push(`| metric | value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| decompile | OK (${fmt(m.decompile.wallMs, 0)} ms) |`);
  lines.push(`| total functions | ${m.totalFunctions} |`);
  lines.push(`| stubbed (isolation) | ${m.stubbedFunctions.count} (${fmt(m.stubbedFunctions.pct)}%) |`);
  lines.push(`| unresolved-env markers | ${m.unresolvedEnvMarkers} |`);
  lines.push(`| output bytes | ${m.outputBytes.toLocaleString()} |`);
  lines.push(`| output lines | ${m.lineCount.toLocaleString()} |`);
  lines.push(`| node --check | ${m.nodeCheck.ok ? "OK" : `FAILED — ${m.nodeCheck.message.split("\n")[0]}`} |`);
  lines.push(`| \`rN\` registers / 1k lines | ${m.readability.registers.count} (${fmt(m.readability.registers.per1kLines, 2)}) |`);
  lines.push(`| \`Reflect.apply(\` / 1k lines | ${m.readability.reflectApply.count} (${fmt(m.readability.reflectApply.per1kLines, 2)}) |`);
  lines.push(`| \`_fnN\` names / 1k lines | ${m.readability.anonFnNames.count} (${fmt(m.readability.anonFnNames.per1kLines, 2)}) |`);
  lines.push(`| \`__hbc_\` helper calls / 1k lines | ${m.readability.hbcHelperCalls.count} (${fmt(m.readability.hbcHelperCalls.per1kLines, 2)}) |`);
  if (m.split !== undefined) {
    if (m.split.ok) {
      lines.push(`| split: modules | ${m.split.moduleCount} |`);
      if (m.split.classification !== null) {
        const c = m.split.classification;
        lines.push(`| split: library / custom / unknown modules | ${c.libraryModuleCount} / ${c.customModuleCount} / ${c.unknownModuleCount} |`);
        lines.push(`| split: % library by weight | ${fmt(c.percentLibraryByWeight)}% |`);
        lines.push(`| split: % custom by weight | ${fmt(c.percentCustomByWeight)}% |`);
      }
    } else {
      lines.push(`| split | skipped (${m.split.reason}) |`);
    }
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const { bundle, json, split } = parseArgs(process.argv.slice(2));
  const m = await measureApp(bundle, { split });
  if (json) {
    console.log(JSON.stringify(m, null, 2));
  } else {
    console.log(toMarkdown(m));
  }
  // Exit nonzero only if this tool itself couldn't produce a report at all —
  // a FAILED decompile is a reported metric, not a tool crash (SCOPE GUARD).
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`app-metrics: ${e instanceof Error ? e.stack : String(e)}`);
    process.exitCode = 1;
  });
}
