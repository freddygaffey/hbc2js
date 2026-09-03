// docs/specs/00-project-skeleton.md §7.1 — fixture discovery. Read-only: never
// creates, deletes or recompiles anything under tests/fixtures/.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./paths.ts";
import { readBytes } from "./bytes.ts";

export type FixtureVersion = 84 | 94 | 96 | 98 | 99;

export interface FixtureBinary {
  readonly version: FixtureVersion;
  readonly variant: "" | "public";
  readonly path: string;
  readonly bytes: () => Uint8Array;
  readonly reproducible: boolean;
}

export interface Fixture {
  readonly group: string;
  readonly name: string;
  readonly dir: string;
  readonly sourcePath: string;
  readonly expectedPath: string | null;
  readonly binaries: readonly FixtureBinary[];
}

const FIXTURES_ROOT = () => join(repoRoot(), "tests", "fixtures");

const BINARY_RE = /^v(\d+)(-public)?(\.obf|\.min)?\.hbc$/;

// docs/specs/00-project-skeleton.md §7.1: `reproducible` is false exactly for these
// two preserved historical originals.
const NOT_REPRODUCIBLE = new Set(["hermes-dec-sample/v94.hbc", "hermes-dec-sample/v99.hbc"]);

function discoverBinaries(dir: string, group: string, _name: string): FixtureBinary[] {
  const out: FixtureBinary[] = [];
  for (const entry of readdirSync(dir)) {
    const m = BINARY_RE.exec(entry);
    if (m === null) continue;
    if (m[3] !== undefined) continue; // .obf.hbc / .min.hbc are variants, not base binaries
    const version = Number(m[1]) as FixtureVersion;
    const variant: "" | "public" = m[2] !== undefined ? "public" : "";
    const path = join(dir, entry);
    // §7.1: keyed as "<group>/<entry>" — only hermes-dec-sample/ has NOT_REPRODUCIBLE
    // entries, and it has no per-fixture subdirectory, so this key form is exact.
    const key = `${group}/${entry}`;
    out.push({ version, variant, path, bytes: () => readBytes(path), reproducible: !NOT_REPRODUCIBLE.has(key) });
  }
  return out;
}

function sortFixtures(fixtures: Fixture[]): Fixture[] {
  return fixtures
    .slice()
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => ({
      ...f,
      binaries: f.binaries.slice().sort((a, b) => a.version - b.version || (a.variant < b.variant ? -1 : a.variant > b.variant ? 1 : 0)),
    }));
}

let cache: readonly Fixture[] | undefined;

function discoverAll(): readonly Fixture[] {
  if (cache !== undefined) return cache;
  const root = FIXTURES_ROOT();
  const fixtures: Fixture[] = [];

  // constructs/<NN-topic>/
  const constructsDir = join(root, "constructs");
  for (const entry of readdirSync(constructsDir)) {
    const dir = join(constructsDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const expectedPath = join(dir, "expected.txt");
    fixtures.push({
      group: "constructs",
      name: entry,
      dir,
      sourcePath: join(dir, "source.js"),
      expectedPath: statSync(expectedPath, { throwIfNoEntry: false }) !== undefined ? expectedPath : null,
      binaries: discoverBinaries(dir, "constructs", entry),
    });
  }

  // hermes-dec-sample/ (single fixture, no sub-name)
  const sampleDir = join(root, "hermes-dec-sample");
  fixtures.push({
    group: "hermes-dec-sample",
    name: "hermes-dec-sample",
    dir: sampleDir,
    sourcePath: join(sampleDir, "source.js"),
    expectedPath: null,
    binaries: discoverBinaries(sampleDir, "hermes-dec-sample", ""),
  });

  cache = sortFixtures(fixtures);
  return cache;
}

export function listFixtures(filter?: { group?: string; version?: number }): readonly Fixture[] {
  let all = discoverAll();
  if (filter?.group !== undefined) all = all.filter((f) => f.group === filter.group);
  if (filter?.version !== undefined) {
    all = all
      .map((f) => ({ ...f, binaries: f.binaries.filter((b) => b.version === filter.version) }))
      .filter((f) => f.binaries.length > 0);
  }
  return all;
}

/** C3 bundle inputs (sweep tier). Separate call so a gate test cannot pull in
 *  megabytes by accident. Never returned by listFixtures(). */
export function listBundles(): readonly FixtureBinary[] {
  const bundlesDir = join(FIXTURES_ROOT(), "bundles");
  const out: FixtureBinary[] = [];
  let entries: string[];
  try {
    entries = readdirSync(bundlesDir);
  } catch {
    return [];
  }
  for (const appDir of entries) {
    const dir = join(bundlesDir, appDir);
    if (!statSync(dir).isDirectory()) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".hbc")) continue;
      const path = join(dir, entry);
      out.push({ version: 94, variant: "", path, bytes: () => readBytes(path), reproducible: true });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function fixture(group: string, name: string): Fixture {
  const found = discoverAll().find((f) => f.group === group && f.name === name);
  if (found === undefined) throw new Error(`fixture not found: ${group}/${name}`);
  return found;
}

/** `tests/fixtures/bundles/rn-template-0.72/index.android.hbc` — one path
 *  literal instead of the same `join(repoRoot(), ...)` hand-rolled in a
 *  dozen test files (sweep 2026-09-03 finding 2). */
export function rnTemplatePath(): string {
  return join(FIXTURES_ROOT(), "bundles", "rn-template-0.72", "index.android.hbc");
}

/** `readBytes`-cached (per-process) bytes of the RN template bundle. Callers
 *  that need cross-process reuse of the *decompile*, not just the bytes,
 *  want `tests/support/decompiled.ts`'s `cachedSplitProject`/`cachedDecompile`
 *  instead. */
export function rnTemplateBytes(): Uint8Array {
  return readBytes(rnTemplatePath());
}
