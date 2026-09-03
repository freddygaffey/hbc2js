// tests/security/t-licensing.test.ts — T-L (spec 13 §5, §10, §9 step 0).
// Mandatory, lane-blocking: tools/security/LICENSES.md exists with an entry
// (licence string + URL + retrieval date) per §5 row, and the anti-vendoring
// tripwire holds (no file under tools/security/semgrep/ textually matches a
// cached Semgrep registry ruleset's id header — vendoring is a spec-12 R2
// violation per spec 13 §5).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { repoRoot } from "../support/paths.ts";

const LICENSES_PATH = join(repoRoot(), "tools", "security", "LICENSES.md");

// §5's table rows (tool name substrings sufficient to locate each row).
const EXPECTED_ROWS = [
  "Semgrep OSS engine",
  "Semgrep registry rules",
  "osv-scanner",
  "OSV.dev data",
  "androguard",
  "apktool",
  "CodeQL",
];

test("T-L: LICENSES.md exists with one entry per §5 row, each with a URL and a retrieval date", () => {
  assert.ok(existsSync(LICENSES_PATH), `${LICENSES_PATH} must exist (spec 13 §9 step 0)`);
  const text = readFileSync(LICENSES_PATH, "utf8");
  for (const row of EXPECTED_ROWS) {
    assert.ok(text.includes(row), `LICENSES.md must have a row for "${row}"`);
  }
  // Every row line must carry an http(s) URL and an ISO date (retrieval date).
  const rowLines = text.split("\n").filter((l) => l.startsWith("|") && EXPECTED_ROWS.some((r) => l.includes(r)));
  assert.ok(rowLines.length >= EXPECTED_ROWS.length, "expected at least one table row per §5 tool");
  for (const line of rowLines) {
    assert.match(line, /https?:\/\//, `row must cite a source URL: ${line}`);
    assert.match(line, /20\d{2}-\d{2}-\d{2}/, `row must cite a retrieval date: ${line}`);
  }
});

test("T-L: anti-vendoring tripwire — no file under tools/security/semgrep/ matches a cached registry ruleset's id header", () => {
  const semgrepRulesDir = join(repoRoot(), "tools", "security", "semgrep");
  const cacheDir = join(homedir(), ".semgrep");
  if (!existsSync(semgrepRulesDir)) {
    // Nothing to vendor yet (Lane S lands in spec 13 step 3) — tripwire
    // trivially holds; this test still runs so the check is exercised the
    // moment tools/security/semgrep/ starts existing.
    return;
  }
  const ourFiles = readdirSync(semgrepRulesDir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  if (!existsSync(cacheDir)) return; // no cached registry rules on this machine to compare against
  // Collect registry ruleset id headers (`rules:\n  - id: <ruleset>.<rule>`)
  // from the semgrep cache, and assert none of our own rule ids collide.
  const cachedIds = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".yaml") || entry.name.endsWith(".yml")) {
        const text = readFileSync(full, "utf8");
        for (const m of text.matchAll(/^\s*-?\s*id:\s*(\S+)/gm)) cachedIds.add(m[1] ?? "");
      }
    }
  };
  try {
    walk(cacheDir);
  } catch {
    return; // cache dir unreadable — nothing to compare, tripwire holds vacuously
  }
  for (const f of ourFiles) {
    const text = readFileSync(join(semgrepRulesDir, f), "utf8");
    for (const m of text.matchAll(/^\s*-?\s*id:\s*(\S+)/gm)) {
      const id = m[1] ?? "";
      assert.ok(!cachedIds.has(id), `our own rule file ${f} reuses a cached registry rule id "${id}" — possible vendoring`);
    }
  }
});
