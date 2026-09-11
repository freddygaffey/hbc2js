// src/readability/skills.ts -- spec 28 section 9.2: loading and validating the
// versioned skill files under `skills/`. Pure filesystem + string work; no
// model, no network. A backend calls `loadSkill(id, dir)` once per job kind and
// puts `skill.body` at the head of the prompt.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { JobKind } from "../workers/queue.ts";
import { SKILL_FOR_KIND, SKILLS_DIR } from "./types.ts";
import type { SkillId } from "./types.ts";

/** Every skill file MUST carry these front-matter keys and these H2 sections.
 *  A prompt built from a skill missing any of them is not reproducible, so the
 *  loader refuses it rather than silently prompting with half a skill. */
export const REQUIRED_FRONT_MATTER = ["id", "kind", "version"] as const;
export const REQUIRED_SECTIONS = ["Inputs", "Rules", "Output contract", "Abstain"] as const;

export interface Skill {
  readonly id: SkillId;
  /** Job kinds this skill serves, as declared in its own front matter. */
  readonly kinds: readonly JobKind[];
  readonly version: number;
  /** Front matter stripped; this is what goes into the prompt. */
  readonly body: string;
  /** H2 headings found, in order. */
  readonly sections: readonly string[];
}

export class SkillError extends Error {}

export function skillPath(id: SkillId, dir: string = SKILLS_DIR): string {
  return join(dir, `${id}.md`);
}

/** Parse a skill file's text. Separated from IO so a test can drive it with a
 *  literal and so a malformed skill produces one clear error, not a stack. */
export function parseSkill(text: string, whence: string): Skill {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (m === null) throw new SkillError(`${whence}: missing the leading --- front matter block`);
  const frontMatter = m[1] ?? "";
  const body = (m[2] ?? "").trim();

  const fields = new Map<string, string>();
  for (const line of frontMatter.split("\n")) {
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) throw new SkillError(`${whence}: front-matter line is not \`key: value\`: ${line}`);
    fields.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  for (const key of REQUIRED_FRONT_MATTER) {
    if (!fields.has(key)) throw new SkillError(`${whence}: front matter is missing \`${key}\``);
  }

  const id = fields.get("id") as SkillId;
  const version = Number(fields.get("version"));
  if (!Number.isInteger(version) || version <= 0) {
    throw new SkillError(`${whence}: \`version\` must be a positive whole number, got ${String(fields.get("version"))}`);
  }
  const kinds = (fields.get("kind") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "") as JobKind[];
  if (kinds.length === 0) throw new SkillError(`${whence}: \`kind\` must name at least one job kind`);
  for (const k of kinds) {
    if (SKILL_FOR_KIND[k] !== id) {
      throw new SkillError(`${whence}: declares kind \`${k}\`, but SKILL_FOR_KIND routes that kind to \`${String(SKILL_FOR_KIND[k])}\``);
    }
  }

  const sections = [...body.matchAll(/^## (.+)$/gm)].map((mm) => (mm[1] ?? "").trim());
  for (const required of REQUIRED_SECTIONS) {
    if (!sections.includes(required)) throw new SkillError(`${whence}: missing the \`## ${required}\` section`);
  }
  if (body === "") throw new SkillError(`${whence}: body is empty`);

  return { id, kinds, version, body, sections };
}

export function loadSkill(id: SkillId, dir: string = SKILLS_DIR): Skill {
  const p = skillPath(id, dir);
  if (!existsSync(p)) throw new SkillError(`${p}: no such skill file`);
  const skill = parseSkill(readFileSync(p, "utf8"), p);
  if (skill.id !== id) throw new SkillError(`${p}: declares id \`${skill.id}\`, expected \`${id}\``);
  return skill;
}

/** The skill a job kind loads, or `undefined` when the readability layer does
 *  not serve that kind. */
export function skillForKind(kind: JobKind): SkillId | undefined {
  return SKILL_FOR_KIND[kind];
}
