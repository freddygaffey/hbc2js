// src/workers/backends/replay.ts -- spec 28 landing 1: a `WorkerBackend` that
// answers from a committed JSON recording instead of the network, so the gate
// (and a held-out-app measurement without ANTHROPIC_API_KEY) can drive the
// SAME request shape `HaikuBackend` produces. A miss errors loudly with the
// key it looked for, so a stale recording fails the run rather than silently
// answering something else (spec 28 section 9.1's cache-key discipline
// applies here too: the key is content-addressed the same way).
//
// Recording shape (`tests/fixtures/llm-readability/<app>.recording.json`):
// `{ [cacheKey]: { text, cost? } }`. Produced by `tools/readability/record.ts`
// against the real `HaikuBackend` -- that tool needs `ANTHROPIC_API_KEY` and
// is never run by the gate.
import { readFileSync } from "node:fs";
import { loadSkill } from "../../readability/skills.ts";
import { cacheKey, SKILL_FOR_KIND } from "../../readability/types.ts";
import type { WorkerBackend, WorkerJobRequest, WorkerJobResponse } from "../backend.ts";
import { bodyFromContext, canonicaliseContext } from "./haiku.ts";

export interface RecordingEntry {
  readonly text: string;
  readonly cost?: { readonly tokensIn?: number; readonly tokensOut?: number };
}

export type Recording = Readonly<Record<string, RecordingEntry>>;

export interface ReplayBackendConfig {
  readonly model: string;
  readonly skillsDir: string;
}

export function loadRecording(path: string): Recording {
  return JSON.parse(readFileSync(path, "utf8")) as Recording;
}

export class ReplayBackend implements WorkerBackend {
  readonly id = "replay";
  /** Every key looked up, in order -- lets a test assert cache-through
   *  behaviour the same way `FakeBackend.seen` does. */
  readonly seen: string[] = [];
  private readonly recording: Recording;
  private readonly config: ReplayBackendConfig;

  constructor(recording: Recording, config: ReplayBackendConfig) {
    this.recording = recording;
    this.config = config;
  }

  run(req: WorkerJobRequest): Promise<WorkerJobResponse> {
    const skillId = SKILL_FOR_KIND[req.kind];
    if (skillId === undefined) {
      return Promise.reject(new Error(`ReplayBackend: job kind "${req.kind}" has no routed skill (SKILL_FOR_KIND)`));
    }
    const skill = loadSkill(skillId, this.config.skillsDir);
    const body = bodyFromContext(req.context);
    const context = canonicaliseContext(req.context);
    const key = cacheKey({ kind: req.kind, skillId, skillVersion: skill.version, model: this.config.model, body, context });
    this.seen.push(key);
    const entry = this.recording[key];
    if (entry === undefined) {
      return Promise.reject(
        new Error(
          `ReplayBackend: no recording for key ${key} (kind=${req.kind}); the recording is stale or incomplete -- ` +
            "re-run tools/readability/record.ts",
        ),
      );
    }
    return Promise.resolve({ text: entry.text, ...(entry.cost !== undefined ? { cost: entry.cost } : {}) });
  }
}
