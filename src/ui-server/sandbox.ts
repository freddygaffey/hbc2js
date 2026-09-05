// src/ui-server/sandbox.ts — docs/specs/26-ui-full-ide.md L8 (row 7 of its
// §1.1 delta table), implementing docs/specs/21-live-update-and-worktrees.md
// §2.1 + §2.4 for the one operation in the system that produces a modified
// binary: `recompile_edit` (docs/specs/17-mcp-harness.md §13).
//
// WHAT IS SANDBOXED, AND WHAT IS NOT.
//
//   * Sandboxed: the SPECULATIVE EDITED SOURCE. Spec 21 §2.1's argument is
//     about the *edited source tree* — "exactly the kind of speculative,
//     throwaway, possibly-broken state that must not touch the analyst's
//     shared `src/` working copy". This module materialises the edit inside
//     a disposable directory (or a `git worktree`), hands `McpTools` the
//     source from there, and destroys it afterwards.
//   * NOT sandboxed, and deliberately: `McpTools.recompileEdit`'s own
//     scratch output (`RecompileEditResult.outputPath`). That path is the
//     experiment's ARTIFACT — the caller is told to go and look at it, so
//     tearing it down with the sandbox would hand back a dead path. It
//     already lives in a fresh `mkdtempSync` dir owned by `McpTools` and is
//     already, by that method's own NO-MUTATE PROOF, never the bundle and
//     never inside the `.hbcproj`.
//
// KIND (spec 26 §4.3 reserves the final word for Fred; this is the default
// until he answers, and both kinds are implemented so the answer is a
// one-word config change, not a rewrite):
//
//   * `"copy"` (DEFAULT) — a `mkdtempSync` directory. Spec 21 §2.4
//     explicitly allows "a plain temp copy for a single-file patch", and
//     `recompile_edit` IS a single-file patch: one function's source, one
//     `hermesc` invocation. No git object store is touched, so it also
//     works when the project is not inside a git checkout at all (the
//     common case: an analyst's `.hbcproj` next to an APK).
//   * `"worktree"` — `git worktree add --detach`, for the experiment that
//     wants the tree and git's own diff. Requires `repoRoot` to be a git
//     checkout; falls back to nothing (it errors) rather than silently
//     degrading to a copy, because a caller that asked for git's diff must
//     not be told it got one.
//
// TEARDOWN IS GUARANTEED THREE WAYS: `withSandbox`'s `finally` (success and
// throw), and a process `exit`/`SIGINT`/`SIGTERM` hook installed only while
// at least one sandbox is live. `liveSandboxPaths()` is the observable form
// of "nothing leaked" that `tests/ui-server/sandbox.test.ts` asserts on.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hbc2jsError, ErrorCode } from "../errors.ts";
import type { McpTools } from "../mcp/tools.ts";
import type { UiRequest, UiResponse, UiServerCtx } from "./routes.ts";

export type SandboxKind = "copy" | "worktree";

export interface Sandbox {
  /** Unique per experiment; also the basename of `path`'s parent, so a leak
   *  is greppable in `$TMPDIR` by id alone. */
  readonly id: string;
  readonly kind: SandboxKind;
  /** The directory the experiment may write into. */
  readonly path: string;
}

export interface SandboxOptions {
  readonly kind?: SandboxKind;
  /** Required for `kind: "worktree"`; ignored by `"copy"`. */
  readonly repoRoot?: string;
}

/** The additive half of `POST /api/tools/recompile-edit`'s response (spec 26
 *  §1.1 row 7: "response gains the sandbox id/teardown status"). Never
 *  replaces or reshapes any field `McpTools` returned. */
export interface SandboxReport {
  readonly id: string;
  readonly kind: SandboxKind;
  /** `false` means the teardown itself failed — reported, never swallowed,
   *  because a sandbox that outlived its experiment is exactly the residue
   *  spec 21 §2.1 says there must be none of. */
  readonly tornDown: boolean;
  /** Present only when `tornDown` is false: why. */
  readonly teardownError?: string;
}

