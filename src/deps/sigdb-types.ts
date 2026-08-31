// src/deps/sigdb-types.ts — the D17/D17b signature-DB file format (schema 2),
// promoted from the shape `tools/pkgsig/build-db.mjs` wrote by hand
// (docs/PACKAGE-SIGNATURES.md §5.3). One JSON file per `package@version` x
// HBC version, `<pkg>@<version>__hbc<N>.json` (`@scope/name` packages use
// `__` in place of `/`).

export interface SigFunction {
  readonly index: number;
  readonly name: string;
  readonly paramCount: number;
  readonly instrCount: number;
  readonly exactHash: string;
  readonly fuzzyHash: string;
  readonly stringSetHash: string;
  readonly stringCount: number;
  /** D17h-c register-insensitive tier (docs/DEPS.md "Confidence tiers"):
   *  same as `exactHash` but every register operand is masked to one opaque
   *  token instead of renamed by first-use order, so it also survives a
   *  different register-*reuse* pattern between two builds, not just a
   *  number permutation. Optional: absent on any schema-2 file written
   *  before this tier existed (the published `sigdb-20260830` release
   *  included), which this tier's readers must treat as "no match". */
  readonly regMaskedHash?: string;
}

export interface SigModule {
  readonly factoryFunctionIndex: number;
  readonly localModuleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
  readonly factoryExactHash: string | null;
  readonly factoryFuzzyHash: string | null;
  /** The factory function's `regMaskedHash` (D17h-c) — `undefined` on a
   *  schema-2 file written before this tier existed. */
  readonly factoryRegMaskedHash?: string | null;
  readonly nestedFunctionCount: number;
  /** Not persisted to disk (recomputed at fingerprint time); present on the
   *  in-memory result from `fingerprintModule` for callers (e.g. `guess.ts`)
   *  that need the actual nested indices, not just a count. */
  readonly nestedFunctionIndices?: readonly number[];
  readonly functionSetHash: string;
  readonly factoryIsBaseline: boolean;
}

export interface SigProvenance {
  readonly packageSha256: string | null;
  readonly metroVersion: string | null;
  readonly reactNativeVersion: string | null;
  readonly hermescVersion: number;
  readonly hermescRnEra: string | null;
  readonly repoCommit: string | null;
  readonly builtAt: string;
}

export interface SigDbFile {
  /** 2: pre-D17h-c (`sigdb-20260830` and earlier), no `regMaskedHash`.
   *  3: D17h-c — `regMaskedHash`/`factoryRegMaskedHash` present. Readers
   *  never gate on this number (`db.ts` doesn't check it); it exists purely
   *  as provenance for which fields a given file can be expected to carry. */
  readonly schema: 2 | 3;
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly totalFunctions: number;
  readonly rawFunctionCount: number;
  readonly subtractedBaselines: readonly string[];
  readonly functions: readonly SigFunction[];
  readonly modules: readonly SigModule[];
  readonly toolchainBaseline: boolean;
  readonly provenance: SigProvenance;
}

export interface SigDbIndexEntry {
  readonly package: string;
  readonly version: string;
  readonly hbcVersion: number;
  readonly path: string;
  readonly totalFunctions: number;
  readonly isBaseline: boolean;
}

export interface SigDbIndex {
  readonly schema: 1;
  entries: SigDbIndexEntry[];
}
