# hbc2js TL;DR

**What it is.** A Hermes bytecode (`.hbc`, what React Native ships)
decompiler that produces runnable JavaScript checked against the real
Hermes VM, then layers an LLM-driven readability pass (naming, function
rewrites, file-tree ops) on top -- every proposal is `suggested` until a
human or an opt-in evaluator promotes it, and every accepted rewrite must
pass an equivalence oracle first.

**Install.**
```sh
npm install
npm run build      # or run TS sources directly with node's --experimental-strip-types
```

**The five commands that matter.**
```sh
# 1. Decompile a bundle to JavaScript
hbc2js decompile path/to/index.android.hbc out.js

# 2. Build a project (.hbcproj: split source + analysis index)
hbc2js init path/to/index.android.hbc --out my-project

# 3. Serve the UI's JSON API over that project
hbc2js ui-server my-project --hbc path/to/index.android.hbc

# 4. Batch-name functions with an LLM, scoped to app code only
hbc2js name llm-fill my-project --backend claude-cli --only src --limit 20

# 5. Drive an agent session over hbc2js's own MCP surface (never promotes)
hbc2js readability agent my-project --module 3 --max-turns 8
```

**Where to read next.**
- `hbc2js help` (or the `help` MCP tool / `hbc2js://docs/*` resources) --
  the same agent-facing docs from inside a session: `tldr`, `tools`,
  `workflow`, `examples`, `limits`, `glossary`.
- `docs/AGENT-BRIEF.md` -- the one-page orientation for a human or agent
  contributor working ON hbc2js's own code.
- `docs/READABILITY.md` -- the LLM naming/rewrite/file-op layer in depth.
- `.claude/skills/hbc2js/SKILL.md` -- the Claude Code skill that triggers
  on hbc2js/Hermes/decompile/readability questions.
