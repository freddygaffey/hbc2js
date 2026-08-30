// docs/specs/06-harness.md §7 — tier runners (D13, D16). A runner takes a
// "decompiler" function as a parameter so M4 can plug in a real one; until
// then `identityDecompiler` uses the fixture's own `source.js` as the
// candidate, which lets the gate tier prove the harness itself (identity
// must PASS everything; a mutated candidate must DIVERGE).
import { readdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join } from "node:path";
import { repoRoot } from "../util/paths.ts";
import { chooseReference } from "./reference-policy.ts";
import type { FixtureRef } from "./reference-policy.ts";
import { runOracleLadder, VERDICT } from "./ladder.ts";
import type { CheckResult, OracleName, Verdict } from "./ladder.ts";
import { hbcVersion } from "./hermes-vm.ts";
import { decompile } from "../decompile.ts";

export type Tier = "gate" | "sweep" | "hardened" | "local-corpus";

export interface DecompilerInput {
  readonly hbcBytes: Uint8Array;
  readonly version: number;
  readonly fixtureName: string;
  /** The fixture's hand-written source, when one exists (D16 C1). */
  readonly sourceJs?: string | undefined;
}

export type DecompilerFn = (input: DecompilerInput) => string;

/** M3's stand-in for M4: the candidate *is* the original source. Every gate
 *  oracle must PASS under this decompiler — if it doesn't, the harness (not
 *  a decompiler that doesn't exist yet) has a bug. */
export const identityDecompiler: DecompilerFn = (input) => {
  if (input.sourceJs === undefined) {
    throw new Error(`identityDecompiler: fixture "${input.fixtureName}" has no source.js to use as the identity candidate`);
  }
  return input.sourceJs;
};

/**
 * The real thing (review M4-H1). `runTier`'s *default* stays
 * `identityDecompiler` — that is the harness's own self-test — but every
 * caller that means "score the decompiler" passes this: `hbc2js gate`,
 * `hbc2js sweep`, and the gate's own equivalence test.
 *
 * `resolveV98Ambiguity` is the caller making D8's choice explicitly for the
 * eight `KNOWN_AMBIGUOUS_V98` fixtures; it is reported as
 * `W_FORCED_OPCODE_TABLE`, never guessed by the parser.
 */
export const hbc2jsDecompiler: DecompilerFn = (input) => decompile(input.hbcBytes, { resolveV98Ambiguity: true, moduleName: input.fixtureName }).code;

/** A negative control: same source, run through a single deterministic
 *  control-flow mutation. Used by the gate self-test (spec 06 §9's "gate
 *  must PASS all on identity and DIVERGENT on every control-flow mutation")
 *  — not registered as the tier's normal decompiler, but exported so tests
 *  can build one from `mutate.ts`'s operators directly. See
 *  tests/gate/harness/selftest.test.ts.
 */

interface TierInput {
  readonly fixtureName: string;
  /** The construct name with no `.min`/`.obf` suffix — what
   *  reference-policy.ts's known-divergence table is keyed on. Equal to
   *  `fixtureName` for every group except `constructs`' variant discovery. */
  readonly baseName: string;
  readonly group: "constructs" | "hermes-dec-sample" | "bundles" | "local-corpus";
  readonly dir: string;
  readonly sourcePath: string | null;
  readonly version: number;
  readonly hbcPath: string;
  readonly embeddedFilename: string;
}

const FIXTURE_VERSIONS: readonly number[] = [84, 94, 96, 98, 99];

function fixturesRoot(): string {
  return join(repoRoot(), "tests", "fixtures");
}

function readVersionsTxt(dir: string): Map<number, string> {
  const failed = new Map<number, string>();
  try {
    const text = readFileSync(join(dir, "versions.txt"), "utf8");
    for (const line of text.split("\n")) {
      const m = /^v(\d+):\s*FAILS\s*-\s*(.*)$/.exec(line.trim());
      if (m !== null) failed.set(Number(m[1]), m[2] ?? "documented compile failure");
    }
  } catch {
    // no versions.txt: every fetched hermesc version is expected to compile.
  }
  return failed;
}

/** Every (fixture, version) pair spec 06 §7 calls "skipped-by-design": a
 *  documented `versions.txt` entry, not a harness INCONCLUSIVE. */
