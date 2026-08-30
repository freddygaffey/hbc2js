// Shared helpers for the M4 (cfg / structure / emit / decompile) test files.
// Read-only over tests/fixtures/, like tests/support/fixtures.ts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.ts";
import { parseHbc } from "../../src/parse/module.ts";
import type { HbcModule } from "../../src/parse/types.ts";
import { ErrorCode, Hbc2jsError } from "../../src/errors.ts";

export interface M4Binary {
  readonly fixture: string; // "23-generator-basic"
  readonly group: "constructs" | "hermes-dec-sample";
  readonly version: number;
  readonly variant: "" | ".min" | ".obf";
  readonly path: string;
}

const VERSIONS = [84, 94, 96, 98, 99];

/** Every `.hbc` of the construct corpus plus `hermes-dec-sample`, sorted. */
export function m4Binaries(variants: readonly ("" | ".min" | ".obf")[] = [""]): M4Binary[] {
  const out: M4Binary[] = [];
  const constructs = join(repoRoot(), "tests", "fixtures", "constructs");
  for (const name of readdirSync(constructs).sort()) {
    const dir = join(constructs, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const version of VERSIONS) {
      for (const variant of variants) {
        const path = join(dir, `v${version}${variant}.hbc`);
        try {
          statSync(path);
        } catch {
          continue;
        }
        out.push({ fixture: name, group: "constructs", version, variant, path });
      }
    }
  }
  if (variants.includes("")) {
    const dir = join(repoRoot(), "tests", "fixtures", "hermes-dec-sample");
    for (const entry of readdirSync(dir).sort()) {
      const m = /^v(\d+)\.hbc$/.exec(entry);
      if (m === null) continue;
      out.push({ fixture: "hermes-dec-sample", group: "hermes-dec-sample", version: Number(m[1]), variant: "", path: join(dir, entry) });
    }
  }
  return out;
}

/**
 * Parse with the auto-probe, falling back to `hbc98-late` for the eight
 * `KNOWN_AMBIGUOUS_V98` construct fixtures. `tests/support/known-issues.ts`
 * records the external evidence that hbc98-late is the right table for all of
 * them; D8 forbids the *library* from guessing, so the choice is made here, in
 * the caller, and reported.
 */
export function parseM4(bytes: Uint8Array): { readonly module: HbcModule; readonly forcedTable: boolean } {
  try {
    return { module: parseHbc(bytes), forcedTable: false };
  } catch (e) {
    if (e instanceof Hbc2jsError && e.code === ErrorCode.E_LAYOUT_AMBIGUOUS) {
      return { module: parseHbc(bytes, { opcodeTable: "hbc98-late" }), forcedTable: true };
    }
    throw e;
  }
}

export function readBinary(b: M4Binary): Uint8Array {
  return new Uint8Array(readFileSync(b.path));
}
