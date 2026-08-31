// docs/specs/06-harness.md §3 — the Hermes VM oracle (D14). Port of
// tools/equiv/src/hermes.mjs, extended with the versioned VM discovery §3.1
// specifies.
//
// Running the *original .hbc* under the Hermes VM and the decompiled .js
// under the same VM removes Node-vs-Hermes semantic drift from the
// comparison entirely (docs/EQUIVALENCE.md §5). Availability is the catch:
// only `hermes-engine-cli` (HBC <= 89) and the source-built VMs
// (`tools/build-hermes-vm.sh 94|99`) ship a `hermes` interpreter, and the VM
// refuses any bytecode whose version is not exactly its own:
//
//   $ tools/hermesc/v84/hermes -b v94.hbc
//   Error deserializing bytecode: Wrong bytecode version. Expected 84 but got 94
//
// So a VM is only ever used for its own version, and a missing VM is
// INCONCLUSIVE, never a silent fallback to Node (HA-05).
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../util/paths.ts";

export interface HermesVm {
  readonly hbcVersion: number;
  readonly path: string;
}

/** HBC header: 8-byte magic, then the format version as a LE uint32 at
 *  offset 8. */
export function hbcVersion(file: string): number {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    return buf.readUInt32LE(8);
  } finally {
    fs.closeSync(fd);
  }
}

/** Discovery order (§3.1), first hit wins:
 *  1. `process.env[HERMES_VM_V<version>]`
 *  2. `tools/hermes-vm/v<version>/bin/hermes`   (source-built: 94, 99, …)
 *  3. `tools/hermesc/v<version>/hermes`         (prebuilt fallback)
 *
 *  Both candidate directories are probed generically by version number
 *  rather than a hardcoded version list: `tools/hermesc/v96/hermes` also
 *  turns out to exist (react-native@0.73.11's npm tarball bundles a `hermes`
 *  interpreter alongside `hermesc`, not just the hermes-engine-cli v84
 *  package spec 06 §3.1 names) and this discovery order picks it up without
 *  special-casing — see docs/STATUS.md and this milestone's report. */
export function findHermesVm(version: number): HermesVm | null {
  const envVar = process.env[`HERMES_VM_V${version}`];
  if (envVar !== undefined && fs.existsSync(envVar)) return { hbcVersion: version, path: envVar };
  const candidates = [
    path.join(repoRoot(), "tools", "hermes-vm", `v${version}`, "bin", "hermes"),
    path.join(repoRoot(), "tools", "hermesc", `v${version}`, "hermes"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return { hbcVersion: version, path: c };
  }
  return null;
}

/** Every version this repo currently ships an on-disk VM for (used to report
 *  "available: …" in an INCONCLUSIVE message, and by the reference policy's
 *  own tests). Not exhaustive of every HBC version this project targets —
 *  just what discovery can currently find. */
export function findAllHermesVms(): readonly HermesVm[] {
  const candidateVersions = [84, 89, 94, 96, 98, 99];
  const out: HermesVm[] = [];
  for (const v of candidateVersions) {
    const vm = findHermesVm(v);
    if (vm !== null) out.push(vm);
  }
  return out;
}

export interface HermesRunOptions {
  readonly timeout?: number;
  readonly bytecode?: boolean;
}

export interface HermesRunResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  /** Combined stdout+stderr as lines (stdout only when the run succeeded or
   *  timed out). Kept for `src/cli.ts`'s VM-vs-VM `equiv` compare, where
   *  both sides are the same engine and the crash text is comparable. */
  readonly lines: readonly string[];
  readonly raw: string;
  readonly status?: number | null;
  /** The two channels kept apart — `print()` goes to stdout, an uncaught
   *  error's `Uncaught <Name>: <message>` report to stderr. A cross-engine
   *  comparison (`ladder.ts`) needs them apart: see `hermesPrintProjection`. */
  readonly stdout: string;
  readonly stderr: string;
}

function splitLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Run a .js or .hbc under the Hermes VM and return its combined output as a
 * line trace. Hermes has no injectable prelude for the `-b` path (the driver
 * rejects mixing a source file and a bytecode file: "Multiple files must use
 * CommonJS modules"), so this oracle observes only what the program prints
 * plus its terminating error — a weaker but engine-faithful trace (§3.2).
 */
export function runHermes(vmPath: string, file: string, opts: HermesRunOptions = {}): HermesRunResult {
  const timeout = opts.timeout ?? 10000;
  const isHbc = opts.bytecode ?? file.endsWith(".hbc");
  const args = isHbc ? ["-b", file] : [file];
  try {
    const out = execFileSync(vmPath, args, {
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, timedOut: false, lines: splitLines(out), raw: out, stdout: out, stderr: "" };
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; status?: number | null };
    if (err.killed === true) return { ok: false, timedOut: true, lines: splitLines(err.stdout ?? ""), raw: err.stdout ?? "", stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    const raw = (err.stdout ?? "") + (err.stderr ?? "");
    return { ok: false, timedOut: false, lines: splitLines(raw), raw, status: err.status ?? null, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

/**
 * Speed fix (npm-test-gate-speed, 2026-08-31): the async twin of `runHermes`,
 * for the one call site — `ladder.ts`'s trace oracle — that runs inside
 * `tiers.ts`'s `pool()`. `execFileSync` blocks Node's single event loop for
 * its entire timeout window, which serialised the whole worker pool: with
 * `pool()`'s concurrency at `cpus - 1`, only one of those N "concurrent"
 * fixtures actually made progress at a time the instant any one of them hit
 * this call, because every other pending `runProgram`/`execFile` in the same
 * process stalls too while the thread is blocked in a synchronous syscall.
 * `execFile` (async, callback-based) never blocks the loop, so the pool's
 * concurrency is real again. Same signature/return shape as `runHermes`;
 * `runHermes` itself is untouched (`src/cli.ts` and two `tests/gate/**`
 * files call it directly, outside the pooled hot path, and are out of this
 * task's owned surface).
 */
export function runHermesAsync(vmPath: string, file: string, opts: HermesRunOptions = {}): Promise<HermesRunResult> {
  const timeout = opts.timeout ?? 10000;
  const isHbc = opts.bytecode ?? file.endsWith(".hbc");
  const args = isHbc ? ["-b", file] : [file];
  return new Promise((resolve) => {
    execFile(vmPath, args, { timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) {
        resolve({ ok: true, timedOut: false, lines: splitLines(stdout), raw: stdout, stdout, stderr: stderr ?? "" });
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | null };
      if (e.killed === true) {
        resolve({ ok: false, timedOut: true, lines: splitLines(stdout ?? ""), raw: stdout ?? "", stdout: stdout ?? "", stderr: stderr ?? "" });
        return;
      }
      const raw = (stdout ?? "") + (stderr ?? "");
      resolve({ ok: false, timedOut: false, lines: splitLines(raw), raw, status: typeof e.code === "number" ? e.code : null, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * The *name* of the uncaught error a Hermes run died with, or `null` when it
 * didn't die that way. Hermes reports an uncaught throw on stderr as
 * `Uncaught <Error.prototype.toString()>` followed by its own stack frames —
 * `Uncaught TypeError: Cannot read property 'x' of null` — and a thrown
 * non-Error as `Uncaught <String(value)>` (`Uncaught 42`,
 * `Uncaught [object Object]`), which maps onto `trace.ts`'s `errShape`
 * convention of `"Thrown"` for non-object throws. An unhandled promise
 * rejection prints nothing and exits 0 under the bare VM, so it is not an
 * uncaught error here — nor is it on the Node side, where it is a separate
 * `unhandled` record outside the print projection.
 *
 * Name only, never the message: the message wording is each engine's own
 * (V8: "Cannot read properties of null (reading 'x')"), which is exactly why
 * docs/EQUIVALENCE.md's `--relax error-messages` exists. Comparing the two
 * engines' wording would fail every legitimately-crashing program.
 */
export function uncaughtErrorName(stderr: string): string | null {
  const first = stderr.split("\n").find((l) => l.length > 0);
  if (first === undefined || !first.startsWith("Uncaught ")) return null;
  const rest = first.slice("Uncaught ".length);
  const m = /^([A-Za-z_$][\w$]*)(?::|$)/.exec(rest);
  return m !== null ? m[1]! : "Thrown";
}

/**
 * The print projection of a Hermes run — what a candidate's own
 * `printProjection` (trace.ts) is compared against in the D14 cross-check.
 * stdout lines (every `print()`), then `uncaught <Name>` when the program
 * died of an uncaught throw. Both sides project the same way, so a program
 * that legitimately throws (adversarial/36-optional-chaining-sideeffect —
 * `null.method?.()` is a TypeError by spec) compares PASS when the candidate
 * throws the same error type at the same point in its output, and DIVERGENT
 * when it doesn't throw or throws something else (CONSOLIDATION 25).
 */
export function hermesPrintProjection(r: HermesRunResult): readonly string[] {
  const name = uncaughtErrorName(r.stderr);
  return name === null ? splitLines(r.stdout) : [...splitLines(r.stdout), `uncaught ${name}`];
}

/** The `print`-channel projection of a sandbox trace — see trace.ts's
 *  `printLines`, kept here too for parity with the PoC's module shape. */
export { printLines } from "./trace.ts";