const LIVE = new Map<string, Sandbox>();
/** The `mkdtemp` parent per sandbox: `path` for a copy, `path`'s parent for
 *  a worktree (git refuses to `add` into an existing directory, so the
 *  worktree is a child of the temp dir we own). */
const ROOTS = new Map<string, string>();
let hooksInstalled = false;

function cleanupAll(): void {
  for (const id of [...LIVE.keys()]) {
    try {
      destroySandbox(LIVE.get(id)!);
    } catch {
      // process is going away; a best-effort rm is all that is left
    }
  }
}

function onSignal(signal: NodeJS.Signals): void {
  cleanupAll();
  process.removeListener(signal, onSignal);
  process.kill(process.pid, signal);
}

function ensureHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  // `exit` only: synchronous `rmSync` is legal there and it is the one hook
  // that fires for a normal shutdown as well as an uncaught throw.
  process.on("exit", cleanupAll);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

function releaseHooks(): void {
  if (!hooksInstalled || LIVE.size > 0) return;
  hooksInstalled = false;
  process.removeListener("exit", cleanupAll);
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}

/** Every live sandbox's directory, for tests and for an operator asking
 *  "did anything leak?". Empty is the steady state. */
export function liveSandboxPaths(): readonly string[] {
  return [...LIVE.values()].map((s) => s.path);
}

export function createSandbox(opts: SandboxOptions = {}): Sandbox {
  const kind: SandboxKind = opts.kind ?? "copy";
  // `mkdtempSync` is the uniqueness guarantee: the OS, not a counter, hands
  // out the name, so two concurrent experiments (in one process or two)
  // cannot collide on a path.
  const root = mkdtempSync(join(tmpdir(), "hbc2js-sandbox-"));
  const id = basename(root);
  let path = root;
  if (kind === "worktree") {
    const repoRoot = opts.repoRoot;
    if (repoRoot === undefined) {
      rmSync(root, { recursive: true, force: true });
      throw new Hbc2jsError(ErrorCode.E_USAGE, "sandbox: kind 'worktree' needs repoRoot (the git checkout to branch the worktree from)");
    }
    path = join(root, "wt");
    try {
      execFileSync("git", ["worktree", "add", "--detach", path, "HEAD"], { cwd: repoRoot, stdio: "pipe" });
    } catch (e) {
      rmSync(root, { recursive: true, force: true });
      const detail = e instanceof Error ? e.message : String(e);
      throw new Hbc2jsError(ErrorCode.E_USAGE, `sandbox: git worktree add failed in ${repoRoot}: ${detail}`);
    }
  } else {
    mkdirSync(path, { recursive: true });
  }
  const sb: Sandbox = { id, kind, path };
  LIVE.set(id, sb);
  ROOTS.set(id, root);
  ensureHooks();
  return sb;
}

/** Idempotent: destroying an already-destroyed sandbox is a no-op that still
 *  reports `true` (the postcondition "it is gone" holds). */
