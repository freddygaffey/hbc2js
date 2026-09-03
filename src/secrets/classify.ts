// src/secrets/classify.ts — spec 12 §9 step 1: the pure classifier.
// `classify(value): Hit[]` runs the §2.3 pattern set (pre-filter regex per
// pattern, §2.4 entropy gates, the §2.4 data-URI/minified-identifier guards)
// over ONE string value. Pure, no I/O — the scan driver (`service.ts`, step
// 2) is the only place that touches the artifact's `string-uses.jsonl` xref;
// this module never reads a file.
//
// Context-gated patterns (§3.4 pairing rules) and this module's boundary:
// spec §3.4 defines `aws-secret-ctx`'s C->B upgrade and `firebase-config`'s
// pairing in terms of a SIBLING string sharing a use-function or a
// co-occurring host string elsewhere in the bundle — information a pure,
// single-value `classify()` cannot see. This module applies a conservative,
// documented PROXY of that same signal — the candidate string's OWN text
// mentioning the vendor/keyword ("aws"/"secret"/"key"/"credential"/"token"
// for `aws-secret-ctx`, "firebase" for `firebase-config`) — as its baseline;
// the real cross-string pairing over `string-uses.jsonl` (§3.4, bundle-local,
// ONLY existing xref rows) is the scan driver's job (`service.ts`) and may
// promote a hit this proxy misses. Both layers cite §3.4; neither invents a
// new analysis. See `docs/specs/12-string-secrets.md` §2.4/§3.4.
import { PATTERNS, THRESHOLDS, type Category, type SecretPattern, type Tier } from "./patterns.ts";

export interface Hit {
  readonly patternId: string;
  readonly category: Category;
  readonly tier?: Tier;
  /** [start, len] inside the input value. */
  readonly span: readonly [number, number];
  /** Structured payload for some categories — §3.2: url -> {scheme,host,path};
   *  jwt -> decoded header `alg` + payload key names only (never values). */
  readonly extracted?: Record<string, unknown>;
}

const DATA_URI_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const MINIFIED_ID_RE = /^_0x[0-9a-fA-F]+$/;
/** Any RFC 7468 encapsulation boundary, any label — a PEM PRIVATE-KEY body is
 *  already caught structurally by the `pem-block` pattern (tier A); a PEM
 *  PUBLIC KEY / CERTIFICATE body is spec'd as `endpoint`-grade tag interest,
 *  NOT a secret (§2.3's `pem-block` row) — either way its base64 body must
 *  not ALSO be independently reported as an unstructured `generic-entropy-*`
 *  blob (§7.3's near-miss fixture: a PUBLIC KEY body's base64 has genuinely
 *  high Shannon entropy, exceeding real seeded secrets', purely because it IS
 *  real base64 — entropy alone cannot and should not try to distinguish
 *  "structurally-explained" high-entropy bytes from an unexplained blob). */
const PEM_BOUNDARY_RE = /-----BEGIN [A-Z ]+-----/;

/** Tuned on the seeded fixture ONLY (§7.4 tuning corpus): shape + Shannon
 *  entropy alone (§2.4) cannot separate a random-byte base64 secret from an
 *  unlucky-but-ordinary alnum run (a camelCase identifier, or a vendor-prefix
 *  near-miss like "AKIAtoolongprefix...") — both can clear ~4.0-4.5 bits/char
 *  at 20-40 chars. Character-CLASS diversity is the sharper signal: true
 *  base64-encoded secret bytes carry digits at a materially higher density
 *  than English-word-derived alnum runs (which skew almost digit-free) —
 *  every seeded real secret in this alphabet class sits at >=10% digit
 *  density; the worst seeded near-miss sits at <5%. This is a refinement of
 *  the entropy gate, not a replacement — both must pass. */
const MIN_DIGIT_DENSITY = 0.08;

function digitDensity(s: string): number {
  if (s.length === 0) return 0;
  const digits = (s.match(/[0-9]/g) ?? []).length;
  return digits / s.length;
}

// Patterns handled outside the generic per-pattern loop below (special
// structural or context-gated semantics); still must exist in PATTERNS[] for
// T1/T3 (id uniqueness, source citation, fixture-closure).
const SPECIAL_IDS = new Set(["jwt", "aws-secret-ctx", "firebase-config"]);
const AWS_CONTEXT_RE = /aws|secret|key|credential|token/i;
const FIREBASE_CONTEXT_RE = /firebase/i;

/** Shannon entropy in bits/char over `s` (§2.4). */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function passesEntropyGate(matchText: string, gate: NonNullable<SecretPattern["entropyGate"]>): boolean {
  if (matchText.length < gate.minLen) return false;
  return shannonEntropy(matchText) >= gate.minBitsPerChar;
}

/** RFC 3986 §3.2.1 userinfo is dropped from `extracted` on purpose (§10 —
 *  no secret-value propagation); only scheme/host/path are structural. */
