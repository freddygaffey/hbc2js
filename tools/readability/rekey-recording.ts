#!/usr/bin/env node
// tools/readability/rekey-recording.ts -- docs/PUSHBACK.md P-57: recompute
// every key of a committed `ReplayBackend` recording after a skill file's
// `version` changes (a `cacheKey` bump, spec 28 section 9.3 -- `skill=
// ${skillId}@${skillVersion}` is part of the key, so ANY version bump makes
// every existing key stale).
//
// This is NOT a network call and never touches a model: the recording is
// already a pure function of the request each entry answers (spec 28
// section 9.3's whole point -- the same request always maps to the same
// key), so re-keying only needs to recover WHICH request each entry
// answers and recompute the key for it under the current skill.
//
// For `tests/fixtures/llm-readability/synthetic.recording.json` specifically,
// every entry's own `text` echoes the `{fn,reg}` binding it was asked about
// (`names[0].bindingId` or `rewrite.fn`), and `tests/workers/backends.test.ts`
// builds exactly one request shape from a `{fn,reg}` pair (its own `req`
// helper): `{kind:"suggest-name", context:{target, fn, reg, source}}` where
// `source` is the synthetic `function f<fn>(){ return r<reg>; }` body. So the
// (fn,reg) recovered from an entry's own answer is enough to rebuild the
// exact request that produced it, with no recording of the original request
// needed and no network call.
//
// Usage:
//   node tools/readability/rekey-recording.ts <recording.json> [--skills-dir DIR] [--model MODEL]
// Rewrites the file in place; exits non-zero (and touches nothing) if any
// entry cannot be mapped back to a (fn,reg) pair.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../src/util/paths.ts";
import { loadSkill } from "../../src/readability/skills.ts";
import { cacheKey, SKILL_FOR_KIND } from "../../src/readability/types.ts";
import { bodyFromContext, canonicaliseContext } from "../../src/workers/backends/haiku.ts";
import type { Recording, RecordingEntry } from "../../src/workers/backends/replay.ts";

/** The exact request `tests/workers/backends.test.ts`'s own `req(fn, reg)`
 *  builds. If that helper's shape ever changes, `tests/workers/backends.test.ts`
 *  itself fails first (a `ReplayBackend` miss on the freshly re-keyed
 *  recording), which is the signal to update this function to match. */
function requestContext(fn: number, reg: number): Record<string, unknown> {
  const source = `function f${String(fn)}(){ return r${String(reg)}; }`;
  return { target: `{${String(fn)},${String(reg)}}`, fn, reg, source };
}

/** Recover the `{fn,reg}` an entry answers from its own answer text: a name
 *  proposal's `bindingId`, or a rewrite proposal's `fn` (register unknown for
 *  a rewrite-only answer, so this recording only ever carries name answers
 *  today -- `reg` falls back to whatever `bindingId.reg` said). Returns
 *  `undefined` when the text carries neither, so the caller can refuse
 *  rather than silently drop an entry. */
function recoverBinding(entry: RecordingEntry): { fn: number; reg: number } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(entry.text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const obj = parsed as Record<string, unknown>;
  const names = obj["names"];
  if (Array.isArray(names) && names.length > 0) {
    const first = names[0] as Record<string, unknown>;
    const bindingId = first["bindingId"] as Record<string, unknown> | undefined;
    if (bindingId !== undefined && typeof bindingId["fn"] === "number" && typeof bindingId["reg"] === "number") {
      return { fn: bindingId["fn"], reg: bindingId["reg"] };
    }
  }
  return undefined;
}

export interface RekeyOptions {
  readonly skillsDir: string;
  readonly model: string;
}

/** Pure function: old recording -> new recording, same entries under
 *  recomputed keys. Throws (touches nothing) if any entry cannot be mapped
 *  back to the (fn,reg) it answers -- a re-key must never silently drop a
 *  cache line. */
export function rekeyRecording(recording: Recording, opts: RekeyOptions): Recording {
  const skillId = SKILL_FOR_KIND["suggest-name"];
  if (skillId === undefined) throw new Error("rekey-recording: suggest-name has no routed skill (SKILL_FOR_KIND)");
  const skill = loadSkill(skillId, opts.skillsDir);
  const out: Record<string, RecordingEntry> = {};
  for (const [oldKey, entry] of Object.entries(recording)) {
    const binding = recoverBinding(entry);
    if (binding === undefined) {
      throw new Error(`rekey-recording: cannot recover the (fn,reg) entry ${oldKey} answers -- its text has no bindingId`);
    }
    const context = requestContext(binding.fn, binding.reg);
    const newKey = cacheKey({
      kind: "suggest-name",
      skillId,
      skillVersion: skill.version,
      model: opts.model,
      body: bodyFromContext(context),
      context: canonicaliseContext(context),
    });
    out[newKey] = entry;
  }
  return out;
}

function usage(): never {
  process.stderr.write("usage: node tools/readability/rekey-recording.ts <recording.json> [--skills-dir DIR] [--model MODEL]\n");
  process.exit(2);
}

function main(): void {
  const argv = process.argv.slice(2);
  const path = argv[0];
  if (path === undefined) usage();
  const skillsFlag = argv.indexOf("--skills-dir");
  const modelFlag = argv.indexOf("--model");
  const skillsDir = skillsFlag >= 0 ? argv[skillsFlag + 1]! : join(repoRoot(), "skills");
  const model = modelFlag >= 0 ? argv[modelFlag + 1]! : "claude-haiku-4-5-20251001";

  const before = JSON.parse(readFileSync(path, "utf8")) as Recording;
  const after = rekeyRecording(before, { skillsDir, model });
  writeFileSync(path, `${JSON.stringify(after, null, 2)}\n`);
  process.stderr.write(`rekey-recording: rewrote ${String(Object.keys(after).length)} of ${String(Object.keys(before).length)} keys in ${path}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`tools/readability/rekey-recording.ts: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}
