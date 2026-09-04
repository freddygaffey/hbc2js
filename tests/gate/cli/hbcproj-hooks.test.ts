// tests/gate/cli/hbcproj-hooks.test.ts — docs/specs/18-project-storage-
// integrity.md §11 / §R4 step 4: `hbc2js init` scaffolds the §3 directory
// layout (src/, .gitignore) and best-effort installs a git pre-commit hook;
// `hbcproj install-hooks` (re)installs it on demand; the hook is the
// mechanism that makes git structurally unable to record un-adopted project
// state — proven here end to end with a real, hermetic temp git repo (never
// touches this repo's own `.git/hooks`). CI's `hbcproj verify --full`
// (.github/workflows/ci.yml) is exercised too, standing in for the
// escape-hatch case (a forged fast-check) the pre-commit hook alone can't
// catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { openProjectDb } from "../../../src/projdb/db.ts";
import { dbSetName } from "../../../src/projdb/annotations.ts";
import { exportWriteEffect } from "../../../src/projdb/export.ts";

const CLI = join(repoRoot(), "src", "cli.ts");
const FIXTURE_HBC = join(repoRoot(), "tests", "fixtures", "constructs", "04-for-loop-basic", "v96.hbc");

function runCli(args: readonly string[], cwd?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", shell: false, cwd });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Makes `repoDir` a git repo with a committer identity, hermetic to this
 *  test (a fresh temp dir, never the real repo). */
function initGitRepo(repoDir: string): void {
  mkdirSync(repoDir, { recursive: true });
  git(["init", "-q"], repoDir);
  git(["config", "user.email", "test@example.com"], repoDir);
  git(["config", "user.name", "hbc2js test"], repoDir);
}

test("hbc2js init writes the §3 layout: src/, .gitignore, and (best-effort) a pre-commit hook", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-hooks-init-"));
  try {
    const init = runCli(["init", FIXTURE_HBC, "--out", outDir]);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(existsSync(join(outDir, "project.hbcproj")));
    assert.ok(existsSync(join(outDir, "src")), "split output should land under src/");
    assert.ok(readFileSync(join(outDir, "src", "index.js"), "utf8").length > 0);
    const gitignore = readFileSync(join(outDir, ".gitignore"), "utf8");
    assert.match(gitignore, /project\.hbcproj/);
    assert.match(gitignore, /index\//);
    assert.match(gitignore, /scans\//);
    // outDir is not a git working tree, so the hook install is a documented
    // no-op — proven by the stdout note, not a hook file.
    assert.match(init.stdout, /pre-commit hook not installed/);
    assert.ok(!existsSync(join(outDir, ".git")));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("hbc2js init installs an executable pre-commit hook when --out is already a git repo", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-hooks-git-"));
  try {
    initGitRepo(repoDir);
    const init = runCli(["init", FIXTURE_HBC, "--out", repoDir]);
    assert.equal(init.status, 0, init.stderr);
    const hookPath = join(repoDir, ".git", "hooks", "pre-commit");
    assert.ok(existsSync(hookPath));
    assert.match(init.stdout, /installed pre-commit hook/);
    const mode = statSync(hookPath).mode & 0o777;
    assert.ok((mode & 0o100) !== 0, "hook should be executable");
    assert.match(readFileSync(hookPath, "utf8"), /hbc2js-pre-commit-hook/);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("hbcproj install-hooks --help exits 0; refuses a missing db path", () => {
  const help = runCli(["hbcproj", "install-hooks", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /install-hooks/);
  const missing = runCli(["hbcproj", "install-hooks", join(tmpdir(), "does-not-exist.hbcproj")]);
  assert.equal(missing.status, 2);
});

test("hbcproj install-hooks retries after `git init` happens post-`hbcproj init`", () => {
  const repoDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-hooks-late-git-"));
  try {
    const init = runCli(["init", FIXTURE_HBC, "--out", repoDir]);
    assert.equal(init.status, 0, init.stderr);
    assert.ok(!existsSync(join(repoDir, ".git", "hooks", "pre-commit")));
    initGitRepo(repoDir);
    const dbPath = join(repoDir, "project.hbcproj");
    const installed = runCli(["hbcproj", "install-hooks", dbPath]);
    assert.equal(installed.status, 0, installed.stderr);
    assert.ok(existsSync(join(repoDir, ".git", "hooks", "pre-commit")));
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

/** Sets up a fresh git repo that IS the project directory (`init --out
 *  repoDir`), exports once so `analysis/`+`log/` exist, and commits that
 *  clean baseline — mirrors `tests/gate/cli/hbcproj-status-adopt.test.ts`'s
 *  `initProjectWithOneName` but drives real `git add`/`git commit` so the
 *  installed hook actually runs. */
function initCleanProjectRepo(): { repoDir: string; dbPath: string; namesPath: string } {
  const repoDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-hooks-commit-"));
  initGitRepo(repoDir);
  const init = runCli(["init", FIXTURE_HBC, "--out", repoDir]);
  assert.equal(init.status, 0, init.stderr);
  const dbPath = join(repoDir, "project.hbcproj");
  const db = openProjectDb(dbPath);
  const { record } = dbSetName(db, "fn:1", "decodePayload", { source: "human", who: "fred" });
  exportWriteEffect(db, repoDir, Number(record.rid));
  db.close();
  const namesPath = join(repoDir, "analysis", "names", "_unassigned.json");
  assert.ok(existsSync(namesPath));
  git(["add", "-A"], repoDir);
  git(["commit", "-q", "-m", "clean baseline"], repoDir);
  return { repoDir, dbPath, namesPath };
}

test("pre-commit hook blocks a commit containing an un-adopted hand edit, passes once adopted", () => {
  const { repoDir, dbPath, namesPath } = initCleanProjectRepo();
  try {
    // Hand-edit the shard directly (same technique as
    // hbcproj-status-adopt.test.ts): change content without re-locking the
    // embedded contentHash, so `checkShard` classifies it "hand-edit".
    const parsed = JSON.parse(readFileSync(namesPath, "utf8")) as { entries: Record<string, { name: string }> };
    for (const key of Object.keys(parsed.entries)) parsed.entries[key]!.name = "handEditedName";
    writeFileSync(namesPath, JSON.stringify(parsed), "utf8");
    git(["add", "-A"], repoDir);

    const blocked = spawnSync("git", ["commit", "-q", "-m", "un-adopted hand edit"], { cwd: repoDir, encoding: "utf8" });
    assert.notEqual(blocked.status, 0, "commit of un-adopted state should be blocked by the pre-commit hook");
    assert.match(blocked.stderr + blocked.stdout, /adopt|restore/);
    // Nothing new landed in history — the blocked commit never happened.
    const log1 = git(["log", "--oneline"], repoDir).trim().split("\n");
    assert.equal(log1.length, 1);

    // Adopt the hand edit (folds it into the db and re-locks the hash), then
    // the identical staged change is committable.
    const adopt = runCli(["hbcproj", "adopt", dbPath, namesPath]);
    assert.equal(adopt.status, 0, adopt.stderr);
    git(["add", "-A"], repoDir);
    const allowed = spawnSync("git", ["commit", "-q", "-m", "adopted hand edit"], { cwd: repoDir, encoding: "utf8" });
    assert.equal(allowed.status, 0, allowed.stderr + allowed.stdout);
    const log2 = git(["log", "--oneline"], repoDir).trim().split("\n");
    assert.equal(log2.length, 2);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("pre-commit hook allows a commit that only touches src/ (no analysis/log/db staged)", () => {
  const { repoDir } = initCleanProjectRepo();
  try {
    writeFileSync(join(repoDir, "src", "extra-note.txt"), "hello\n", "utf8");
    git(["add", "-A"], repoDir);
    const result = spawnSync("git", ["commit", "-q", "-m", "unrelated src change"], { cwd: repoDir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr + result.stdout);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
  }
});

test("hbcproj verify --full runs clean on a freshly-exported project (the CI job's command)", () => {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-hbcproj-hooks-verify-full-"));
  try {
    const init = runCli(["init", FIXTURE_HBC, "--out", outDir]);
    assert.equal(init.status, 0, init.stderr);
    const dbPath = join(outDir, "project.hbcproj");
    const exp = runCli(["hbcproj", "export", dbPath]);
    assert.equal(exp.status, 0, exp.stderr);
    const full = runCli(["hbcproj", "verify", "--full", dbPath]);
    assert.equal(full.status, 0, full.stdout + full.stderr);
    assert.match(full.stdout, /OK/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
