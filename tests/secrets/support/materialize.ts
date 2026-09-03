// tests/secrets/support/materialize.ts — spec 12 §7.3 seeded ground-truth
// fixture, defused-at-rest scheme (tests/fixtures/secrets/seeded/README.md).
//
// The checked-in fixture never contains a string that matches a real
// secret's live format — not even under our own loose tier-C generic
// entropy patterns (src/secrets/patterns.ts `generic-entropy-b64` / `-hex`,
// ≥20/≥32 contiguous alphabet chars) or the JWT three-segment pre-filter
// (≥10 chars per dot-separated segment): every seeded secret value is
// base64-encoded, then that base64 is split into `CHUNK`-sized pieces joined
// by `.`, behind a marker prefix. No contiguous run in the result reaches
// any pattern's length threshold, and the marker text itself contains none
// of the vendor trigger substrings. See tests/secrets/at-rest-defused.test.ts
// for the standing check against every pattern in patterns.ts (see
// docs/specs/12-string-secrets.md, implementation note under §8). This
// module reverses the encoding at test time only, and writes the TRUE
// spec-10 artifact (real-format values) into a fresh scratch directory under
// `os.tmpdir()` — that materialized copy, never the checked-in fixture, is
// what a scanner-under-test should be pointed at.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFUSED_MARKER = "hbc2js-defused:";
/** Chunk size for the base64 body: under every pattern's length threshold (JWT segments need >=10, generic-b64 needs >=20, generic-hex needs >=32). */
export const DEFUSED_CHUNK = 8;

/** Encode a real value into the at-rest defused form. */
export function defuse(value: string): string {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += DEFUSED_CHUNK) chunks.push(b64.slice(i, i + DEFUSED_CHUNK));
  return DEFUSED_MARKER + chunks.join(".");
}

/** Decode a defused value back to its real form; non-defused strings (near-misses, filler) pass through unchanged. */
export function undefuse(value: string): string {
  if (!value.startsWith(DEFUSED_MARKER)) return value;
  const b64 = value.slice(DEFUSED_MARKER.length).split(".").join("");
  return Buffer.from(b64, "base64").toString("utf8");
}

/** The checked-in, defused-at-rest fixture directory. */
export const FIXTURE_DIR = fileURLToPath(new URL("../../fixtures/secrets/seeded/", import.meta.url));

interface RawGroundTruthSecret {
  defused: string;
  patternId: string;
  tier: string;
  category: string;
}
interface RawGroundTruth {
  patternSetVersion: string;
  secrets: RawGroundTruthSecret[];
  nearMisses: { value: string; expect: "clean" }[];
}

export interface GroundTruthSecret {
  value: string;
  patternId: string;
  tier: string;
  category: string;
}
export interface GroundTruth {
  patternSetVersion: string;
  secrets: GroundTruthSecret[];
  nearMisses: { value: string; expect: "clean" }[];
}

/** Load ground-truth.json with every seeded secret's real value restored (never written to disk). */
export function loadGroundTruth(fixtureDir: string = FIXTURE_DIR): GroundTruth {
  const raw = JSON.parse(readFileSync(join(fixtureDir, "ground-truth.json"), "utf8")) as RawGroundTruth;
  return {
    patternSetVersion: raw.patternSetVersion,
    secrets: raw.secrets.map((s) => ({
      value: undefuse(s.defused),
      patternId: s.patternId,
      tier: s.tier,
      category: s.category,
    })),
    nearMisses: raw.nearMisses,
  };
}

/**
 * Materialize the TRUE spec-10 artifact (strings.json + string-uses.jsonl
 * with real-format values, plus a real-value ground-truth.json for
 * convenience) from the defused-at-rest fixture into a fresh scratch dir
 * under `os.tmpdir()`. `string-uses.jsonl` carries no values so it is
 * copied verbatim. Returns the scratch dir path — point any
 * scanner-under-test's `artifactDir` at this, never at `FIXTURE_DIR`.
 */
export function materializeArtifact(fixtureDir: string = FIXTURE_DIR): string {
  const outDir = mkdtempSync(join(tmpdir(), "hbc2js-secrets-seeded-"));

  const strings = JSON.parse(readFileSync(join(fixtureDir, "strings.json"), "utf8")) as {
    entries: { sid: number; v: string }[];
    [key: string]: unknown;
  };
  strings.entries = strings.entries.map((e) => ({ ...e, v: undefuse(e.v) }));
  writeFileSync(join(outDir, "strings.json"), JSON.stringify(strings, null, 2) + "\n");

  const uses = readFileSync(join(fixtureDir, "string-uses.jsonl"), "utf8");
  writeFileSync(join(outDir, "string-uses.jsonl"), uses);

  const gt = loadGroundTruth(fixtureDir);
  writeFileSync(join(outDir, "ground-truth.json"), JSON.stringify(gt, null, 2) + "\n");

  return outDir;
}
