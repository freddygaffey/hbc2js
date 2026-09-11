// src/readability/backends.ts -- spec 28 section 9.1: the ONE place a
// backend id maps to a `WorkerBackend` constructor, shared by `hbc2js name
// llm-fill`, `tools/readability/record.ts` and the UI worker pool, so the
// default cannot drift between callers.
//
// Fred's ruling (2026-09-11, verbatim): "It should run on the Claude plan on
// the shell ... they should not be using the API because API is more
// expensive. You should have an API option if it's easy to integrate, but
// you should not be going through API as default." `claude-cli` is therefore
// DEFAULT; `haiku` (the metered Anthropic API) is opt-in and requires
// `ANTHROPIC_API_KEY`.
//
// This file imports the transport-owning backend modules
// (`src/workers/backends/{claude-cli,haiku}.ts`) but never itself opens a
// socket or spawns a process, so it stays a thin selector; the network/spawn
// call sites the project restricts to those two files are unaffected
// (tests/gate/llm-readability/interface-shape.test.ts's pattern scan looks
// for `fetch`/`node:http` etc. literally in this directory's files, and this
// file contains neither).
import type { WorkerBackend } from "../workers/backend.ts";
import { FakeBackend } from "../workers/backend.ts";
import { HaikuBackend } from "../workers/backends/haiku.ts";
import { ClaudeCliBackend } from "../workers/backends/claude-cli.ts";
import { HeuristicBackend } from "../workers/backends/heuristic.ts";
import { ReplayBackend, loadRecording } from "../workers/backends/replay.ts";
import { resolveClaudeCliConfig, resolveHaikuConfig, SKILLS_DIR } from "./types.ts";

export const BACKEND_IDS = ["claude-cli", "haiku", "replay", "heuristic", "fake"] as const;
export type BackendId = (typeof BACKEND_IDS)[number];

/** The default backend for every LLM-shaped job kind (spec 28's
 *  `SKILL_FOR_KIND`): the `claude` CLI on Fred's plan, never the metered API. */
export const DEFAULT_LLM_BACKEND_ID: BackendId = "claude-cli";
/** Env override, read by whichever caller resolves the id (CLI, tool,
 *  server) -- CLI `--backend` always wins over this. */
export const LLM_BACKEND_ENV = "HBC2JS_LLM_BACKEND";

export class BackendSelectionError extends Error {}

function isBackendId(s: string): s is BackendId {
  return (BACKEND_IDS as readonly string[]).includes(s);
}

/** `--backend` flag value, then `HBC2JS_LLM_BACKEND`, then the default. */
export function resolveBackendId(explicit: string | undefined, env: Readonly<Record<string, string | undefined>> = {}): BackendId {
  const id = explicit ?? env[LLM_BACKEND_ENV] ?? DEFAULT_LLM_BACKEND_ID;
  if (!isBackendId(id)) {
    throw new BackendSelectionError(`unknown backend id "${id}" (expected one of ${BACKEND_IDS.join("|")})`);
  }
  return id;
}

export interface BackendForIdOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Required for `id === "replay"`. */
  readonly recordingPath?: string;
  readonly projectDir?: string;
}

/** Constructs the backend for a resolved id. `haiku` throws
 *  `ReadabilityConfigError` (via `resolveHaikuConfig`) if `ANTHROPIC_API_KEY`
 *  is not readable from `env` at call time -- the same lazy check
 *  `HaikuBackend.run` already does, not duplicated here. */
export function backendForId(id: BackendId, opts: BackendForIdOptions = {}): WorkerBackend {
  const env = opts.env ?? process.env;
  switch (id) {
    case "claude-cli":
      return new ClaudeCliBackend(resolveClaudeCliConfig(env, {}, opts.projectDir));
    case "haiku":
      return new HaikuBackend(resolveHaikuConfig(env, {}, opts.projectDir));
    case "replay": {
      if (opts.recordingPath === undefined) {
        throw new BackendSelectionError('backend "replay" requires a recording path');
      }
      return new ReplayBackend(loadRecording(opts.recordingPath), { model: resolveHaikuConfig(env).model, skillsDir: SKILLS_DIR });
    }
    case "heuristic":
      return new HeuristicBackend();
    case "fake":
      return new FakeBackend();
  }
}
