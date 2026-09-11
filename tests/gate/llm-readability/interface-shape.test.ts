// Spec 28 acceptance: the interface surface the HaikuBackend must implement,
// and the standing guarantee that NO test ever calls the network (spec 28
// section 9.1). These run today: they describe the contract landing 1 has to
// satisfy, not the implementation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { JOB_KINDS } from "../../../src/workers/queue.ts";
import {
  API_KEY_ENV,
  BUDGET_ENV,
  CACHE_DIR_ENV,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_HAIKU_MODEL,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MODEL_ENV,
  ReadabilityConfigError,
  SHIPPED_SKILL_IDS,
  SKILL_FOR_KIND,
  SKILL_IDS,
  resolveHaikuConfig,
} from "../../../src/readability/types.ts";

const readabilityDir = join(repoRoot(), "src", "readability");

test("spec 28: HaikuBackend config resolves to the documented defaults", () => {
  const cfg = resolveHaikuConfig({}, {}, "/tmp/proj");
  assert.equal(cfg.model, DEFAULT_HAIKU_MODEL);
  assert.equal(cfg.budgetTokens, DEFAULT_BUDGET_TOKENS);
  assert.equal(cfg.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS);
  assert.equal(cfg.skillsDir, "skills");
  assert.match(cfg.cacheDir, /^\/tmp\/proj\//);
  // The config records the NAME of the credential variable, never a value, so
  // a config object is always safe to log or put in a job record.
  assert.equal(cfg.apiKeyEnv, API_KEY_ENV);
  assert.ok(!JSON.stringify(cfg).includes("sk-"), "a resolved config must never carry a credential");
});

test("spec 28: env overrides model, budget and cache dir; explicit overrides win over env", () => {
  const env = { [MODEL_ENV]: "claude-sonnet-x", [BUDGET_ENV]: "500000", [CACHE_DIR_ENV]: "/var/cache/x" };
  const fromEnv = resolveHaikuConfig(env);
  assert.equal(fromEnv.model, "claude-sonnet-x");
  assert.equal(fromEnv.budgetTokens, 500000);
  assert.equal(fromEnv.cacheDir, "/var/cache/x");

  const overridden = resolveHaikuConfig(env, { model: "explicit", budgetTokens: 42, maxOutputTokens: 8 });
  assert.equal(overridden.model, "explicit");
  assert.equal(overridden.budgetTokens, 42);
});

test("spec 28: config validation refuses unusable values instead of silently clamping", () => {
  assert.throws(() => resolveHaikuConfig({}, { model: "   " }), ReadabilityConfigError);
  assert.throws(() => resolveHaikuConfig({ [BUDGET_ENV]: "0" }), ReadabilityConfigError);
  assert.throws(() => resolveHaikuConfig({ [BUDGET_ENV]: "-1" }), ReadabilityConfigError);
  assert.throws(() => resolveHaikuConfig({ [BUDGET_ENV]: "not-a-number" }), ReadabilityConfigError);
  assert.throws(() => resolveHaikuConfig({}, { budgetTokens: 1.5 }), ReadabilityConfigError);
  // A per-call cap larger than the whole-run budget can never be honoured.
  assert.throws(() => resolveHaikuConfig({}, { budgetTokens: 100, maxOutputTokens: 1000 }), ReadabilityConfigError);
});

test("spec 28: every skill-routed job kind is a real spec-23 job kind, and shipped skills are a subset", () => {
  for (const kind of Object.keys(SKILL_FOR_KIND)) {
    assert.ok(
      (JOB_KINDS as readonly string[]).includes(kind),
      `SKILL_FOR_KIND routes \`${kind}\`, which is not a spec-23 job kind`,
    );
  }
  for (const id of Object.values(SKILL_FOR_KIND)) {
    assert.ok((SKILL_IDS as readonly string[]).includes(id), `unknown skill id ${id}`);
  }
  for (const id of SHIPPED_SKILL_IDS) {
    assert.ok((SKILL_IDS as readonly string[]).includes(id));
  }
  // The four kinds spec 28 section 0 claims to serve are all routed.
  for (const kind of ["suggest-name", "name-module", "explain-fn", "doc-screen"] as const) {
    assert.ok(SKILL_FOR_KIND[kind] !== undefined, `${kind} must route to a skill`);
  }
});

test("spec 28: no test ever calls the network -- src/readability imports no transport and adds no SDK", () => {
  const offenders: string[] = [];
  for (const entry of readdirSync(readabilityDir)) {
    if (!entry.endsWith(".ts")) continue;
    const text = readFileSync(join(readabilityDir, entry), "utf8");
    for (const line of text.split("\n")) {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      if (/\b(?:from\s+["']node:(?:http|https|net|tls|dgram)["']|globalThis\.fetch|[^.\w]fetch\()/.test(line)) {
        offenders.push(`${entry}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "src/readability must stay transport-free; the HaikuBackend owns the one call site");

  const pkg = JSON.parse(readFileSync(join(repoRoot(), "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(
    deps.filter((d) => d.includes("anthropic") || d.includes("openai")),
    [],
    "spec 28 landing 1 must not pull a model SDK into the gate's dependency tree",
  );
});
