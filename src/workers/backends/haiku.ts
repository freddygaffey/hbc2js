// src/workers/backends/haiku.ts -- spec 28 section 9.1: the third
// `WorkerBackend` implementation, alongside `FakeBackend` and
// `HeuristicBackend` (`src/workers/backend.ts`, `src/workers/backends/
// heuristic.ts`). This is the ONE place in the project allowed to open a
// socket to a model: plain `fetch` to the Anthropic Messages API, no SDK
// (package.json untouched, spec 28 section 5). The gate never imports this
// file (tests/gate/llm-readability/interface-shape.test.ts asserts
// `src/readability/**` stays transport-free; this module is deliberately
// outside that directory).
//
// One user message per call: `skill.body + "\n\n" + context`, where `context`
// is exactly the `WorkerJobRequest.context` the runner/CLI already assembled
// (spec 28 section 9.1's table, spec 23 section 7 "a job never fetches its
// own data"). The content-hash cache (spec 28 section 9.3) is consulted
// before every call, so a re-run over an unchanged tree never touches the
// network.
import { loadSkill } from "../../readability/skills.ts";
import { cacheKey, parseReadabilityResult, SKILL_FOR_KIND } from "../../readability/types.ts";
import type { HaikuBackendConfig } from "../../readability/types.ts";
import { readCacheEntry, writeCacheEntry } from "../../readability/cache.ts";
import { TransientBackendError } from "../backend.ts";
import type { WorkerBackend, WorkerJobRequest, WorkerJobResponse } from "../backend.ts";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** The `context` field, serialised canonically (top-level keys sorted) so two
 *  requests built from the same data always hash the same regardless of the
 *  object's construction order. */
export function canonicaliseContext(context: Record<string, unknown>): string {
  return JSON.stringify(context, Object.keys(context).sort());
}

/** The rendered function/module body the job is about, per
 *  `CacheKeyInput.body`'s doc comment. The runner/CLI puts it at
 *  `context.source`; a request without one still gets a (degenerate) key
 *  rather than crashing. */
export function bodyFromContext(context: Record<string, unknown>): string {
  const source = context["source"];
  return typeof source === "string" ? source : "";
}

interface AnthropicResponse {
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly error?: { readonly message?: string };
}

export class HaikuBackend implements WorkerBackend {
  readonly id = "haiku";
  private readonly config: HaikuBackendConfig;

  constructor(config: HaikuBackendConfig) {
    this.config = config;
  }

  async run(req: WorkerJobRequest, signal?: AbortSignal): Promise<WorkerJobResponse> {
    const skillId = SKILL_FOR_KIND[req.kind];
    if (skillId === undefined) {
      throw new Error(`HaikuBackend: job kind "${req.kind}" has no routed skill (SKILL_FOR_KIND)`);
    }
    const skill = loadSkill(skillId, this.config.skillsDir);
    const body = bodyFromContext(req.context);
    const context = canonicaliseContext(req.context);
    const key = cacheKey({ kind: req.kind, skillId, skillVersion: skill.version, model: this.config.model, body, context });

    const cached = readCacheEntry(this.config.cacheDir, key);
    if (cached !== undefined) {
      return { text: cached.responseText, ...(cached.cost !== undefined ? { cost: cached.cost } : {}) };
    }

    const apiKey = process.env[this.config.apiKeyEnv];
    if (apiKey === undefined || apiKey === "") {
      throw new Error(`HaikuBackend: ${this.config.apiKeyEnv} is not set`);
    }

    const maxTokens = Math.min(req.maxTokens ?? this.config.maxOutputTokens, this.config.maxOutputTokens);
    const prompt = `${skill.body}\n\n${context}`;

    let res: Response;
    try {
      res = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (e) {
      throw new TransientBackendError(`HaikuBackend: transport error: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (res.status === 429 || res.status >= 500) {
      throw new TransientBackendError(`HaikuBackend: ${String(res.status)} ${res.statusText}`);
    }
    const json = (await res.json()) as AnthropicResponse;
    if (!res.ok) {
      throw new Error(`HaikuBackend: ${String(res.status)} ${res.statusText}: ${json.error?.message ?? "unknown error"}`);
    }

    const text = (json.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("");
    const tokensIn = json.usage?.input_tokens;
    const tokensOut = json.usage?.output_tokens;
    const cost = { ...(tokensIn !== undefined ? { tokensIn } : {}), ...(tokensOut !== undefined ? { tokensOut } : {}) };
    const parsed = parseReadabilityResult(text);
    writeCacheEntry(this.config.cacheDir, {
      key,
      responseText: text,
      result: parsed.ok ? parsed.result : { names: [], abstained: true },
      cost,
    });
    return { text, cost };
  }
}
