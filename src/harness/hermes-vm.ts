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
import { execFileSync } from "node:child_process";
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
  readonly lines: readonly string[];
  readonly raw: string;
  readonly status?: number | null;
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
    return { ok: true, timedOut: false, lines: splitLines(out), raw: out };
  } catch (e) {
    const err = e as { killed?: boolean; stdout?: string; stderr?: string; status?: number | null };
    if (err.killed === true) return { ok: false, timedOut: true, lines: splitLines(err.stdout ?? ""), raw: err.stdout ?? "" };
    const raw = (err.stdout ?? "") + (err.stderr ?? "");
    return { ok: false, timedOut: false, lines: splitLines(raw), raw, status: err.status ?? null };
  }
}

/** The `print`-channel projection of a sandbox trace — see trace.ts's
 *  `printLines`, kept here too for parity with the PoC's module shape. */
export { printLines } from "./trace.ts";
