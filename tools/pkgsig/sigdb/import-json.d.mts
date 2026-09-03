// Ambient type declaration for import-json.mjs, so a `.ts` test (with
// `allowJs` off, per tsconfig.json) can import it without a TS7016
// "implicitly has an 'any' type" error. Kept minimal and hand-in-sync with
// the functions exported for programmatic use — docs/specs/15-sigdb-schema.md
// §3, tests/gate/deps/sigdb-import.test.ts.
import type { DatabaseSync } from "node:sqlite";
import type { SigDbFile } from "../../../src/deps/sigdb-types.ts";

export interface ParsedSigFilename {
  readonly pkg: string;
  readonly version: string;
  readonly hbcVersion: number;
}

export function parseSigFilename(name: string): ParsedSigFilename | null;
export function sha256File(path: string): string;

export interface SourceFile {
  readonly relPath: string;
  readonly path: string;
  readonly parsed: ParsedSigFilename | null;
}

export interface EnumeratedSourceFiles {
  readonly topLevel: readonly SourceFile[];
  readonly baselines: readonly SourceFile[];
  readonly byHbcVersion: ReadonlyMap<number | null, number>;
}

export function enumerateSourceFiles(dir: string): EnumeratedSourceFiles;

export interface ImportOptions {
  readonly batchSize?: number;
  readonly log?: (progress: { processed: number; total: number }) => void;
}

export interface ImportResult {
  readonly db: DatabaseSync;
  readonly totalEnumerated: number;
  readonly topLevelCount: number;
  readonly baselineCount: number;
  readonly byHbcVersion: ReadonlyMap<number | null, number>;
  readonly imported: number;
  readonly skipped: number;
  readonly errors: number;
  readonly errorFiles: readonly string[];
}

export function importDirectory(dir: string, dbPath: string, opts?: ImportOptions): ImportResult;

export function reconstructFingerprint(db: DatabaseSync, fpId: number): SigDbFile | null;

export interface VerifyOptions {
  readonly seed?: number;
  readonly sampleFraction?: number;
}

export interface CompletenessReport {
  readonly ok: boolean;
  readonly enumeratedTotal: number;
  readonly dbTotal: number;
  readonly errorCount: number;
  readonly indexChecked: number;
  readonly roundtripChecked: number;
  readonly roundtripMismatches: number;
  readonly problems: readonly string[];
}

export function verifyCompleteness(dir: string, dbPath: string, opts?: VerifyOptions): CompletenessReport;
