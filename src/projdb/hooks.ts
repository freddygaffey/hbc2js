// src/projdb/hooks.ts — installs the pre-commit hook that makes git
// structurally unable to record un-adopted project state (docs/specs/18-
// project-storage-integrity.md §11, §R4 step 4). The hook is a small POSIX
// shell script (works on macOS + Linux per CLAUDE.md's platform rule) that
// runs `hbcproj verify` (the fast path — checkShard + log-chain only, never
// `--full`, per the spec's "cheap, no DB[-round-trip]" requirement) whenever
// a commit touches this project's `analysis/`, `log/`, or the db file
// itself; a diverged shard or broken log chain blocks the commit with the
// exact remediation the spec names (`adopt`/`restore`). CI's
// `hbcproj verify --full` (wired in .github/workflows/ci.yml) is the
// non-bypassable twin — pre-commit is local and `--no-verify`-able (§11).
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface InstallHooksResult {
  readonly installed: boolean;
  readonly hookPath?: string;
  readonly reason?: string;
}

/** Bumped only if the generated script's shape changes in a way old
 *  installs should be replaced for; lets `installPreCommitHook` tell "an
 *  hbc2js hook from an older version" apart from "a human's own hook" so it
 *  only ever overwrites its own. */
const MARKER = "# hbc2js-pre-commit-hook v1 (docs/specs/18-project-storage-integrity.md §11)";

function gitPaths(cwd: string): { gitDir: string; topLevel: string } | undefined {
  try {
    // `stdio`'s stderr slot is explicitly piped (Node's default for
    // exec*Sync otherwise inherits the parent's stderr) — the "not a git
    // repository" case is expected/handled below, not a real error to
    // surface, so a bundle-only `init` outside any git tree shouldn't print
    // git's raw "fatal: ..." line to the user.
    const gitDirOut = execFileSync("git", ["rev-parse", "--git-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const topLevelOut = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const gitDir = isAbsolute(gitDirOut) ? gitDirOut : resolve(cwd, gitDirOut);
    const topLevel = resolve(topLevelOut);
    return { gitDir, topLevel };
  } catch {
    return undefined;
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function hookScript(opts: { readonly node: string; readonly cli: string; readonly dbPath: string; readonly projectRel: string }): string {
  // `projectRel` is "" when the project IS the repo root (the common case:
  // `hbc2js init --out .` inside an already-`git init`'d directory); the
  // prefix is then empty and every staged path is considered. Regex
  // special characters in `projectRel` are not escaped (v1: project
  // directories with grep-metacharacter names are out of scope, same as
  // the rest of this CLI's path handling).
  const prefix = opts.projectRel === "" ? "" : `${opts.projectRel}/`;
  return `#!/bin/sh
${MARKER}
# Blocks a commit that would record un-adopted project state: a staged
# analysis/ shard whose own content-hash doesn't match its content (a hand
# edit that skipped \`adopt\`), or a broken log/ hash chain. Fast check only
# (checkShard + log-chain, no --full round-trip) so it stays cheap enough to
# run on every commit. Bypass locally with \`git commit --no-verify\`; CI's
# \`hbcproj verify --full\` is the non-bypassable twin (see
# .github/workflows/ci.yml) — see docs/specs/18-project-storage-integrity.md
# §11 for why both exist.
staged=$(git diff --cached --name-only --diff-filter=ACMR | grep -E "^${prefix}(analysis/|log/|project\\.hbcproj$)" || true)
if [ -z "$staged" ]; then
  exit 0
fi
# NOTE: deliberately no \`set -e\` — a nonzero \`verify\` exit must reach the
# \`if\` below so the remediation message actually prints; \`set -e\` would
# abort the script at the \`verify\` line itself (still blocking the commit,
# but silently).
if ! ${shQuote(opts.node)} ${shQuote(opts.cli)} hbcproj verify ${shQuote(opts.dbPath)}; then
  echo "hbcproj pre-commit: ${opts.dbPath} has un-adopted state — run 'hbc2js hbcproj adopt <shard>' or 'hbc2js hbcproj restore <shard>' before committing (docs/specs/18-project-storage-integrity.md §11)" >&2
  exit 1
fi
exit 0
`;
}

/** Installs (or re-installs) the pre-commit hook for the project rooted at
 *  `projectDir` (the directory holding `project.hbcproj`, `analysis/`,
 *  `log/` — §3's layout). `cliEntry` is the absolute path to the CLI
 *  script the hook should re-invoke (normally `process.argv[1]` at install
 *  time, resolved to an absolute path by the caller) and `nodeBin`
 *  defaults to the currently running `node`. Never throws: if `projectDir`
 *  isn't inside a git working tree, returns `{ installed: false, reason }`
 *  so `init` can install it best-effort without failing the whole command
 *  (§9's `init` table row: "scaffold the project; install the git
 *  pre-commit hook" is one of several things `init` does, not the thing a
 *  bundle-only run should fail on). Refuses to clobber a hook it didn't
 *  write (no `MARKER`) unless `force` is set. */
export function installPreCommitHook(
  projectDir: string,
  cliEntry: string,
  opts?: { readonly nodeBin?: string; readonly force?: boolean },
): InstallHooksResult {
  const absProjectDir = resolve(projectDir);
  const paths = gitPaths(absProjectDir);
  if (paths === undefined) {
    return { installed: false, reason: `${absProjectDir} is not inside a git working tree — run \`git init\` then \`hbc2js hbcproj install-hooks\`` };
  }
  // `git rev-parse --show-toplevel`/`--git-dir` resolve symlinks (e.g.
  // macOS's `/tmp` -> `/private/tmp`); `resolve()` alone does not, which
  // would make `relative()` below produce a bogus `../../..`-laden path
  // whenever `projectDir` was reached through a symlinked ancestor.
  // Real-pathing here keeps the staged-path prefix the hook greps for in
  // sync with what git itself reports.
  const realProjectDir = realpathSync(absProjectDir);
  const hooksDir = join(paths.gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-commit");
  if (existsSync(hookPath) && opts?.force !== true) {
    const existing = readFileSync(hookPath, "utf8");
    if (!existing.includes(MARKER)) {
      return { installed: false, hookPath, reason: `${hookPath} already exists and was not written by hbc2js — install-hooks refuses to overwrite it (pass --force)` };
    }
  }
  const dbPath = join(absProjectDir, "project.hbcproj");
  const projectRel = relative(paths.topLevel, realProjectDir).split("\\").join("/");
  const script = hookScript({
    node: opts?.nodeBin ?? process.execPath,
    cli: resolve(cliEntry),
    dbPath,
    projectRel: projectRel === "." ? "" : projectRel,
  });
  writeFileSync(hookPath, script, "utf8");
  chmodSync(hookPath, 0o755);
  return { installed: true, hookPath };
}
