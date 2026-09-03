// src/secrets/patterns.ts — spec 12 §2.2/§2.3: the versioned secrets
// pattern-set data module. Pure data + regex compilation; no scanning logic
// lives here (that is the classifier, spec 12 §9 step 1).
//
// Licensing discipline (spec 12 §2.1, reviewer edit R2): every regex below is
// derived ONLY from the cited vendor doc or RFC in that pattern's `source`
// field and must be re-derivable from that citation alone. Open-source
// scanner rulesets (gitleaks — MIT; trufflehog — AGPL-3.0, same license
// class as hermes-dec) were NOT consulted for regex text — copying a regex
// from either is a stated spec violation, mandatory for AGPL trufflehog and
// as citation discipline even for MIT gitleaks. If a regex here happens to
// resemble a public scanner's, that is convergent derivation from the same
// public vendor-doc prefix, not copying.
//
// Append-only id discipline (spec 12 §2.2): `PATTERN_SET_VERSION` bumps its
// trailing integer whenever a pattern is added, removed, or its regex/
// threshold changes. Pattern `id`s are append-only — a retired pattern's id
// is NEVER reused; findings reference ids, and a reused id would silently
// re-mean old evidence. Extension procedure: append to `PATTERNS`, bump
// `PATTERN_SET_VERSION`, add a row to the seeded ground-truth fixture
// (tests/fixtures/secrets/seeded/ground-truth.json) exercising the new
// pattern, rerun `tools/secrets/measure.ts` (step 4). Acceptance test T3
// enforces the fixture-closure half of this mechanically.

export const PATTERN_SET_VERSION = "hbc2js-secrets/1";

/** §3.1 category taxonomy — closed set per pattern-set version. */
export type Category =
  | "secret/aws"
  | "secret/gcp"
  | "secret/firebase"
  | "secret/stripe"
  | "secret/github"
  | "secret/slack"
  | "secret/twilio"
  | "secret/jwt"
  | "secret/pem"
  | "secret/url-creds"
  | "secret/generic"
  | "endpoint"
  | "deeplink"
  | "sql"
  | "flag"
  | "debug"
  | "asset";

/**
 * §4.1 confidence tier. Only `secret/*` categories carry a tier (findings).
 * The "endpoint/deeplink/sql/flag/debug/asset" categories (§2.3's tier "—"
 * row) produce tags, not findings, and so have no tier — the §2.2 interface
 * sketch shows `tier` as non-optional, but the concrete v1 table (§2.3)
 * explicitly lists "—" for those rows; `tier` is optional here to make that
 * table representable without inventing a tier value the spec never assigns.
 */
export type Tier = "A" | "B" | "C";

export interface SecretPattern {
  /** Stable, never reused: "aws-akid", "jwt", "pem-block". */
  id: string;
  category: Category;
  /** Confidence tier this pattern yields on match; absent for tag-only (§2.3 "—") patterns. */
  tier?: Tier;
  /** Anchored where the underlying format is anchored. */
  re: RegExp;
  entropyGate?: {
    alphabet: "base64" | "hex" | "any";
    minBitsPerChar: number;
    minLen: number;
  };
  /** Vendor doc / RFC the format was derived from (spec 12 §2.1). */
  source: string;
  note?: string;
}

/** §2.4 entropy thresholds, per alphabet class (shipped as versioned data). */
export const THRESHOLDS = {
  base64: { minBitsPerChar: 4.0, minLen: 20 },
  hex: { minBitsPerChar: 3.0, minLen: 32 },
  generic: { minBitsPerChar: 4.5, minLen: 24 },
} as const;

const AWS_DOC =
  "AWS docs: 'Identifiers for IAM entities' access-key-id prefixes, " +
  "https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html " +
  "— long-term access key ids are AKIA/temporary are ASIA + 16 more base32 chars (20 total)";
const AWS_SECRET_DOC =
  "AWS docs: 'Managing access keys' — secret access keys are 40-character " +
  "base64-alphabet strings, https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html";
const GCP_DOC =
  "Google Cloud docs: 'API keys' — API keys are prefixed 'AIza' followed by " +
  "35 URL-safe base64 characters, https://cloud.google.com/docs/authentication/api-keys";
const FIREBASE_DOC =
  "Firebase docs: 'Understand Firebase Projects' apiKey field — uses the same " +
  "'AIza'-prefixed Google API key format and is normally shipped alongside a " +
  "*.firebaseio.com / firebaseapp.com host in the same config object, " +
  "https://firebase.google.com/docs/projects/api-keys";
