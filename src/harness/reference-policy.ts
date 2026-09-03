// docs/specs/06-harness.md §4 — reference policy: which engine is the truth
// (D14). The single most consequential piece of configuration in the
// project; see that spec section for the full derivation this implements.
//
// Rules, in order:
//   1. A matching Hermes VM exists -> "hermes-vm", running the fixture's own
//      .hbc. This is the truth (D14): the decompiler must reproduce the
//      bytecode's behaviour, not the source's. No caveat needed — the VM's
//      own behaviour *is* the reference, regardless of whether the construct
//      is independently known to diverge from spec/Node.
//   2. No matching VM, fixture is not a known-divergence construct -> the
//      committed Node-captured `expected.txt`.
//   3. No matching VM, fixture *is* a known-divergence construct -> still
//      `expected.txt`, but flagged with a caveat (PASS-with-caveat, counted
//      separately) — whether or not the divergence has actually been
//      *measured* at this exact HBC version (96 and 98 have no VM to measure
//      with; the construct is still known-divergent by name, so guessing
//      "probably still diverges" and flagging it is safer than guessing
//      "probably fine" silently).
//
// HA-06's throw is reserved for the one case rule 2/3 cannot cover safely: a
// completely unrecognised HBC version for a fixture that is *not* one of the
// known-divergence constructs. There, the policy has no basis at all for
// "expected.txt is fine here" and refuses to guess, rather than silently
// assuming the v84 answer for a version nobody has looked at.
import { findHermesVm } from "./hermes-vm.ts";
import type { HermesVm } from "./hermes-vm.ts";

export interface FixtureRef {
  readonly name: string;
}

export type ReferenceEngine = "hermes-vm" | "expected-txt" | "node-source";

export interface ReferenceChoice {
  readonly engine: ReferenceEngine;
  readonly reason: string;
  readonly vm?: HermesVm;
  /**
   * Constructs known to diverge between Hermes and the spec/Node.
   * When `engine` is `"expected-txt"`, non-empty exactly means this choice
   * itself carries a PASS-with-caveat. When `engine` is `"hermes-vm"`, it is
   * purely informational (the VM's own behaviour needs no excuse — it *is*
   * the reference) but is still populated for a known-divergence construct,
   * so a caller comparing a spec-following program against this VM's trace
   * can tell a real mismatch apart from this fixture's documented one.
   */
  readonly knownDivergences: readonly string[];
}

/**
 * HBC versions this project has an opinion about at all. A version outside
 * this set is "unmeasured" for the purposes of HA-06: the policy will not
 * silently assume default (non-divergent) behaviour for it.
 *
 * 89 is included even though no fixture binary exists at that version: D14's
 * original measurement covered 84 and 89 under hermes-engine-cli, and the
 * table below carries that row forward.
 */
export const KNOWN_VERSIONS: readonly number[] = [84, 89, 94, 96, 98, 99];

type Measurement = "diverges" | "matches-spec";

/**
 * The known-divergence set (docs/EQUIVALENCE.md §5.2, tests/fixtures/README.md
 * "Sanity-checking: Hermes VM (v84) vs. Node"), keyed by fixture name and then
 * by HBC version. Measured at 84 and 89 originally; confirmed unchanged at 94
 * and 99 by `docs/AGENT-LOG.md`'s `tools/build-hermes-vm.sh` entry (ten
 * fixtures including all four of these, run under both new VMs against
 * `expected.txt`). 96 and 98 have no VM to measure with — their absence from
 * a fixture's version map is deliberate, not an oversight; `chooseReference`
 * still applies rule 3 to them because the fixture is named here at all.
 *
 * This table is machine-readable data, not prose (spec 06 §4): it is the fix
 * for docs/EQUIVALENCE.md §9 item 2, "without this the harness reports 4
 * permanent false failures".
 */
const MEASURED_AT_ALL_FOUR: Readonly<Record<number, Measurement>> = {
  84: "diverges",
  89: "diverges",
  94: "diverges",
  99: "diverges",
  // 96, 98: deliberately absent — unmeasured (no VM built/available).
};

/**
 * Adversarial-tier (D22a) fixtures, measured directly against
 * `tools/hermes-vm/v94`, `tools/hermesc/v96/hermes`, and
 * `tools/hermes-vm/v99` — the three versions the adversarial corpus is
 * compiled at (docs/AGENT-LOG.md, 2026-08-31 triage of the six
 * Haiku-flagged fixtures). 84/89 are left unmeasured (no adversarial `.hbc`
 * exists at those versions) rather than assumed, unlike
 * `MEASURED_AT_ALL_FOUR` above.
 */
const MEASURED_AT_94_96_99: Readonly<Record<number, Measurement>> = {
  94: "diverges",
  96: "diverges",
  99: "diverges",
};

