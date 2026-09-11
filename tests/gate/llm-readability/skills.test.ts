// Spec 28 acceptance: the skill files are versioned repo artefacts with a
// fixed shape, so a naming-discipline change is a reviewable diff and never a
// prompt hack (spec 28 sections 2 and 9.2). Green today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { SHIPPED_SKILL_IDS, SKILLS_DIR, SKILL_FOR_KIND } from "../../../src/readability/types.ts";
import { REQUIRED_SECTIONS, SkillError, loadSkill, parseSkill, skillPath } from "../../../src/readability/skills.ts";

const skillsDir = join(repoRoot(), SKILLS_DIR);

test("spec 28: every shipped skill loads, parses, and declares the kind it is routed for", () => {
  for (const id of SHIPPED_SKILL_IDS) {
    const skill = loadSkill(id, skillsDir);
    assert.equal(skill.id, id);
    assert.ok(skill.version >= 1, `${id}: version must be >= 1`);
    assert.ok(skill.kinds.length >= 1, `${id}: must declare at least one job kind`);
    for (const kind of skill.kinds) {
      assert.equal(SKILL_FOR_KIND[kind], id, `${id}: declares kind ${kind} but is not routed for it`);
    }
    for (const section of REQUIRED_SECTIONS) {
      assert.ok(skill.sections.includes(section), `${id}: missing "## ${section}"`);
    }
    // The body is what goes into the prompt: front matter must be stripped.
    assert.ok(!skill.body.startsWith("---"), `${id}: front matter leaked into the prompt body`);
    assert.ok(skill.body.length > 400, `${id}: a skill this short is not an instruction`);
  }
});

// Skills whose output feeds `parseReadabilityResult` (the
// `{bindingId,name,confidence,evidence}[]` wire shape, spec 28 section 9.1).
// The landing-5 evaluator/adversarial skills answer a DIFFERENT question
// ("is this verdict accurate/misleading?", section 1d.1/1b step 8) with a
// smaller `{verdict, rationale}` contract of their own -- they are not
// naming skills and never produce a `NameProposal`.
const NAME_SHAPED_SKILL_IDS = ["hbc-name", "hbc-classify"] as const;
const VERDICT_SHAPED_SKILL_IDS = ["hbc-evaluate", "hbc-adversarial"] as const;

test("spec 28: each shipped skill states its JSON output contract and an abstain rule", () => {
  assert.deepEqual(
    [...NAME_SHAPED_SKILL_IDS, ...VERDICT_SHAPED_SKILL_IDS].sort(),
    [...SHIPPED_SKILL_IDS].sort(),
    "every shipped skill must be classified as either name-shaped or verdict-shaped",
  );
  for (const id of NAME_SHAPED_SKILL_IDS) {
    const skill = loadSkill(id, skillsDir);
    // The output contract must show the four fields the wire parser demands.
    for (const field of ["bindingId", "name", "confidence", "evidence"]) {
      assert.ok(skill.body.includes(field), `${id}: output contract does not mention ${field}`);
    }
    assert.match(skill.body, /"abstained"\s*:\s*true/, `${id}: abstain section must show the abstain payload`);
  }
  for (const id of VERDICT_SHAPED_SKILL_IDS) {
    const skill = loadSkill(id, skillsDir);
    for (const field of ["verdict", "rationale"]) {
      assert.ok(skill.body.includes(field), `${id}: output contract does not mention ${field}`);
    }
  }
});

test("spec 28: hbc-doc is deferred, so its file is absent and loading it fails loudly", () => {
  const p = skillPath("hbc-doc", skillsDir);
  assert.ok(!existsSync(p), "spec 28 section 8 defers hbc-doc until after naming lands (landing 5 at the earliest)");
  assert.throws(() => loadSkill("hbc-doc", skillsDir), SkillError);
});

test("spec 28: the skill parser refuses a malformed skill rather than prompting with half of one", () => {
  assert.throws(() => parseSkill("# no front matter\n", "x.md"), SkillError);
  assert.throws(() => parseSkill("---\nid: hbc-name\nkind: suggest-name\n---\nbody\n", "x.md"), SkillError, "missing version");
  assert.throws(
    () => parseSkill("---\nid: hbc-name\nkind: suggest-name\nversion: zero\n---\nbody\n", "x.md"),
    SkillError,
    "non-numeric version",
  );
  assert.throws(
    () => parseSkill("---\nid: hbc-name\nkind: name-module\nversion: 1\n---\nbody\n", "x.md"),
    SkillError,
    "a skill may not claim a kind that routes elsewhere",
  );
  const sections = REQUIRED_SECTIONS.map((s) => `## ${s}\ntext\n`).join("\n");
  assert.throws(
    () => parseSkill(`---\nid: hbc-name\nkind: suggest-name\nversion: 1\n---\n${sections.replace("## Abstain", "## Nope")}`, "x.md"),
    SkillError,
    "a skill without an abstain rule is not shippable",
  );
});