const STRIPE_DOC =
  "Stripe docs: 'API keys' — publishable/secret/restricted keys are prefixed " +
  "pk_/sk_/rk_ + live_/test_ + at least 24 alphanumeric chars, https://stripe.com/docs/keys";
const GITHUB_DOC =
  "GitHub docs: 'About authentication to GitHub' token formats — personal " +
  "access tokens/OAuth/user-to-server/server-to-server/refresh tokens are " +
  "prefixed ghp_/gho_/ghu_/ghs_/ghr_ + 36 alphanumeric chars, " +
  "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/about-authentication-to-github#githubs-token-formats";
const SLACK_DOC =
  "Slack docs: 'Access token types' — bot/user/legacy/refresh/single-channel " +
  "tokens are prefixed xoxb-/xoxp-/xoxa-/xoxr-/xoxs- followed by dash-delimited " +
  "numeric and alphanumeric segments, https://api.slack.com/authentication/token-types";
const TWILIO_DOC =
  "Twilio docs: 'Account SIDs, Auth Tokens, and API Keys' — Account SIDs are " +
  "'AC' + 32 hex chars, API Key SIDs are 'SK' + 32 hex chars, " +
  "https://www.twilio.com/docs/iam/api-keys";
const JWT_DOC =
  "RFC 7519 (JSON Web Token) §3 'JWT Format', with the compact serialization " +
  "defined by RFC 7515 (JWS) §3.1: three base64url segments (header.payload.signature) " +
  "separated by '.'; the header decodes to JSON containing an 'alg' member (RFC 7519 §5.1)";
const PEM_DOC =
  "RFC 7468 'Textual Encodings of PKIX, PKCS, and CMS Structures' — PEM " +
  "encapsulation boundaries are literal '-----BEGIN <label>-----' / " +
  "'-----END <label>-----' lines; PRIVATE KEY / RSA PRIVATE KEY / EC PRIVATE KEY / " +
  "ENCRYPTED PRIVATE KEY labels denote private-key material (§4/§10/§11)";
const URL_USERINFO_DOC =
  "RFC 3986 (URI Generic Syntax) §3.2.1 'User Information' — the deprecated but " +
  "still-shipped 'user:password@host' userinfo subcomponent of an authority";
const RFC3986_DOC = "RFC 3986 (URI Generic Syntax) §3 'Syntax Components' — scheme://authority/path[?query][#fragment]";
const RFC4648_B64_DOC = "RFC 4648 §4 'Base 64 Encoding' — the standard base64 alphabet, gated by the §2.4 entropy threshold in THRESHOLDS.base64";
const RFC4648_HEX_DOC = "RFC 4648 §8 'Base 16 Encoding' — the hex alphabet, gated by the §2.4 entropy threshold in THRESHOLDS.hex";
const METRO_PATH_DOC =
  "Observed Metro-bundler behaviour: apps frequently concatenate a base URL " +
  "constant with a '/segment/segment' path literal at call sites; RFC 3986 §3.3 " +
  "'Path' defines the path-segment syntax this pattern matches the literal half of";
const DEEPLINK_DOC =
  "RFC 3986 §3.1 'Scheme' (any non-http(s) registered scheme is a candidate deep " +
  "link) plus Android docs 'Intents and Intent Filters' for the 'intent://' scheme, " +
  "https://developer.android.com/guide/components/intents-filters";
const SQL_DOC =
  "ISO/IEC 9075 (SQL) reserved leading statement keywords (SELECT/INSERT/UPDATE/" +
  "DELETE/CREATE TABLE); SQLite's non-standard PRAGMA statement per SQLite docs, " +
  "https://www.sqlite.org/pragma.html";
const NAMING_CONVENTION_DOC =
  "No vendor spec exists for these identifier-naming conventions (unlike the " +
  "prefixed-token formats above); the pattern is gated by string-uses.jsonl " +
  "`role` (property-key/property-get only, spec 12 §2.3) specifically because " +
  "it has no structural anchor, to bound false positives on ordinary prose.";