export const KNOWN_DIVERGENT_FIXTURES: Readonly<Record<string, Readonly<Record<number, Measurement>>>> = {
  "18-closure-loop-let": MEASURED_AT_ALL_FOUR,
  "20-let-const-tdz": MEASURED_AT_ALL_FOUR,
  "42-rest-params": MEASURED_AT_ALL_FOUR,
  "49-arguments-object": MEASURED_AT_ALL_FOUR,
  // Adversarial tier (D22a) — same root cause as 18-closure-loop-let: Hermes
  // shares one binding across `for (let ...)` iterations instead of creating
  // a fresh one per iteration. Verified with the fixture's own v94/v96/v99
  // .hbc under each VM: all three print "let results: 3,3,3", matching the
  // decompiled candidate; only Node's committed expected.txt ("0,1,2", true
  // spec behaviour) differs.
  "06-closure-loop-var-vs-let": MEASURED_AT_94_96_99,
  // Adversarial tier (D22a) — Hermes does not raise a TDZ ReferenceError for
  // `inner` here, even though the access is lexically before its `let`
  // declaration in a scope that shadows an outer binding of the same name;
  // it silently reads `undefined`. Verified with the fixture's own
  // v94/v96/v99 .hbc under each VM: all three print
  // "trace: start|got-inner:undefined|...", matching the decompiled
  // candidate; only Node's committed expected.txt ("error:ReferenceError")
  // differs. This is independent of the this-binding/module-type issue
  // documented in docs/BUGS.md for 28/29 — confirmed by running the
  // fixture's source.js explicitly as CommonJS, where Node still throws the
  // ReferenceError Hermes does not.
  "30-tdz-shadowing": MEASURED_AT_94_96_99,
};

function isKnownDivergentFixture(name: string): boolean {
  return Object.hasOwn(KNOWN_DIVERGENT_FIXTURES, name);
}

/**
 * A different kind of exclusion from `KNOWN_DIVERGENT_FIXTURES`: not a real
 * Hermes-vs-spec semantic finding, but a confirmed *incompleteness of this
 * project's own source-built v99 VM* (`tools/build-hermes-vm.sh 99`, built
 * from the closest publicly-identifiable commit — docs/TOOLCHAIN.md already
 * documents that this build is not byte-identical to either v99 fixture).
 *
 * P-14 (docs/PUSHBACK.md, docs/reports/2026-09-04-toolchain-artifact-
 * investigation.md) root-caused the `_makeAsyncIterator` half of this table
 * to a *compiler/VM commit mismatch*, not a real VM incompleteness: v99
 * fixtures are compiled with `tools/hermesc/v99/hermesc` but this table
 * routed their D14 reference run away from `tools/hermes-vm/v99/bin/hermes`
 * (a different, source-built Hermes commit) entirely, rather than fixing the
 * mismatch. `ladder.ts`'s `matchedCompilerReference` option now recompiles
 * the fixture's own `source.js` with the VM's own sibling `hermesc`
 * (`tools/hermes-vm/v99/bin/hermesc`) for the reference run instead — every
 * real caller (`tiers.ts`'s gate/sweep runner, every `tools/fuzz/*.mjs`
 * script) opts in. Re-verified directly against every fixture this table
 * used to carry for that reason (`27-async-await-basic`,
 * `28-async-await-error`, `29-promise-chaining`, `31-microtask-ordering`,
 * `54-try-catch-finally-shared-range`, plus the adversarial-tier
 * `43-fuzz-async-guard-shared-range` this same mechanism blocked from ever
 * being added here, docs/PUSHBACK.md P-14): all six now PASS through the
 * real `hermes-vm` engine with the matched compiler, so they are removed
 * from this table — the VM was never actually broken for them.
 *
 * `07-for-of-iterable` stays: re-verified with the matched compiler too, it
 * still throws (`Uncaught TypeError`) on this fixture's custom
 * `Symbol.iterator` range, which is not the `_makeAsyncIterator`/async
 * mechanism at all (07 touches no `async`/`await`) — a genuinely different,
 * still-open incompleteness in this source-built VM, unaffected by the P-14
 * fix. Using this VM as the truth for it at v99 would fail it for a reason
 * that has nothing to do with a decompiler's correctness, so it falls back
 * to `expected-txt` with a caveat instead of `hermes-vm`, same as an absent
 * VM (rule 3) — the VM exists, but is known-broken for this one construct.
 */
const VM_LIMITATIONS: Readonly<Record<string, readonly number[]>> = {
  "07-for-of-iterable": [99],
};

function isVmLimited(name: string, version: number): boolean {
  return VM_LIMITATIONS[name]?.includes(version) ?? false;
}