export function computeSkippedByDesign(): SkippedByDesign[] {
  const out: SkippedByDesign[] = [];
  const constructsDir = join(fixturesRoot(), "constructs");
  let entries: string[] = [];
  try {
    entries = readdirSync(constructsDir);
  } catch {
    return out;
  }
  for (const name of entries.sort()) {
    const dir = join(constructsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    for (const [version, reason] of readVersionsTxt(dir)) {
      out.push({ fixture: name, version, reason });
    }
  }
  return out;
}

/** `constructs/*` + `hermes-dec-sample` (gate) or their `.obf.hbc` variants
 *  (hardened). `.min.hbc` variants are gate inputs too (§7's "minified
 *  variants belong in the gate: they are a control"). */
function discoverConstructInputs(variant: "" | ".min" | ".obf"): TierInput[] {
  const out: TierInput[] = [];
  const constructsDir = join(fixturesRoot(), "constructs");
  let entries: string[] = [];
  try {
    entries = readdirSync(constructsDir);
  } catch {
    return out;
  }
  // tests/fixtures/build.sh compiles each variant under its own basename
  // (source.js / source.obf.js / source.min.js) and that basename is the
  // embedded filename (spec 06 §6's second prerequisite: "compiled with a
  // matching relative filename"). The variant's own basename is also its own
  // behaviourally-equivalent-by-construction source for trace comparison
  // (D16 C2) — using plain source.js there would compare a minified/
  // obfuscated bytecode's trace against the *unminified* file's identity
  // candidate, which is a spurious round-trip mismatch, not a real one.
  const basename = variant === ".min" ? "source.min.js" : variant === ".obf" ? "source.obf.js" : "source.js";
  const fixtureSuffix = variant === "" ? "" : variant;
  for (const name of entries.sort()) {
    const dir = join(constructsDir, name);
    if (!statSync(dir).isDirectory()) continue;
    const sourcePath = join(dir, basename);
    const failedVersions = readVersionsTxt(dir); // Map<version, reason>
    for (const version of FIXTURE_VERSIONS) {
      const hbcPath = join(dir, `v${version}${variant}.hbc`);
      if (failedVersions.has(version)) continue; // documented, skipped-by-design
      try {
        statSync(hbcPath);
        statSync(sourcePath);
      } catch {
        continue;
      }
      out.push({ fixtureName: `${name}${fixtureSuffix}`, baseName: name, group: "constructs", dir, sourcePath, version, hbcPath, embeddedFilename: basename });
    }
  }
  return out;
}

function discoverHermesDecSample(): TierInput[] {
  const dir = join(fixturesRoot(), "hermes-dec-sample");
  const out: TierInput[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  const sourcePath = join(dir, "source.js");
  for (const entry of entries) {
    const m = /^v(\d+)(-public)?\.hbc$/.exec(entry);
    if (m === null) continue;
    out.push({ fixtureName: "hermes-dec-sample", baseName: "hermes-dec-sample", group: "hermes-dec-sample", dir, sourcePath, version: Number(m[1]), hbcPath: join(dir, entry), embeddedFilename: "source.js" });
  }
  return out;
}

function discoverBundles(): TierInput[] {
  const bundlesDir = join(fixturesRoot(), "bundles");
  const out: TierInput[] = [];
  let apps: string[] = [];
  try {
    apps = readdirSync(bundlesDir);
  } catch {
    return out;
  }
  for (const app of apps) {
    const appDir = join(bundlesDir, app);
    if (!statSync(appDir).isDirectory()) continue;
    for (const entry of walk(appDir)) {
      if (!entry.endsWith(".hbc")) continue;
      // Bundles carry no hand-written source.js (D16 C3): round-trip + syntax
      // only, per §7's table.
      let version: number;
      try {
        version = hbcVersion(entry);
      } catch {
        continue;
      }
      const bundleName = `${app}/${entry.slice(appDir.length + 1)}`;
      out.push({ fixtureName: bundleName, baseName: bundleName, group: "bundles", dir: appDir, sourcePath: null, version, hbcPath: entry, embeddedFilename: "index.js" });
    }
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function discoverLocalCorpus(): TierInput[] {
  const dir = join(fixturesRoot(), "local-corpus");
  const out: TierInput[] = [];
  for (const p of walk(dir)) {
    if (!p.endsWith(".hbc")) continue;
    let version: number;
    try {
      version = hbcVersion(p);
    } catch {
      continue;
    }
    const corpusName = p.slice(dir.length + 1);
    out.push({ fixtureName: corpusName, baseName: corpusName, group: "local-corpus", dir, sourcePath: null, version, hbcPath: p, embeddedFilename: "index.js" });
  }
  return out;
}

function inputsForTier(tier: Tier): TierInput[] {
  if (tier === "gate") return [...discoverConstructInputs(""), ...discoverConstructInputs(".min"), ...discoverHermesDecSample()];
  if (tier === "hardened") return discoverConstructInputs(".obf");
  if (tier === "sweep") return discoverBundles();
  return discoverLocalCorpus();
}

/** D16's per-tier oracle set, before `RunnerOptions.oracles` overrides it. */
/**
 * The identity decompiler must PASS every oracle there is — that is the whole
 * point of it, so the gate's self-test runs all four. A *real* decompiler's
 * baseline oracle set is `syntax + trace` (docs/STATUS.md M4): `roundtrip`
 * reports the unavoidable function-count difference (helper prelude + module
 * wrapper) as DIVERGENT, and `fuzz` reports V8-vs-Hermes TypeError *message
 * text* built from source identifiers a register-named baseline cannot have.
 * Both stay reachable with an explicit `oracles` / `--oracles`.
 */
function defaultOraclesForTier(tier: Tier, identity: boolean): readonly OracleName[] {
  if (tier === "gate") return identity ? ["syntax", "trace", "fuzz", "roundtrip"] : ["syntax", "trace"];
  if (tier === "hardened") return ["syntax", "trace"];
  return ["syntax", "roundtrip"]; // sweep, local-corpus: no source to trace against
}

export interface RunnerOptions {
  readonly tier: Tier;
  readonly versions?: readonly number[];
  readonly oracles?: readonly OracleName[];
  readonly seeds?: number;
  /** Passed straight through to the ladder's trace comparison (spec 06 §5). */
  readonly relax?: readonly string[];
  readonly budgets?: { readonly timeoutMs?: number; readonly maxRecords?: number };
  readonly concurrency?: number;
  readonly decompiler?: DecompilerFn;
  /** Restrict to these fixture names (by TierInput.fixtureName) — the "3
   *  fixture subset in unit tests" spec 06 §11 item 4 asks for. */
  readonly only?: readonly string[];
}

export interface SkippedByDesign {
  readonly fixture: string;
  readonly version: number;
  readonly reason: string;
}

export interface TierSummary {
  readonly pass: number;
  readonly divergent: number;
  readonly inconclusive: number;
  readonly error: number;
}

export interface TierReport {
  readonly tier: Tier;
  readonly results: readonly CheckResult[];
  readonly skippedByDesign: readonly SkippedByDesign[];
  readonly summary: TierSummary;
}

async function pool<T, R>(items: readonly T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      for (;;) {
        const j = i++;
        if (j >= items.length) return;
        out[j] = await fn(items[j]!);
      }
    }),
  );
  return out;
}

export async function runTier(o: RunnerOptions): Promise<TierReport> {
  const decompiler = o.decompiler ?? identityDecompiler;
  const oracles = o.oracles ?? defaultOraclesForTier(o.tier, decompiler === identityDecompiler);
  const versions = o.versions;
  const concurrency = o.concurrency ?? Math.max(1, os.cpus().length - 1);

  let inputs = inputsForTier(o.tier);
  if (versions !== undefined) inputs = inputs.filter((i) => versions.includes(i.version));
  if (o.only !== undefined) inputs = inputs.filter((i) => o.only!.includes(i.fixtureName));

  // D16: local-corpus is gitignored and often simply absent on a given
  // machine — that must never read as a trivial "0/0 pass".
  if (o.tier === "local-corpus" && inputs.length === 0) {
    const fixture: FixtureRef = { name: "local-corpus" };
    const result: CheckResult = {
      fixture,
      verdict: VERDICT.INCONCLUSIVE,
      oracles: [{ oracle: "syntax", verdict: VERDICT.INCONCLUSIVE, detail: "tests/fixtures/local-corpus/ is empty or absent (gitignored, D16 C5) — never skipped-as-pass", ms: 0 }],
      reference: chooseReference(fixture, 84),
      budgets: { timeoutMs: o.budgets?.timeoutMs ?? 5000, elapsedMs: 0, recordCap: o.budgets?.maxRecords ?? 20000 },
      caveats: [],
    };
    return { tier: o.tier, results: [result], skippedByDesign: [], summary: { pass: 0, divergent: 0, inconclusive: 1, error: 0 } };
  }

  const results = await pool(inputs, concurrency, async (input): Promise<CheckResult> => {
    const hbcBytes = new Uint8Array(readFileSync(input.hbcPath));
    const sourceJs = input.sourcePath !== null ? readFileSync(input.sourcePath, "utf8") : undefined;
    const fixture: FixtureRef = { name: input.fixtureName };
    const reference = chooseReference({ name: input.baseName }, input.version);

    // No source (D16 C3/C5's bundles/local-corpus) and still the default
    // identity stand-in: there is no real decompiler yet (M4), so there is no
    // candidate to run oracles against at all. That is expected, not a
    // decompiler bug — report it as INCONCLUSIVE, not ERROR, so a sweep run
    // reads correctly until a real `decompiler` is plugged in.
    if (sourceJs === undefined && decompiler === identityDecompiler) {
      return {
        fixture,
        verdict: VERDICT.INCONCLUSIVE,
        oracles: [{ oracle: "syntax", verdict: VERDICT.INCONCLUSIVE, detail: "no decompiler plugged in yet (M4) and no hand-written source to stand in for one — nothing to check", ms: 0 }],
        reference,
        budgets: { timeoutMs: o.budgets?.timeoutMs ?? 5000, elapsedMs: 0, recordCap: o.budgets?.maxRecords ?? 20000 },
        caveats: [],
      };
    }

    let candidateJs: string;
    try {
      candidateJs = decompiler({ hbcBytes, version: input.version, fixtureName: input.fixtureName, sourceJs });
    } catch (e) {
      return {
        fixture,
        verdict: VERDICT.ERROR,
        oracles: [{ oracle: "syntax", verdict: VERDICT.ERROR, detail: `decompiler threw: ${e instanceof Error ? e.message : String(e)}`, ms: 0 }],
        reference,
        budgets: { timeoutMs: o.budgets?.timeoutMs ?? 5000, elapsedMs: 0, recordCap: o.budgets?.maxRecords ?? 20000 },
        caveats: [],
      };
    }

    const dir = mkdtempSync(join(tmpdir(), "hbc2js-tier-"));
    const candidatePath = join(dir, "candidate.js");
    writeFileSync(candidatePath, candidateJs);
    try {
      return await runOracleLadder({
        fixture,
        candidateJsPath: candidatePath,
        sourceJsPath: input.sourcePath ?? undefined,
        reference,
        hbcBytes,
        hbcVersion: input.version,
        embeddedFilename: input.embeddedFilename,
        oracles,
        seed: 0,
        fuzz: 50,
        ...(o.relax !== undefined ? { relax: o.relax } : {}),
        timeoutMs: o.budgets?.timeoutMs ?? 8000,
        maxRecords: o.budgets?.maxRecords ?? 20000,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const mutableSummary = { pass: 0, divergent: 0, inconclusive: 0, error: 0 };
  for (const r of results) {
    if (r.verdict === VERDICT.PASS) mutableSummary.pass++;
    else if (r.verdict === VERDICT.DIVERGENT) mutableSummary.divergent++;
    else if (r.verdict === VERDICT.INCONCLUSIVE) mutableSummary.inconclusive++;
    else mutableSummary.error++;
  }
  const summary: TierSummary = mutableSummary;
  const skippedByDesign = o.tier === "gate" || o.tier === "hardened" ? computeSkippedByDesign() : [];

  return { tier: o.tier, results, skippedByDesign, summary };
}

export { VERDICT };
export type { CheckResult, Verdict, OracleName };