export const PATTERNS: SecretPattern[] = [
  {
    id: "aws-akid",
    category: "secret/aws",
    tier: "A",
    re: /\b(?:AKIA|ASIA)[A-Z2-7]{16}\b/,
    source: AWS_DOC,
  },
  {
    id: "aws-secret-ctx",
    category: "secret/aws",
    tier: "B",
    re: /\b[A-Za-z0-9+/]{40}\b/,
    source: AWS_SECRET_DOC,
    note:
      "Shape alone is indistinguishable from any 40-char base64 run (tier C " +
      "generic on its own); the classifier (spec 12 §3.4) upgrades C→B only " +
      "when an aws/secret-bearing string shares a use-function per string-uses.jsonl.",
  },
  {
    id: "gcp-api-key",
    category: "secret/gcp",
    tier: "A",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    source: GCP_DOC,
  },
  {
    id: "firebase-config",
    category: "secret/firebase",
    tier: "B",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    source: FIREBASE_DOC,
    note:
      "Same shape as gcp-api-key; classified separately only when the scan " +
      "driver's pairing rule (spec 12 §3.4) finds a *.firebaseio.com / " +
      "firebaseapp.com host string co-occurring in the same bundle.",
  },
  {
    id: "stripe-key",
    category: "secret/stripe",
    tier: "A",
    re: /\b(?:sk|pk|rk)_(?:live|test)_[0-9A-Za-z]{24,}\b/,
    source: STRIPE_DOC,
  },
  {
    id: "github-token",
    category: "secret/github",
    tier: "A",
    re: /\bgh[pousr]_[0-9A-Za-z]{36}\b/,
    source: GITHUB_DOC,
  },
  {
    id: "slack-token",
    category: "secret/slack",
    tier: "A",
    re: /\bxox[bpars]-[0-9]+-[0-9]+-[0-9A-Za-z]+\b/,
    source: SLACK_DOC,
  },
  {
    id: "twilio-sid-key",
    category: "secret/twilio",
    tier: "B",
    re: /\b(?:AC|SK)[0-9a-fA-F]{32}\b/,
    source: TWILIO_DOC,
  },
  {
    id: "jwt",
    category: "secret/jwt",
    tier: "A",
    re: /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    source: JWT_DOC,
    note:
      "This regex is the coarse three-segment pre-filter; the classifier's " +
      "structural check (§3.2) additionally base64url-decodes the first " +
      "segment and requires it to parse as JSON with an 'alg' member before " +
      "yielding a tier-A hit.",
  },
  {
    id: "pem-block",
    category: "secret/pem",
    tier: "A",
    re: /-----BEGIN (?:RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----/,
    source: PEM_DOC,
    note:
      "PUBLIC KEY / CERTIFICATE boundaries are RFC-7468-legal but are not " +
      "secret material by themselves; the classifier tags those `endpoint`-grade " +
      "interest at tier C instead of matching this pattern (spec 12 §2.3).",
  },
  {
    id: "basic-auth-url",
    category: "secret/url-creds",
    tier: "A",
    re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/:@]+@[^\s/]+/,
    source: URL_USERINFO_DOC,
  },
  {
    id: "generic-entropy-b64",
    category: "secret/generic",
    tier: "C",
    re: /\b[A-Za-z0-9+/]{20,}={0,2}\b/,
    entropyGate: { alphabet: "base64", minBitsPerChar: THRESHOLDS.base64.minBitsPerChar, minLen: THRESHOLDS.base64.minLen },
    source: RFC4648_B64_DOC,
  },
  {
    id: "generic-entropy-hex",
    category: "secret/generic",
    tier: "C",
    re: /\b[0-9a-fA-F]{32,}\b/,
    entropyGate: { alphabet: "hex", minBitsPerChar: THRESHOLDS.hex.minBitsPerChar, minLen: THRESHOLDS.hex.minLen },
    source: RFC4648_HEX_DOC,
  },
  {
    id: "url",
    category: "endpoint",
    re: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>]+/,
    source: RFC3986_DOC,
  },
  {
    id: "path-fragment",
    category: "endpoint",
    re: /^\/(?:[^\s/]+\/)+[^\s/]*$/,
    source: METRO_PATH_DOC,
  },
  {
    id: "deep-link",
    category: "deeplink",
    re: /^(?:intent:\/\/|(?!https?:\/\/)[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/,
    source: DEEPLINK_DOC,
  },
  {
    id: "sql",
    category: "sql",
    re: /^\s*(?:SELECT|INSERT|UPDATE|DELETE|CREATE\s+TABLE|PRAGMA)\b/i,
    source: SQL_DOC,
  },
  {
    id: "feature-flag",
    category: "flag",
    re: /(?:enable|disable|flag|experiment|rollout)/i,
    source: NAMING_CONVENTION_DOC,
    note: "role-gated to property-key/property-get use rows only (spec 12 §2.3); the regex alone is deliberately loose.",
  },
  {
    id: "debug-admin",
    category: "debug",
    re: /(?:debug|staging|internal|admin|bypass)/i,
    source: NAMING_CONVENTION_DOC,
    note: "same role gate as feature-flag (spec 12 §2.3).",
  },
];
