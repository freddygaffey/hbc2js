// tools/fuzz/campaign-report.mjs — docs/BUGS.md 2026-09-03
// (`tools/fuzz/construct-fuzz.mjs:177`).
//
// Streams a fuzz campaign's divergence signatures to a JSONL sidecar as
// they occur, and writes a small summary JSON at close — so a huge campaign
// (thousands of finds, unbounded trace-context strings) can never lose its
// aggregate `cells` matrix to a single `JSON.stringify` exceeding V8's max
// string length (the 2026-09-03 incident: 40k programs / 201 finds, the
// aggregate matrix lost after 5h; `reports/fuzz/finds/*.js` survived).
// Appending one JSONL line per occurrence is O(1) memory per record
// regardless of campaign size; the summary only ever inlines a capped
// sample of distinct signatures plus a pointer to the full JSONL.
import { appendFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { relative } from "node:path";

const DEFAULT_SIG_CAP = 2000; // chars kept per signature payload in a JSONL record / the summary
const DEFAULT_SUMMARY_SIGNATURES_CAP = 500; // distinct signatures kept inline in the summary JSON
const DEFAULT_MAX_INLINE_BYTES = 400 * 1024 * 1024; // fallback threshold; injectable for tests

/** Truncates a payload string to `cap` chars (default 2000) — the "cap each
 *  signature's stored payload" half of the fix; the find path is kept in
 *  full alongside it, never truncated. */
export function capPayload(s, cap = DEFAULT_SIG_CAP) {
  return typeof s === "string" && s.length > cap ? s.slice(0, cap) : s;
}

/**
 * Opens a streaming campaign report writer.
 *   - `jsonlPath`: created (truncated) up front, then appended to — one
 *     JSON object per line — every time `recordSignature` is called, so a
 *     process that dies mid-campaign still leaves every signature seen so
 *     far on disk.
 *   - `sigCap`: chars kept per signature string, both in each JSONL record
 *     and in the summary's inline `signatures[]` sample.
 */
export function createCampaignReportWriter({ jsonlPath, sigCap = DEFAULT_SIG_CAP }) {
  writeFileSync(jsonlPath, "");
  const seen = new Set();
  let recordCount = 0;

  function recordSignature({ version, seed, verdict, signature, findPath, repoRoot }) {
    if (!signature) return;
    const capped = capPayload(signature, sigCap);
    seen.add(capped);
    recordCount++;
    const line = JSON.stringify({
      version,
      seed,
      verdict,
      signature: capped,
      find: findPath ? (repoRoot ? relative(repoRoot, findPath) : findPath) : null,
    });
    appendFileSync(jsonlPath, line + "\n");
  }

  /**
   * Writes the final summary JSON and always succeeds. The real failure
   * mode this guards is V8's ~1GB string-length ceiling on
   * `JSON.stringify`; `maxInlineBytes` is injectable (rather than actually
   * allocating hundreds of MB in a test) so a small limit can force the
   * fallback path — a summary that keeps only a capped sample of
   * `signatures[]`, sets `signaturesTruncated: true`, and points
   * `signaturesFile` at the full JSONL — deterministically.
   */
  function close({ report, outPath, maxInlineBytes = DEFAULT_MAX_INLINE_BYTES, signaturesCap = DEFAULT_SUMMARY_SIGNATURES_CAP }) {
    const full = { ...report, signatures: [...seen], signatureCount: recordCount, signaturesFile: jsonlPath };
    let text;
    try {
      text = JSON.stringify(full, null, 2);
    } catch {
      text = null;
    }
    if (text === null || text.length > maxInlineBytes) {
      const small = {
        ...report,
        signatures: [...seen].slice(0, signaturesCap),
        signatureCount: recordCount,
        signaturesFile: jsonlPath,
        signaturesTruncated: true,
      };
      text = JSON.stringify(small, null, 2);
    }
    writeFileSync(outPath, text);
    return { outPath, jsonlPath, signatureCount: recordCount };
  }

  return { recordSignature, close };
}

/**
 * Re-derives a best-effort `cells` matrix from `reports/fuzz/finds/`
 * filenames (`v<version>-seed<seed>.js`) alone — the recovery path for
 * when even the JSONL sidecar is gone (the 2026-09-03 incident: only
 * finds/ survived a lost summary). Finds encode neither DIVERGENT vs ERROR
 * nor the total programs run, so this recovers only a per-version failure
 * count (a lower bound once the campaign's 200-find cap is hit) — never
 * `n`, `pass`, or `inconclusive`, which are lost forever with the summary.
 */
export function recountFromFinds(findsDir) {
  const cells = {};
  if (!existsSync(findsDir)) return { cells, total: 0 };
  let total = 0;
  for (const name of readdirSync(findsDir)) {
    const m = /^v(\d+)-seed\d+\.js$/.exec(name);
    if (m === null) continue;
    const key = `construct-fuzz@v${m[1]}`;
    cells[key] = (cells[key] ?? 0) + 1;
    total++;
  }
  return { cells, total };
}
