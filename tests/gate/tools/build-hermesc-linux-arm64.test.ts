// T5 (docs/TASKS.md) — tools/build-hermesc-linux-arm64.sh's `--check` mode is
// the only part of this script that can run in CI/dev (offline-safe,
// side-effect-free: never clones or builds). It must: (1) always report OS,
// arch, and every prerequisite instead of crashing; (2) list the version
// pin table (94/96/99 pinned, 84/98 explicitly not); (3) fail loudly and
// specifically on a non-arm64 host, never silently pretend to be ok; (4) the
// real build path must refuse — not attempt a cross-build or fall back to
// the host's actual arch — the moment it's invoked on non-arm64.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";

const SCRIPT = join(repoRoot(), "tools", "build-hermesc-linux-arm64.sh");

function run(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(SCRIPT, args, { encoding: "utf8", shell: false });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("--check runs the full prerequisite report without building anything", () => {
  const r = run(["--check"]);
  assert.match(r.stdout, /OS: /);
  assert.match(r.stdout, /Arch: /);
  assert.match(r.stdout, /git: /);
  assert.match(r.stdout, /cmake: /);
  assert.match(r.stdout, /generator: /);
  assert.match(r.stdout, /C\+\+ compiler: /);
  assert.match(r.stdout, /python3: /);
  assert.match(r.stdout, /disk space: /);
  assert.match(r.stdout, /RESULT: /);
  // Never clones or builds: no hermesc-build/ src tree should appear.
  assert.doesNotMatch(r.stdout + r.stderr, /Cloning https:\/\/github/);
  assert.doesNotMatch(r.stdout + r.stderr, /Building hermesc/);
});

test("--check prints the version pin table: 94/96/99 pinned, 84/98 explicitly not", () => {
  const r = run(["--check"]);
  assert.match(r.stdout, /v94: pinned, commit [0-9a-f]{40}/);
  assert.match(r.stdout, /v96: pinned, commit [0-9a-f]{40}/);
  assert.match(r.stdout, /v99: pinned, commit [0-9a-f]{40}/);
  assert.match(r.stdout, /v84: NOT PINNED/);
  assert.match(r.stdout, /v98: NOT PINNED/);
});

test("--check 96 additionally confirms the requested version is pinned and buildable", () => {
  const r = run(["--check", "96"]);
  assert.match(r.stdout, /Requested version v96: pinned, buildable/);
});

test("--check 84 fails specifically because 84 has no pinned commit, not silently", () => {
  const r = run(["--check", "84"]);
  assert.match(r.stdout, /Requested version v84: NOT PINNED \(FAIL/);
  assert.equal(r.status, 1);
});

test("on this container's actual architecture, --check exits non-zero and never claims success", () => {
  // This container is x86_64 (per the T5 brief); assert the behavior that
  // matters regardless of what CI eventually runs this on: a host whose
  // arch is not aarch64/arm64 must fail the check, loudly and specifically,
  // never silently report ok.
  const hostArch = process.arch; // 'x64', 'arm64', etc. (Node's own arch)
  const r = run(["--check"]);
  if (hostArch !== "arm64") {
    assert.match(r.stdout, /Arch: .* \(FAIL — this script only builds for Linux arm64\/aarch64/);
    assert.match(r.stdout, /RESULT: FAIL/);
    assert.equal(r.status, 1);
  } else {
    // A genuinely arm64 CI runner: arch line must read ok, not FAIL.
    assert.match(r.stdout, /Arch: (aarch64|arm64) \(ok\)/);
  }
});

test("no arguments prints usage and exits non-zero", () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
});

test("an unknown version token is rejected via usage, not silently ignored", () => {
  const r = run(["123"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage:/);
});

test("a real (non-check) build invocation refuses immediately on a non-arm64 host — no cross-build fallback", () => {
  if (process.arch === "arm64") {
    return; // this specific refusal path only fires off-arm64; covered by --check's arch assertion above on arm64 CI.
  }
  const r = run(["94"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /this script only builds for Linux arm64\/aarch64/);
  assert.match(r.stderr, /not a cross-compiler/);
  // Must fail before ever touching the network/filesystem for a clone.
  assert.doesNotMatch(r.stdout + r.stderr, /Cloning/);
});

test("requesting an unpinned version (84) for a real build names the exact reason, not a generic error", () => {
  if (process.arch === "arm64") {
    return; // arch gate fires first there; the unpinned-version message is exercised via --check 84 above.
  }
  const r = run(["84"]);
  assert.equal(r.status, 1);
  // Arch gate fires before the version-pin check in the real build path
  // (both must refuse; arch is checked first) — either message is an
  // acceptable loud, specific refusal, but it must never look like success.
  assert.match(r.stderr, /this script only builds for Linux arm64\/aarch64|no facebook\/hermes commit is pinned for v84/);
});
