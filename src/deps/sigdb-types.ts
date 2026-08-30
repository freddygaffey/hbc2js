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
}

export interface SigModule {
  readonly factoryFunctionIndex: number;
  readonly localModuleId: number | null;
  readonly depCount: number | null;
  readonly depIds: readonly number[] | null;
  readonly factoryExactHash: string | null;
  readonly factoryFuzzyHash: string | null;
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
  readonly schema: 2;
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
