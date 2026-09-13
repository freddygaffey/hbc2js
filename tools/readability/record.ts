#!/usr/bin/env node
// tools/readability/record.ts -- spec 28 landing 1: produce the committed
// recording (`tests/fixtures/llm-readability/<app>.recording.json`) a
// `ReplayBackend` answers from, so the gate's coverage/quality legs can run
// against the held-out app without a live model in CI. This tool itself
// calls a real model and is NEVER run by the gate -- it is the one place
// outside `src/workers/backends/{claude-cli,haiku}.ts` that does, by design.
//
// Usage:
//   node tools/readability/record.ts <input.hbc> <output.recording.json> \
//     [--limit N] [--backend claude-cli|haiku|fake] [--only src] \
//     [--sample N [--seed S]] [--resume] [--per-register]
//
// Default: ONE backend call per FUNCTION (spec 28 section 9.1, "one model
// call per function, not per register") -- the request's `context.targets`
// lists every nameable `{fn,reg}` in that function and the reply's `names[]`
// is expected to answer as many of them as it has evidence for. `--limit`
// and the progress line both count FUNCTIONS in this mode. `--per-register`
// reverts to landing 1's original shape (one call per `{fn,reg}`), which
// `--limit`/progress then count as before.
//
// Default backend `claude-cli` (spec 28 section 9.1, Fred's 2026-09-11
// ruling: the CLI on Fred's Claude plan, not the metered API). `--backend
// haiku` opts into the Anthropic API and needs `ANTHROPIC_API_KEY`.
// `--backend fake` makes no real calls at all -- for a dry-run selection
// count (see `--limit 0` below) or a test harness.
//
// `--only src` (default off, spec 28 section 7): restrict targets to
// functions belonging to modules `src/readability/scope.ts`'s classifier
// (the same `splitProject` -> `segregateSplitTree` path `hbc2js segregate`
// uses) buckets as `src` app code, not `node_modules`/`unclassified`. Prints
// the selected module/function counts to stderr BEFORE the first model call.
//
// `--sample N [--seed S]` (default seed 1): a deterministic reservoir sample
// of N targets from the selected set (after `--only`), for a bounded,
// reproducible smoke run -- same seed, same targets, every time; a
// different seed samples independently.
//
// `--resume`: if the output recording already exists, any target whose
// cache key is already a key in it is answered from the existing file with
// zero backend calls (counted as a cache hit in the final aggregate) --
// lets a rate-limited run continue without re-spending tokens.
//
// Runs the real backend over every nameable, not-yet-named register in the
// selected scope (the same target enumeration `hbc2js name llm-fill` uses,
// modulo `--only`/`--sample`) and records `cacheKey -> {text, cost}` for
// each call actually made -- a `ReplayBackend` built from the file answers
// the exact same requests, regardless of which backend produced them (same
// cache-key fields).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decompileFunction, parseForDecompile } from "../../src/decompile.ts";
import { analyseModule } from "../../src/cfg/index.ts";
import { rawFrameBodies } from "../../src/name-overlay/frames.ts";
import { OverlayStore, bindingKey, regId, shortForm } from "../../src/name-overlay/index.ts";
import { listNameable } from "../../src/artifact/frame-queries.ts";
import { bodyFromContext, canonicaliseContext } from "../../src/workers/backends/haiku.ts";
import { backendForId, resolveBackendId, BackendSelectionError } from "../../src/readability/backends.ts";
import { cacheKey, parseReadabilityResult, resolveClaudeCliConfig, resolveHaikuConfig, SKILL_FOR_KIND } from "../../src/readability/types.ts";
import { loadSkill } from "../../src/readability/skills.ts";
import { computeSrcScope } from "../../src/readability/scope.ts";
import { loadRecording } from "../../src/workers/backends/replay.ts";
import type { ModuleAnalysis } from "../../src/cfg/types.ts";
import type { Stmt } from "../../src/emit/ast.ts";
import type { Recording, RecordingEntry } from "../../src/workers/backends/replay.ts";

/** Largest per-function source a naming prompt may carry (bytes). */
const MAX_SOURCE_BYTES = 48 * 1024;

/** `--sample`'s default `--seed`, so an un-seeded `--sample N` is still
 *  reproducible across runs (not "pick a random seed each time"). */
const DEFAULT_SAMPLE_SEED = 1;

function usage(): never {
  process.stderr.write(
    "usage: node tools/readability/record.ts <input.hbc> <output.recording.json> " +
      "[--limit N] [--backend claude-cli|haiku|fake] [--only src] [--sample N [--seed S]] [--resume] [--per-register]\n",
  );
  process.exit(2);
}

/** One `{fn,reg}` candidate: a not-yet-named nameable register in a function
 *  short enough to prompt on. Enumeration order is deterministic (ascending
 *  `fn`, then ascending `reg`) so `--sample`'s reservoir sampling is
 *  reproducible given the same bundle + scope. */