function extractUrlParts(matchText: string): Record<string, unknown> | undefined {
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^\s/:@]+(?::[^\s/:@]+)?@)?([^\s/:?#]+)(\/[^\s?#]*)?/.exec(matchText);
  if (!m) return undefined;
  const result: Record<string, unknown> = { scheme: m[1], host: m[2] };
  if (m[3] !== undefined) result.path = m[3];
  return result;
}

/** RFC 7519 §3 / RFC 7515 §3.1 structural check: base64url-decode the first
 *  segment and require it to parse as JSON with an `alg` member (spec 12
 *  §2.3/§3.2). Payload segment decode, if it parses, yields KEY NAMES ONLY —
 *  never values, which may themselves be secrets (§3.2/§10). Returns null
 *  when the structural check fails — the coarse 3-segment regex alone is not
 *  enough to call this a JWT. */
function decodeJwt(matchText: string): Record<string, unknown> | null {
  const parts = matchText.split(".");
  if (parts.length !== 3) return null;
  try {
    const headerJson = Buffer.from(parts[0]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const header = JSON.parse(headerJson) as Record<string, unknown>;
    if (typeof header.alg !== "string") return null;
    const extracted: Record<string, unknown> = { alg: header.alg };
    try {
      const payloadJson = Buffer.from(parts[1]!.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      const payload = JSON.parse(payloadJson) as Record<string, unknown>;
      extracted.payloadKeys = Object.keys(payload);
    } catch {
      // payload need not be JSON for the header check to hold; omit payloadKeys.
    }
    return extracted;
  } catch {
    return null;
  }
}

function matchAllSpans(re: RegExp, value: string): { text: string; index: number }[] {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const scanner = new RegExp(re.source, flags);
  const out: { text: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = scanner.exec(value)) !== null) {
    out.push({ text: m[0], index: m.index });
    if (m[0].length === 0) scanner.lastIndex++;
  }
  return out;
}

export function classify(value: string): Hit[] {
  if (value.length === 0) return [];
  // §2.4 guards, unconditional regardless of entropy: a data-URI image
  // payload's base64 body has incidental high entropy but is never a secret
  // candidate (tag `asset` is the scan driver's job, not classify's, since
  // classify emits no non-secret tag for a whole-string guard hit); a
  // minified-identifier run (`_0x...`, Stage-3 obfuscation material) is not
  // secret-shaped material either.
  if (DATA_URI_IMAGE_RE.test(value)) return [];
  if (MINIFIED_ID_RE.test(value)) return [];
  const hasPemBoundary = PEM_BOUNDARY_RE.test(value);

  const hits: Hit[] = [];

  for (const p of PATTERNS) {
    if (SPECIAL_IDS.has(p.id)) continue;
    if (p.entropyGate && hasPemBoundary) continue; // module header: a PEM body's base64 is structurally explained, never also a generic-entropy blob.
    for (const { text, index } of matchAllSpans(p.re, value)) {
      if (p.entropyGate && !passesEntropyGate(text, p.entropyGate)) continue;
      if (p.entropyGate?.alphabet === "base64" && digitDensity(text) < MIN_DIGIT_DENSITY) continue;
      const hit: { patternId: string; category: Category; tier?: Tier; span: readonly [number, number]; extracted?: Record<string, unknown> } = {
        patternId: p.id,
        category: p.category,
        span: [index, text.length],
      };
      if (p.tier !== undefined) hit.tier = p.tier;
      if (p.id === "url") {
        const extracted = extractUrlParts(text);
        if (extracted) hit.extracted = extracted;
      }
      hits.push(hit);
    }
  }

  // jwt — structural check (§3.2), not just the 3-segment shape pre-filter.
  const jwtPattern = PATTERNS.find((p) => p.id === "jwt");
  if (jwtPattern) {
    for (const { text, index } of matchAllSpans(jwtPattern.re, value)) {
      const extracted = decodeJwt(text);
      if (extracted === null) continue;
      hits.push({ patternId: "jwt", category: jwtPattern.category, ...(jwtPattern.tier !== undefined ? { tier: jwtPattern.tier } : {}), span: [index, text.length], extracted });
    }
  }

  // aws-secret-ctx — §3.4 pairing proxy: shape + THRESHOLDS.base64 entropy +
  // this string's own text mentioning aws/secret/key/credential/token. The
  // real cross-string pairing (a SIBLING string sharing a use-function) is
  // `service.ts`'s job over `string-uses.jsonl`; this baseline is what a
  // bare value can see.
  const awsCtxPattern = PATTERNS.find((p) => p.id === "aws-secret-ctx");
  if (awsCtxPattern && !hasPemBoundary && AWS_CONTEXT_RE.test(value)) {
    for (const { text, index } of matchAllSpans(awsCtxPattern.re, value)) {
      if (!passesEntropyGate(text, { alphabet: "base64", minBitsPerChar: THRESHOLDS.base64.minBitsPerChar, minLen: THRESHOLDS.base64.minLen })) continue;
      if (digitDensity(text) < MIN_DIGIT_DENSITY) continue;
      hits.push({ patternId: "aws-secret-ctx", category: awsCtxPattern.category, ...(awsCtxPattern.tier !== undefined ? { tier: awsCtxPattern.tier } : {}), span: [index, text.length] });
    }
  }

  // firebase-config — §3.4 pairing proxy: AIza shape + this string's own
  // text mentioning "firebase" (the real pairing is a co-occurring
  // *.firebaseio.com/firebaseapp.com host string elsewhere in the bundle,
  // `service.ts`'s job).
  const firebasePattern = PATTERNS.find((p) => p.id === "firebase-config");
  if (firebasePattern && FIREBASE_CONTEXT_RE.test(value)) {
    for (const { text, index } of matchAllSpans(firebasePattern.re, value)) {
      hits.push({ patternId: "firebase-config", category: firebasePattern.category, ...(firebasePattern.tier !== undefined ? { tier: firebasePattern.tier } : {}), span: [index, text.length] });
    }
  }

  return hits;
}
