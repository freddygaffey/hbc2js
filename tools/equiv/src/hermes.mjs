// Hermes-VM execution oracle.
//
// Running the *original .hbc* under the Hermes VM and the decompiled .js under
// the same VM removes Node-vs-Hermes semantic drift from the comparison
// entirely. That drift is real and measurable — see docs/EQUIVALENCE.md §5.
//
// Availability is the catch: of the packages `tools/get-hermesc.sh` fetches,
// only `hermes-engine-cli` ships a `hermes` interpreter, and the VM refuses any
// bytecode whose version is not exactly its own:
//
//   $ tools/hermesc/v84/hermes -b v94.hbc
//   Error deserializing bytecode: Wrong bytecode version. Expected 84 but got 94
//
// So this oracle covers HBC <= 89 today and needs a source build of Hermes for
// v94/v99.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// HBC header: 8-byte magic, then the format version as a LE uint32 at offset 8.
export function hbcVersion(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    return buf.readUInt32LE(8);
  } finally {
    fs.closeSync(fd);
  }
}

// Locate `hermes` binaries alongside the fetched `hermesc`s and label each with
// the bytecode version it accepts, probed by compiling a trivial program.
export function findHermesVMs(root) {
  const dir = path.join(root, 'tools', 'hermesc');
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const e of entries.sort()) {
    const vm = path.join(dir, e, 'hermes');
    if (!fs.existsSync(vm)) continue;
    let version = null;
    const m = /^v(\d+)$/.exec(e);
    if (m) version = Number(m[1]);
    found.push({ path: vm, version, dir: e });
  }
  return found;
}

export function pickHermesVM(root, wantVersion) {
  return findHermesVMs(root).find((h) => h.version === wantVersion) ?? null;
}

// Run a .js or .hbc under the Hermes VM and return its combined output as a
// line trace. Hermes has no injectable prelude for the `-b` path (the driver
// rejects mixing a source file and a bytecode file: "Multiple files must use
// CommonJS modules"), so this oracle observes only what the program prints plus
// its terminating error — a weaker but engine-faithful trace.
export function runHermes(vmPath, file, { timeout = 10000, bytecode = null } = {}) {
  const isHbc = bytecode ?? file.endsWith('.hbc');
  const args = isHbc ? ['-b', file] : [file];
  try {
    const out = execFileSync(vmPath, args, {
      timeout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, lines: splitLines(out), raw: out };
  } catch (e) {
    if (e.killed) return { ok: false, timedOut: true, lines: splitLines(e.stdout ?? ''), raw: e.stdout ?? '' };
    const raw = (e.stdout ?? '') + (e.stderr ?? '');
    return { ok: false, lines: splitLines(raw), raw, status: e.status };
  }
}

function splitLines(s) {
  const lines = s.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// The `print`-channel projection of a sandbox trace, which is what a Hermes run
// can be compared against.
export function printLines(records) {
  return records.filter((r) => r.k === 'out' && (r.ch === 'print' || r.ch === '__trace')).map((r) => r.s);
}
