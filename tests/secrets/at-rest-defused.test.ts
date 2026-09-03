// Standing check (2026-09-03): the seeded secrets fixture must be defused
// at rest — see tests/fixtures/secrets/seeded/README.md and the
// implementation note in docs/specs/12-string-secrets.md §8. GitHub push
// protection flagged four real-format values committed at ac65a50 (Stripe
// live key, Slack token, Stripe restricted test key, Twilio SID); this test
// is the checklist against every pattern in src/secrets/patterns.ts, not
// just the four GitHub happened to catch, so a future fixture edit that
// pastes a literal value back in fails here before it can be committed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PATTERNS } from "../../src/secrets/patterns.ts";
import { FIXTURE_DIR, DEFUSED_MARKER } from "./support/materialize.ts";

const AT_REST_FILES = ["ground-truth.json", "index/strings.json", "index/string-uses.jsonl"];

// The checklist is every pattern with a distinctive vendor anchor (a fixed
// prefix/structure a real scanner keys on: AKIA/ASIA, AIza, sk_/pk_/rk_,
// gh[pousr]_, xox[bpars]-, AC/SK + 32 hex, the JWT 3-segment shape, a PEM
// boundary line, scheme://user:pass@host) — i.e. the same class of pattern
// GitHub push protection matched at ac65a50 (Stripe key, Slack token,
// Stripe restricted key, Twilio SID), generalized to every such pattern in
// patterns.ts, not just the four GitHub caught (spec 12 §8 brief).
//
// Deliberately excluded: `aws-secret-ctx`/`generic-entropy-b64`/
// `generic-entropy-hex` are shape-only starting points (spec 12 §2.4/§3.4)
// meant to be gated by entropy/context in the classifier, not by the regex
// alone — their raw regex matches *any* sufficiently long alphanumeric run,
// including ordinary identifiers and the fixture's own near-miss rows by
// design (e.g. the 40-char repeated-letter near-miss exists specifically to
// prove the classifier's context gate rejects it despite the shape match).
// Also excluded: the tag-only patterns (`url`, `path-fragment`, `deep-link`,
// `sql`, `feature-flag`, `debug-admin`) — these have no `tier`, are not
// secrets, and matching ordinary text is their designed job.
const ANCHORED_PATTERN_IDS = new Set([
  "aws-akid",
  "gcp-api-key",
  "firebase-config",
  "stripe-key",
  "github-token",
  "slack-token",
  "twilio-sid-key",
  "jwt",
  "pem-block",
  "basic-auth-url",
]);

test("at-rest fixture matches no anchored-format PATTERNS[] regex (defused at rest)", () => {
  const anchored = PATTERNS.filter((p) => ANCHORED_PATTERN_IDS.has(p.id));
  assert.equal(
    anchored.length,
    ANCHORED_PATTERN_IDS.size,
    "ANCHORED_PATTERN_IDS references a pattern id that no longer exists in patterns.ts",
  );
  for (const name of AT_REST_FILES) {
    const text = readFileSync(join(FIXTURE_DIR, name), "utf8");
    for (const p of anchored) {
      assert.ok(!p.re.test(text), `${name} unexpectedly matches pattern ${p.id} (${p.re}) — fixture must be defused at rest`);
    }
  }
});

test("at-rest fixture: every seeded secret value is behind the defused marker", () => {
  const gtRaw = JSON.parse(readFileSync(join(FIXTURE_DIR, "ground-truth.json"), "utf8")) as {
    secrets: { defused: string }[];
  };
  for (const s of gtRaw.secrets) {
    assert.ok(s.defused.startsWith(DEFUSED_MARKER), `ground-truth.json secret not defused: ${JSON.stringify(s)}`);
  }

  const stringsRaw = JSON.parse(readFileSync(join(FIXTURE_DIR, "index", "strings.json"), "utf8")) as {
    entries: { sid: number; v: string }[];
  };
  const secretSids = new Set(gtRaw.secrets.map((_, i) => i + 1));
  for (const e of stringsRaw.entries) {
    if (!secretSids.has(e.sid)) continue;
    assert.ok(e.v.startsWith(DEFUSED_MARKER), `index/strings.json sid ${e.sid} not defused: ${JSON.stringify(e.v)}`);
  }
});
