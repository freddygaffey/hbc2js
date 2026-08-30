// docs/specs/00-project-skeleton.md §2.1, §7.1 — locate a Hermes VM per D14; skip
// helpers. Only matters from M3 on (M1/M2 don't execute bytecode), but the location
// logic is specified here so tests/support/ doesn't move later.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { repoRoot } from "./paths.ts";

export interface HermesVm {
  readonly version: number;
  readonly path: string;
}

const CANDIDATES: readonly { version: number; rel: readonly string[] }[] = [
  { version: 84, rel: ["tools", "hermesc", "v84", "hermes"] },
  { version: 94, rel: ["tools", "hermes-vm", "v94", "bin", "hermes"] },
  { version: 99, rel: ["tools", "hermes-vm", "v99", "bin", "hermes"] },
];

export function findHermesVm(version: number): HermesVm | null {
  const envVar = process.env[`HERMES_VM_V${version}`];
  if (envVar !== undefined && existsSync(envVar)) return { version, path: envVar };
  for (const c of CANDIDATES) {
    if (c.version !== version) continue;
    const guess = join(repoRoot(), ...c.rel);
    if (existsSync(guess)) return { version, path: guess };
  }
  return null;
}

// Unlike hermesc (fetched by `tools/get-hermesc.sh`, which CI always runs and
// which `HBC2JS_REQUIRE_ORACLES=1` is entitled to demand), the source-built
// Hermes VM under `tools/hermes-vm/` is never provisioned by any workflow —
// `tools/build-hermes-vm.sh` is a from-source cmake build documented in
// docs/TOOLCHAIN.md as local-only. So a missing VM always skips as
// INCONCLUSIVE, even under HBC2JS_REQUIRE_ORACLES=1 — same convention as
// `findHermesVm` callers in tests/gate/harness/reference-policy.test.ts.
export function requireHermesVm(t: TestContext, version: number): HermesVm | null {
  const vm = findHermesVm(version);
  if (vm === null) {
    t.skip(`no Hermes VM for v${version} (see docs/TOOLCHAIN.md "Hermes VM (source build)")`);
    return null;
  }
  return vm;
}
