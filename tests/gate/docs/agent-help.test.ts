// tests/gate/docs/agent-help.test.ts -- docs/lanes/readability.md
// discoverability task (Fred, 2026-09-13): keeps `.claude/skills/hbc2js/
// SKILL.md` from rotting -- required front matter, a hard line-count cap
// (it is loaded into a context window), every command it shows actually
// parses, and every `docs/` path it cites exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SKILL_PATH = join(repoRoot, ".claude", "skills", "hbc2js", "SKILL.md");
const CLI = join(repoRoot, "src", "cli.ts");

function parseFrontMatter(text: string): { readonly fields: ReadonlyMap<string, string>; readonly body: string } {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  assert.ok(m !== null, `${SKILL_PATH}: missing the leading --- front matter block`);
  const fields = new Map<string, string>();
  for (const line of (m?.[1] ?? "").split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    assert.ok(colon >= 0, `${SKILL_PATH}: front-matter line is not \`key: value\`: ${line}`);
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { fields, body: m?.[2] ?? "" };
}

test(".claude/skills/hbc2js/SKILL.md: exists, has required front matter, and is under 150 lines", () => {
  assert.ok(existsSync(SKILL_PATH), "missing .claude/skills/hbc2js/SKILL.md");
  const text = readFileSync(SKILL_PATH, "utf8");
  const { fields } = parseFrontMatter(text);
  assert.equal(fields.get("name"), "hbc2js");
  const description = fields.get("description");
  assert.ok(description !== undefined && description.length > 0, "SKILL.md front matter is missing a non-empty description");
  const lineCount = text.split("\n").length;
  assert.ok(lineCount < 150, `SKILL.md is ${String(lineCount)} lines, must stay under 150 (it is loaded into a context window)`);
});

/** Every `hbc2js <verb...> --help` this file shows must exit 0 -- a stale
 *  example command is worse than none, because it is the first thing a
 *  session copy-pastes. Verbs are read straight out of the fenced code
 *  blocks so this test cannot drift from what the file actually shows. */
function verbsFromSkill(): readonly (readonly string[])[] {
  const text = readFileSync(SKILL_PATH, "utf8");
  const verbs: (readonly string[])[] = [];
  const seen = new Set<string>();
  const KNOWN_TWO_WORD = new Set(["name llm-fill", "readability agent", "readability rewrite", "readability review", "hbcproj export"]);
  for (const m of text.matchAll(/^hbc2js ([a-z][a-z-]*(?: [a-z][a-z-]*)?)\b/gm)) {
    const rest = m[1];
    if (rest === undefined) continue;
    const words = rest.split(" ");
    const verb = words.length >= 2 && KNOWN_TWO_WORD.has(`${words[0]} ${words[1]}`) ? [words[0], words[1]] : [words[0]];
    const key = verb.join(" ");
    if (key === undefined || seen.has(key)) continue;
    seen.add(key);
    verbs.push(verb as readonly string[]);
  }
  return verbs;
}

test(".claude/skills/hbc2js/SKILL.md: every hbc2js command it shows still parses (--help exits 0)", () => {
  const verbs = verbsFromSkill();
  assert.ok(verbs.length >= 5, `expected at least 5 verbs in SKILL.md's examples, found ${verbs.length}: ${verbs.map((v) => v.join(" ")).join(", ")}`);
  for (const verb of verbs) {
    const r = spawnSync(process.execPath, [CLI, ...verb, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0, `hbc2js ${verb.join(" ")} --help exited ${String(r.status)}, stderr:\n${r.stderr}`);
  }
});

test(".claude/skills/hbc2js/SKILL.md: every docs/ path it cites exists", () => {
  const text = readFileSync(SKILL_PATH, "utf8");
  const paths = new Set<string>();
  for (const m of text.matchAll(/`(docs\/[A-Za-z0-9_./-]+\.md)`/g)) {
    const p = m[1];
    if (p !== undefined) paths.add(p);
  }
  assert.ok(paths.size > 0, "SKILL.md cites no docs/ paths");
  for (const p of paths) assert.ok(existsSync(join(repoRoot, p)), `SKILL.md cites ${p}, which does not exist`);
});
