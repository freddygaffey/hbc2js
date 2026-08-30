// docs/specs/00-project-skeleton.md §7.3 — hermes-dec oracles.
// Reading hermes-dec's stdout is allowed; reading its source is forbidden (D4/R6).
import { spawnSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { existsSync } from "node:fs";
import type { TestContext } from "node:test";
import { requireOracles } from "./tiers.ts";

export type OracleName = "hbc-file-parser" | "hbc-disassembler";

export function findOracle(name: OracleName): string | null {
  const override = process.env["HERMES_DEC_BIN_DIR"];
  if (override !== undefined) {
    const guess = join(override, name);
    if (existsSync(guess)) return guess;
  }
  const pathEnv = process.env["PATH"] ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir === "") continue;
    const guess = join(dir, name);
    if (existsSync(guess)) return guess;
  }
  return null;
}

export function requireOracle(t: TestContext, name: OracleName): string | null {
  const bin = findOracle(name);
  if (bin === null) {
    const msg = `${name} not found on PATH (pip install hermes-dec==0.1.7)`;
    if (requireOracles()) throw new Error(msg);
    t.skip(msg);
    return null;
  }
  return bin;
}

export function runOracle(bin: string, args: readonly string[]): { status: number; stdout: string } {
  const result = spawnSync(bin, args, { shell: false, encoding: "utf8", maxBuffer: 1024 * 1024 * 256 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}