export interface Target {
  readonly fn: number;
  readonly reg: number;
}

/** Every nameable, unnamed `{fn,reg}` in `allowedFns` (or the whole bundle
 *  when `allowedFns` is `null`), in enumeration order. Deliberately does NOT
 *  render any function's source -- `NameService.render({fn})` re-emits the
 *  WHOLE module to answer a single function's text (`src/name-overlay/
 *  render.ts`'s `render()`: one `emitModule` pass over every function in the
 *  bundle, then a slice), so calling it once per candidate function here
 *  would make this enumeration itself cost O(candidates * bundle size) --
 *  exactly the unbounded cost `--only`/`--sample` exist to avoid. Callers
 *  that need a target's source (the actual per-target loop) render it lazily
 *  and only for the targets they actually process (`renderTargetSource`
 *  below); a function whose source turns out to be oversized is skipped
 *  there, not here. Pure -- makes no model call and no `render()` call, so
 *  it is safe to run for a dry-run count or inside a test even over the
 *  whole bundle. */
export function collectTargets(
  analysis: ModuleAnalysis,
  frames: ReadonlyMap<number, readonly Stmt[]>,
  store: OverlayStore,
  allowedFns: ReadonlySet<number> | null,
): readonly Target[] {
  const targets: Target[] = [];
  for (let fn = 0; fn < analysis.module.functions.length; fn++) {
    if (allowedFns !== null && !allowedFns.has(fn)) continue;
    const nameable = listNameable(frames, fn, store);
    if (nameable.length === 0) continue;
    for (const reg of nameable) {
      if (reg.named !== null) continue;
      targets.push({ fn, reg: reg.reg });
    }
  }
  return targets;
}

/** Renders `fn`'s source (memoized in `cache`, so a function with several
 *  targets is only ever rendered once) and applies the same size backstop
 *  the tool always applied: a naming prompt is one function's source, and
 *  the global wrapper (fn 0) or a giant module body can render to megabytes
 *  -- the whole program in fn 0's case -- which no naming skill can use and
 *  which the claude CLI refuses on stdin above 10 MB. Returns `null` (and
 *  writes why to `diagnostics`) rather than that oversized source. */
export function renderTargetSource(fn: number, render: (fn: number) => string, cache: Map<number, string>, diagnostics: string[] = []): string | null {
  let source = cache.get(fn);
  if (source === undefined) {
    source = render(fn);
    cache.set(fn, source);
  }
  if (source.length > MAX_SOURCE_BYTES) {
    diagnostics.push(`record: skip fn ${fn} (${source.length} bytes of source > ${MAX_SOURCE_BYTES})`);
    return null;
  }
  return source;
}

/** Deterministic seeded PRNG (mulberry32) -- small, dependency-free, stable
 *  across Node versions (unlike `Math.random`, which `--sample` cannot use
 *  and stay reproducible). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function next(): number {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reservoir sampling (algorithm R): `n` items chosen uniformly from
 *  `items` in one pass, deterministic given `items`' order and `seed` --
 *  same seed always samples the same targets from the same population;
 *  different seeds sample independently (not guaranteed disjoint in
 *  general, but overwhelmingly so for a small `n` over a large population,
 *  which is `--sample`'s intended use). `n >= items.length` returns every
 *  item, in original order. */
