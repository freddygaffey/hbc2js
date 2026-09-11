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
//     [--limit N] [--backend claude-cli|haiku]
//
// Default backend `claude-cli` (spec 28 section 9.1, Fred's 2026-09-11
// ruling: the CLI on Fred's Claude plan, not the metered API). `--backend
// haiku` opts into the Anthropic API and needs `ANTHROPIC_API_KEY`.
//
// Runs the real backend over every nameable, not-yet-named register in the
// bundle (the same target enumeration `hbc2js name llm-fill` uses) and
// records `cacheKey -> {text, cost}` for each call actually made -- a
// `ReplayBackend` built from the file answers the exact same requests,
// regardless of which backend produced them (same cache-key fields).
import { readFileSync, writeFileSync } from "node:fs";
import { parseForDecompile } from "../../src/decompile.ts";
import { analyseModule } from "../../src/cfg/index.ts";
import { rawFrameBodies } from "../../src/name-overlay/frames.ts";
import { NameService, OverlayStore, regId, shortForm } from "../../src/name-overlay/index.ts";
import { listNameable } from "../../src/artifact/frame-queries.ts";
import { bodyFromContext, canonicaliseContext } from "../../src/workers/backends/haiku.ts";
import { backendForId, resolveBackendId, BackendSelectionError } from "../../src/readability/backends.ts";
import { cacheKey, resolveClaudeCliConfig, resolveHaikuConfig, SKILL_FOR_KIND } from "../../src/readability/types.ts";
import { loadSkill } from "../../src/readability/skills.ts";
import type { Recording, RecordingEntry } from "../../src/workers/backends/replay.ts";

/** Largest per-function source a naming prompt may carry (bytes). */
const MAX_SOURCE_BYTES = 48 * 1024;

function usage(): never {
  process.stderr.write("usage: node tools/readability/record.ts <input.hbc> <output.recording.json> [--limit N] [--backend claude-cli|haiku]\n");
  process.exit(2);
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

  let backendId;
  try {
    backendId = resolveBackendId(backendArg, process.env);
  } catch (e) {
    process.stderr.write(`tools/readability/record.ts: ${e instanceof BackendSelectionError ? e.message : String(e)}\n`);
    process.exit(2);
  }
  if (backendId !== "claude-cli" && backendId !== "haiku") {
    process.stderr.write(`tools/readability/record.ts: --backend must be claude-cli or haiku, got ${backendId}\n`);
    process.exit(2);
  }
  if (backendId === "haiku" && (process.env["ANTHROPIC_API_KEY"] === undefined || process.env["ANTHROPIC_API_KEY"] === "")) {
    process.stderr.write("tools/readability/record.ts: --backend haiku needs ANTHROPIC_API_KEY -- this tool makes real model calls\n");
    process.exit(2);
  }

  const bytes = readFileSync(hbc);
  const analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: false });
  const store = new OverlayStore({ bundle: hbc });
  const service = new NameService(analysis, store, { strictEnv: false });
  const frames = rawFrameBodies(analysis, { strictEnv: false });
  const config = backendId === "claude-cli" ? resolveClaudeCliConfig(process.env) : resolveHaikuConfig(process.env);
  const backend = backendForId(backendId, { env: process.env });

  const recording: Record<string, RecordingEntry> = {};
  let recorded = 0;
  for (let fn = 0; fn < analysis.module.functions.length && recorded < limit; fn++) {
    const nameable = listNameable(frames, fn, store);
    if (nameable.length === 0) continue;
    const source = service.render({ fn }).code;
    // A naming prompt is one function's source. The global wrapper (fn 0)
    // and a few giant module bodies render to megabytes -- the whole program
    // in fn 0's case -- which no naming skill can use and which the claude
    // CLI refuses on stdin above 10 MB. Skip those targets, say so, move on.
    if (source.length > MAX_SOURCE_BYTES) {
      process.stderr.write(`record: skip fn ${fn} (${source.length} bytes of source > ${MAX_SOURCE_BYTES})\n`);
      continue;
    }
    for (const reg of nameable) {
      if (recorded >= limit) break;
      if (reg.named !== null) continue;
      const id = regId(fn, reg.reg);
      const context = { target: shortForm(id), fn, reg: reg.reg, source };
      const skillId = SKILL_FOR_KIND["suggest-name"];
      if (skillId === undefined) continue;
      const skill = loadSkill(skillId, config.skillsDir);
      const key = cacheKey({
        kind: "suggest-name",
        skillId,
        skillVersion: skill.version,
        model: config.model,
        body: bodyFromContext(context),
        context: canonicaliseContext(context),
      });
      // eslint-disable-next-line no-await-in-loop -- sequential by design: one model call at a time, budget-visible.
      const res = await backend.run({ kind: "suggest-name", prompt: "", context });
      recording[key] = { text: res.text, ...(res.cost !== undefined ? { cost: res.cost } : {}) };
      recorded += 1;
      process.stderr.write(`recorded ${String(recorded)}: fn${String(fn)} r${String(reg.reg)}\n`);
    }
  }

  writeFileSync(out, `${JSON.stringify(recording satisfies Recording, null, 2)}\n`);
  process.stderr.write(`wrote ${String(Object.keys(recording).length)} entries to ${out}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`tools/readability/record.ts: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
