#!/usr/bin/env node
// tools/readability/record.ts -- spec 28 landing 1: produce the committed
// recording (`tests/fixtures/llm-readability/<app>.recording.json`) a
// `ReplayBackend` answers from, so the gate's coverage/quality legs can run
// against the held-out app without `ANTHROPIC_API_KEY` in CI. This tool
// itself needs `ANTHROPIC_API_KEY` and is NEVER run by the gate -- it is
// the one place outside `HaikuBackend` that calls the real model, by design.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node tools/readability/record.ts \
//     <input.hbc> <output.recording.json> [--limit N]
//
// Runs the real `HaikuBackend` over every nameable, not-yet-named register in
// the bundle (the same target enumeration `hbc2js name llm-fill` uses) and
// records `cacheKey -> {text, cost}` for each call actually made -- a
// `ReplayBackend` built from the file answers the exact same requests.
import { readFileSync, writeFileSync } from "node:fs";
import { parseForDecompile } from "../../src/decompile.ts";
import { analyseModule } from "../../src/cfg/index.ts";
import { rawFrameBodies } from "../../src/name-overlay/frames.ts";
import { NameService, OverlayStore, regId, shortForm } from "../../src/name-overlay/index.ts";
import { listNameable } from "../../src/artifact/frame-queries.ts";
import { HaikuBackend } from "../../src/workers/backends/haiku.ts";
import { bodyFromContext, canonicaliseContext } from "../../src/workers/backends/haiku.ts";
import { cacheKey, resolveHaikuConfig, SKILL_FOR_KIND } from "../../src/readability/types.ts";
import { loadSkill } from "../../src/readability/skills.ts";
import type { Recording, RecordingEntry } from "../../src/workers/backends/replay.ts";

function usage(): never {
  process.stderr.write("usage: ANTHROPIC_API_KEY=... node tools/readability/record.ts <input.hbc> <output.recording.json> [--limit N]\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hbc = argv[0];
  const out = argv[1];
  if (hbc === undefined || out === undefined) usage();
  const limitFlag = argv.indexOf("--limit");
  const limit = limitFlag >= 0 ? Number(argv[limitFlag + 1]) : Number.POSITIVE_INFINITY;

  if (process.env["ANTHROPIC_API_KEY"] === undefined || process.env["ANTHROPIC_API_KEY"] === "") {
    process.stderr.write("tools/readability/record.ts: ANTHROPIC_API_KEY must be set -- this tool makes real model calls\n");
    process.exit(2);
  }

  const bytes = readFileSync(hbc);
  const analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: false });
  const store = new OverlayStore({ bundle: hbc });
  const service = new NameService(analysis, store, { strictEnv: false });
  const frames = rawFrameBodies(analysis, { strictEnv: false });
  const config = resolveHaikuConfig(process.env);
  const backend = new HaikuBackend(config);

  const recording: Record<string, RecordingEntry> = {};
  let recorded = 0;
  for (let fn = 0; fn < analysis.module.functions.length && recorded < limit; fn++) {
    const nameable = listNameable(frames, fn, store);
    if (nameable.length === 0) continue;
    const source = service.render({ fn }).code;
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