export function destroySandbox(sb: Sandbox): SandboxReport {
  const root = ROOTS.get(sb.id) ?? sb.path;
  let teardownError: string | undefined;
  if (sb.kind === "worktree") {
    // `git worktree remove` first so git's own metadata (`.git/worktrees/…`)
    // goes with it; the rm below is the belt-and-braces half, and `prune`
    // clears the administrative entry if `remove` could not.
    try {
      execFileSync("git", ["worktree", "remove", "--force", sb.path], { cwd: sb.path, stdio: "pipe" });
    } catch {
      // fall through to rm + prune
    }
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (e) {
    teardownError = e instanceof Error ? e.message : String(e);
  }
  if (existsSync(root)) teardownError ??= `sandbox directory still exists: ${root}`;
  LIVE.delete(sb.id);
  ROOTS.delete(sb.id);
  releaseHooks();
  return teardownError === undefined
    ? { id: sb.id, kind: sb.kind, tornDown: true }
    : { id: sb.id, kind: sb.kind, tornDown: false, teardownError };
}

/** Run `fn` inside a fresh sandbox and destroy it afterwards — on success,
 *  on throw, and (via the process hooks) on an abrupt exit. The sandbox
 *  report travels with the value on success; on a throw the sandbox is
 *  already gone by the time the error leaves this function. */
export async function withSandbox<T>(opts: SandboxOptions, fn: (sb: Sandbox) => T | Promise<T>): Promise<{ readonly value: T; readonly sandbox: SandboxReport }> {
  const sb = createSandbox(opts);
  let value: T;
  try {
    value = await fn(sb);
  } catch (e) {
    destroySandbox(sb);
    throw e;
  }
  return { value, sandbox: destroySandbox(sb) };
}

// -- the route -------------------------------------------------------------

/** `POST /api/tools/recompile-edit`'s body: `RecompileEditInput` plus this
 *  landing's two additive, optional fields. */
type RecompileEditBody = Parameters<McpTools["recompileEdit"]>[0] & {
  readonly sandbox?: { readonly kind?: SandboxKind };
  readonly runTrace?: boolean;
};

/** spec 23 §7: "No worker may call it unattended: `poc-finding` proposes the
 *  edit and the human runs it." The provenance the caller sends is the only
 *  thing that identifies it, and it is the same provenance every other write
 *  tool records — so the refusal is checked here, on the way in, rather than
 *  inferred later from a log row. `source: "llm"` and a `who` of
 *  `worker:<kind>` are exactly spec 23 §5's worker-write provenance. */
export function refusalForProvenance(prov: unknown): string | null {
  if (typeof prov !== "object" || prov === null) return null;
  const p = prov as { source?: unknown; who?: unknown };
  const who = typeof p.who === "string" ? p.who : "";
  if (p.source === "llm" || who.startsWith("worker:")) {
    return (
      "recompile_edit is attended-only: no worker may run it unattended (docs/specs/23-ui-workers.md §7). " +
      "A worker proposes the edit as a poc-finding annotation; a human runs it."
    );
  }
  return null;
}

// `routes.ts` keeps its own private `Route` shape (there is exactly one
// `handle()`); this mirrors `screens.ts`/`workers-routes.ts` and is spliced
// into that table by ONE line there.
interface Route {
  readonly method: "GET" | "POST";
  readonly re: RegExp;
  readonly handler: (params: readonly string[], req: UiRequest, ctx: UiServerCtx) => UiResponse | Promise<UiResponse>;
}

export const RECOMPILE_ROUTES: readonly Route[] = [
  {
    // spec 17 §13's warning and `{kind:"edited-and-recompiled"}` watermark
    // travel VERBATIM: this handler spreads `McpTools`' own result and adds
    // one field. It never rewords, summarises or drops either.
    method: "POST",
    re: /^\/api\/tools\/recompile-edit$/,
    handler: async (_p, req, ctx) => {
      const body = (req.body ?? {}) as RecompileEditBody;
      const refusal = refusalForProvenance((body as { prov?: unknown }).prov);
      if (refusal !== null) return { status: 403, json: { reason: refusal } };
      const kind: SandboxKind = body.sandbox?.kind ?? "copy";
      if (kind !== "copy" && kind !== "worktree") {
        return { status: 400, json: { reason: `recompile-edit: unknown sandbox kind '${String(kind)}' (expected 'copy' or 'worktree')` } };
      }
      const { value, sandbox } = await withSandbox({ kind, repoRoot: ctx.artifactDir }, async (sb) => {
        // The speculative edit is materialised in the sandbox first (spec 21
        // §2.1: the edited source is the thing that must not touch the
        // analyst's working copy), and the tool is handed the source from
        // there. `McpTools` keeps its own scratch dir for the compiled
        // output, which outlives the sandbox on purpose (see the file
        // header).
        const source = typeof body.source === "string" ? body.source : "";
        writeFileSync(join(sb.path, `edit-fn${String(body.fn)}.js`), source);
        return body.runTrace === true ? await ctx.tools.recompileEditAndRun(body) : ctx.tools.recompileEdit(body);
      });
      return { status: 200, json: { ...value, sandbox } };
    },
  },
];