export function seededSample<T>(items: readonly T[], n: number, seed: number): T[] {
  if (n >= items.length) return items.slice();
  const rng = mulberry32(seed);
  const reservoir = items.slice(0, n);
  for (let i = n; i < items.length; i++) {
    const j = Math.floor(rng() * (i + 1));
    if (j < n) reservoir[j] = items[i]!;
  }
  return reservoir;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hbc = argv[0];
  const out = argv[1];
  if (hbc === undefined || out === undefined) usage();
  const limitFlag = argv.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : Number.POSITIVE_INFINITY;
  const backendFlag = argv.indexOf("--backend");
  const backendArg = backendFlag >= 0 ? argv[backendFlag + 1] : undefined;
  const onlyFlag = argv.indexOf("--only");
  const onlyArg = onlyFlag >= 0 ? argv[onlyFlag + 1] : undefined;
  if (onlyArg !== undefined && onlyArg !== "src") {
    process.stderr.write(`tools/readability/record.ts: --only must be "src", got ${onlyArg}\n`);
    process.exit(2);
  }
  const sampleFlag = argv.indexOf("--sample");
  const sample = sampleFlag >= 0 ? Number(argv[sampleFlag + 1]) : null;
  const seedFlag = argv.indexOf("--seed");
  const seed = seedFlag >= 0 ? Number(argv[seedFlag + 1]) : DEFAULT_SAMPLE_SEED;
  const resume = argv.includes("--resume");
  const perRegister = argv.includes("--per-register");

  let backendId;
  try {
    backendId = resolveBackendId(backendArg, process.env);
  } catch (e) {
    process.stderr.write(`tools/readability/record.ts: ${e instanceof BackendSelectionError ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (backendId !== "claude-cli" && backendId !== "haiku" && backendId !== "fake") {
    process.stderr.write(`tools/readability/record.ts: --backend must be claude-cli, haiku or fake, got ${backendId}\n`);
    process.exit(2);
  }
  if (backendId === "haiku" && (process.env["ANTHROPIC_API_KEY"] === undefined || process.env["ANTHROPIC_API_KEY"] === "")) {
    process.stderr.write("tools/readability/record.ts: --backend haiku needs ANTHROPIC_API_KEY -- this tool makes real model calls\n");
    process.exit(2);
  }

  const bytes = readFileSync(hbc);
  let analysis: ModuleAnalysis;
  let srcFns: ReadonlySet<number> | null = null;
  if (onlyArg === "src") {
    const scope = await computeSrcScope(hbc, bytes);
    analysis = scope.analysis;
    srcFns = scope.srcFns;
    process.stderr.write(
      `record: --only src selected ${String(scope.srcModuleCount)}/${String(scope.totalModuleCount)} module(s)\n`,
    );
  } else {
    analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: false });
  }
  const store = new OverlayStore({ bundle: hbc });
  const frames = rawFrameBodies(analysis, { strictEnv: false });
  const config = backendId === "claude-cli" ? resolveClaudeCliConfig(process.env) : resolveHaikuConfig(process.env);
  const backend = backendForId(backendId, { env: process.env });
  // Scoped single-function render (docs/DECISIONS.md D-scoped-render) --
  // NEVER `NameService.render({fn})` here (BUGS 2026-09-11 "render() is
  // O(whole-bundle) per call"): that re-emits every function in the bundle
  // to answer one function's source. `decompileFunction` costs the parse +
  // module analysis (paid once by `analysis` above, re-derived internally
  // per call since `decompile()` always re-parses `bytes`) plus that
  // function's own closure subtree -- proportional to the requested
  // function, never to the bundle's total function count.
  const renderFn = (fn: number): string => decompileFunction(bytes, fn, { strictEnv: false }).code;

  // Cheap: no `render()` call anywhere in `collectTargets` (see its own
  // comment) -- safe to run over the WHOLE selected scope before any model
  // call or `--sample`, even on the ~15k-function held-out bundle.
  let allTargets = collectTargets(analysis, frames, store, srcFns);
  const selectedFns = new Set(allTargets.map((t) => t.fn));
  process.stderr.write(
    `record: ${String(allTargets.length)} target(s) across ${String(selectedFns.size)} function(s) selected\n`,
  );

  if (sample !== null) {
    allTargets = seededSample(allTargets, sample, seed);
    process.stderr.write(`record: --sample ${String(sample)} --seed ${String(seed)} -> ${String(allTargets.length)} target(s)\n`);
  }

  const existing: Recording = resume && existsSync(out) ? loadRecording(out) : {};
  const recording: Record<string, RecordingEntry> = { ...existing };

  const sourceCache = new Map<number, string>();
  const diagnostics: string[] = [];
  let recorded = 0;
  let calls = 0;
  let cacheHits = 0;
  let tokensInTotal = 0;
  let tokensOutTotal = 0;
  const startedAt = Date.now();
  const skillId = SKILL_FOR_KIND["suggest-name"];
  if (skillId === undefined) throw new Error("record.ts: no skill routed for suggest-name");
  const skill = loadSkill(skillId, config.skillsDir);

  if (perRegister) {
    // Landing-1 shape: one call per `{fn,reg}` -- kept for `--per-register`.
    const total = Math.min(allTargets.length, limit);
    for (const target of allTargets) {
      if (recorded >= limit) break;
      const { fn, reg } = target;
      const source = renderTargetSource(fn, renderFn, sourceCache, diagnostics);
      if (source === null) {
        process.stderr.write(`${diagnostics[diagnostics.length - 1]!}\n`);
        continue;
      }
      const id = regId(fn, reg);
      const context = { target: shortForm(id), fn, reg, source };
      const key = cacheKey({
        kind: "suggest-name",
        skillId,
        skillVersion: skill.version,
        model: config.model,
        body: bodyFromContext(context),
        context: canonicaliseContext(context),
      });
      recorded += 1;
      if (resume && Object.prototype.hasOwnProperty.call(existing, key)) {
        cacheHits += 1;
        const cachedTokens = existing[key]?.cost;
        tokensInTotal += cachedTokens?.tokensIn ?? 0;
        tokensOutTotal += cachedTokens?.tokensOut ?? 0;
        process.stderr.write(`recorded ${String(recorded)}/${String(total)}: fn${String(fn)} r${String(reg)} (cached)\n`);
        continue;
      }
      const callStart = Date.now();
      // eslint-disable-next-line no-await-in-loop -- sequential by design: one model call at a time, budget-visible.
      const res = await backend.run({ kind: "suggest-name", prompt: "", context });
      const callSeconds = (Date.now() - callStart) / 1000;
      recording[key] = { text: res.text, ...(res.cost !== undefined ? { cost: res.cost } : {}) };
      calls += 1;
      const tokensIn = res.cost?.tokensIn ?? 0;
      const tokensOut = res.cost?.tokensOut ?? 0;
      tokensInTotal += tokensIn;
      tokensOutTotal += tokensOut;
      process.stderr.write(
        `recorded ${String(recorded)}/${String(total)}: fn${String(fn)} r${String(reg)} (${String(tokensIn)}/${String(tokensOut)} tok, ${callSeconds.toFixed(1)}s)\n`,
      );
    }
  } else {
    // Default: one call per FUNCTION (spec 28 section 9.1). `allTargets` is
    // already in ascending-fn order (`collectTargets`'s own contract), so
    // grouping by `fn` here preserves that order without a re-sort.
    const byFn = new Map<number, Target[]>();
    for (const t of allTargets) {
      const list = byFn.get(t.fn);
      if (list === undefined) byFn.set(t.fn, [t]);
      else list.push(t);
    }
    const fns = [...byFn.keys()];
    const total = Math.min(fns.length, limit);
    for (const fn of fns) {
      if (recorded >= limit) break;
      const regs = byFn.get(fn)!;
      const source = renderTargetSource(fn, renderFn, sourceCache, diagnostics);
      if (source === null) {
        process.stderr.write(`${diagnostics[diagnostics.length - 1]!}\n`);
        continue;
      }
      const ids = regs.map((r) => regId(fn, r.reg));
      const context = { fn, targets: ids.map((id) => shortForm(id)), source };
      const key = cacheKey({
        kind: "suggest-name",
        skillId,
        skillVersion: skill.version,
        model: config.model,
        body: bodyFromContext(context),
        context: canonicaliseContext(context),
      });
      recorded += 1;
      if (resume && Object.prototype.hasOwnProperty.call(existing, key)) {
        cacheHits += 1;
        const cachedTokens = existing[key]?.cost;
        tokensInTotal += cachedTokens?.tokensIn ?? 0;
        tokensOutTotal += cachedTokens?.tokensOut ?? 0;
        process.stderr.write(`recorded ${String(recorded)}/${String(total)}: fn${String(fn)} (${String(regs.length)} regs, cached)\n`);
        continue;
      }
      const callStart = Date.now();
      // eslint-disable-next-line no-await-in-loop -- sequential by design: one model call at a time, budget-visible.
      const res = await backend.run({ kind: "suggest-name", prompt: "", context });
      const callSeconds = (Date.now() - callStart) / 1000;
      recording[key] = { text: res.text, ...(res.cost !== undefined ? { cost: res.cost } : {}) };
      calls += 1;
      const tokensIn = res.cost?.tokensIn ?? 0;
      const tokensOut = res.cost?.tokensOut ?? 0;
      tokensInTotal += tokensIn;
      tokensOutTotal += tokensOut;
      const parsed = parseReadabilityResult(res.text);
      const requested = new Set(ids.map((id) => bindingKey(id)));
      const named = parsed.ok ? parsed.result.names.filter((n) => requested.has(bindingKey(n.bindingId))).length : 0;
      process.stderr.write(
        `fn ${String(fn)}: ${String(named)} regs named / ${String(regs.length)} requested ` +
          `(${String(tokensIn)}/${String(tokensOut)} tok, ${callSeconds.toFixed(1)}s)\n`,
      );
    }
  }

  const totalSeconds = (Date.now() - startedAt) / 1000;
  writeFileSync(out, `${JSON.stringify(recording satisfies Recording, null, 2)}\n`);
  process.stderr.write(`wrote ${String(Object.keys(recording).length)} entries to ${out}\n`);
  process.stderr.write(
    `record: ${String(recorded)} target(s), ${String(calls)} call(s), ${String(tokensInTotal)}/${String(tokensOutTotal)} tok in/out, ` +
      `${totalSeconds.toFixed(1)}s, ${String(cacheHits)} cache hit(s)\n`,
  );
}

// Only run when executed directly (`node tools/readability/record.ts ...`),
// not when imported for its pure exports (`collectTargets`, `seededSample`,
// `mulberry32`) -- tests/gate/llm-readability/record-scope.test.ts imports
// this file as a module and must not trigger a CLI run (and its `usage()`
// `process.exit`) as a side effect.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    process.stderr.write(`tools/readability/record.ts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
