// src/mcp/help.ts -- docs/lanes/readability.md discoverability task (Fred,
// 2026-09-13): "make hbc2js discoverable to agents ... a TL;DR, callable
// docs, and a skill". This is the ONE loader for the agent-facing docs: the
// text itself lives entirely under `docs/agent-help/<topic>.md`, read at
// runtime, never duplicated in this file or in `src/mcp/server.ts`/`hbc2js
// help` (the CLI) -- both of those just call `loadHelpTopic` below, so
// there is exactly one place to edit the words.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The six deep topics (docs/lanes/readability.md's own list); `tldr` is
 *  also what a topic-less call to `help` returns (plus this list), and what
 *  the `hbc2js://docs/index` resource returns too -- one function,
 *  `loadHelpTopic`, serves all three call sites so there is one behavior to
 *  keep in sync, not three. */
export const HELP_TOPICS = ["tldr", "tools", "workflow", "examples", "limits", "glossary"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];

export function isHelpTopic(topic: string): topic is HelpTopic {
  return (HELP_TOPICS as readonly string[]).includes(topic);
}

export class HelpTopicError extends Error {}

/** `docs/agent-help` resolved relative to THIS file (not `process.cwd()`),
 *  so `help`/`hbc2js://docs/*` behave the same whether the caller invoked
 *  `hbc2js` from the repo root or from anywhere else -- the same
 *  `import.meta.url` pattern `src/ui-core/keymap-config.ts`'s `PRESETS_DIR`
 *  already uses for its own runtime-loaded, non-duplicated content. */
const AGENT_HELP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "agent-help");

export function agentHelpDir(): string {
  return AGENT_HELP_DIR;
}

function readTopicFile(topic: HelpTopic): string {
  return readFileSync(join(AGENT_HELP_DIR, `${topic}.md`), "utf8").trim();
}

/** No topic: the tldr plus the topic list (docs/lanes/readability.md: "No
 *  topic = the tldr plus the topic list") -- this is also exactly what
 *  `hbc2js://docs/index` returns, so a client that only browses resources
 *  and never calls the `help` tool still finds every topic. A topic not in
 *  `HELP_TOPICS` is a refusal (`HelpTopicError`), never a silent empty
 *  reply -- same "abstain, don't guess" discipline the tool itself teaches. */
export function loadHelpTopic(topic?: string): string {
  if (topic === undefined) {
    const list = HELP_TOPICS.map((t) => `- \`${t}\``).join("\n");
    return `${readTopicFile("tldr")}\n\n## Topics\n\n${list}\n`;
  }
  if (!isHelpTopic(topic)) {
    throw new HelpTopicError(`help: unknown topic "${topic}" -- valid topics: ${HELP_TOPICS.join(", ")}`);
  }
  return readTopicFile(topic);
}