/**
 * `hermes-dec-sample` predates this project's own fixture convention
 * (`tests/fixtures/README.md`'s "stick to `print`/no unconditional DOM
 * access" rule) — its `source.js` does `window.onload = ...` at top level.
 * §3.2's bare-Hermes environment has no `window` at all (`ReferenceError:
 * Property 'window' doesn't exist`), while this harness's own Node sandbox
 * *does* stub `window` (so a full-trace candidate keeps running past that
 * line). That is not a Hermes-vs-spec semantic disagreement — it's the two
 * sides observing genuinely different environments, exactly the asymmetry
 * §3.2 already warns is inherent to a print-projection trace, just severe
 * enough here to poison the whole comparison rather than only the print
 * channel. It has no `expected.txt` either (never an execution-trace target
 * — spec 06 §7 lists it for the disassembler/round-trip oracles). The
 * reference-implementation selftest (`tools/equiv/selftest.mjs` phase 3)
 * already excludes it from the Hermes cross-check for the same reason; this
 * is the same call, made explicit and load-bearing here.
 */
const NO_TRACE_REFERENCE: ReadonlySet<string> = new Set(["hermes-dec-sample"]);

export function chooseReference(fixture: FixtureRef, hbcVersion: number): ReferenceChoice {
  const divergent = isKnownDivergentFixture(fixture.name);
  if (isVmLimited(fixture.name, hbcVersion)) {
    return {
      engine: "expected-txt",
      reason: `Hermes VM v${hbcVersion} exists but is confirmed incomplete for "${fixture.name}" (its InternalBytecode.js async-iterator helper throws) — falling back to expected-txt with a caveat rather than trusting a broken VM run`,
      knownDivergences: [fixture.name],
    };
  }
  if (NO_TRACE_REFERENCE.has(fixture.name)) {
    return {
      engine: "expected-txt",
      reason: `"${fixture.name}" touches host globals the bare Hermes VM never provides (no injectable prelude, §3.2) in a way that poisons a full-trace comparison; it has no expected.txt either and is not a trace-equivalence target (spec 06 §7 uses it for the disassembler/round-trip oracles only)`,
      knownDivergences: [],
    };
  }
  const vm = findHermesVm(hbcVersion);
  if (vm !== null) {
    return {
      engine: "hermes-vm",
      reason: `Hermes VM v${hbcVersion} is available; per D14 its own trace of the fixture's .hbc is the reference, regardless of any known spec divergence`,
      vm,
      // Informational, not a caveat on *this* choice (the VM's own behaviour
      // needs no excuse — it is the truth by definition). Carried through so
      // a consumer comparing a spec-following program (identity, or a
      // hand-written source.js) against this VM's trace can tell a real
      // mismatch apart from this fixture's documented, expected one.
      knownDivergences: divergent ? [fixture.name] : [],
    };
  }

  if (!divergent) {
    if (!KNOWN_VERSIONS.includes(hbcVersion)) {
      throw new Error(
        `reference-policy: HBC version ${hbcVersion} is not in KNOWN_VERSIONS and fixture "${fixture.name}" is not a known-divergence construct — ` +
          `no Hermes VM is available to measure it, and there is no basis for assuming expected.txt (Node) still matches Hermes at this version. ` +
          `Add this version to reference-policy.ts (either KNOWN_VERSIONS, if Node is confirmed to still match Hermes there, or to a fixture's divergence row).`,
      );
    }
    return {
      engine: "expected-txt",
      reason: `no Hermes VM for v${hbcVersion}; "${fixture.name}" is not a known-divergence construct, so the committed expected.txt (Node) is the reference`,
      knownDivergences: [],
    };
  }

  // Known-divergence construct, no VM: expected-txt with a caveat, whether or
  // not this exact version was itself measured (spec 06 §4 rule 3 and the
  // v96/v98 remainder of O-1) — unless this specific version was *measured*
  // and found to match spec after all (no data does today; kept for when it
  // might).
  const measured = KNOWN_DIVERGENT_FIXTURES[fixture.name]?.[hbcVersion];
  if (measured === "matches-spec") {
    return {
      engine: "expected-txt",
      reason: `no Hermes VM for v${hbcVersion}; "${fixture.name}" is a known-divergence construct at other versions, but measured matches-spec at v${hbcVersion}`,
      knownDivergences: [],
    };
  }
  const measuredNote = measured === undefined ? `unmeasured at v${hbcVersion} (no VM); assumed divergent by construct name` : `measured ${measured} at v${hbcVersion}`;
  return {
    engine: "expected-txt",
    reason: `no Hermes VM for v${hbcVersion}; "${fixture.name}" is a known Node-vs-Hermes divergence construct (${measuredNote}) — reported PASS-with-caveat, not silently`,
    knownDivergences: [fixture.name],
  };
}
