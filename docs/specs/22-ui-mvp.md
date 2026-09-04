# 22 — Stage-3 UI MVP: functional, rough edges, cheap (spec)

Status: **approved in outline by Fred 2026-09-04** ("I think you could do this
overnight"); build starts on his "go". Six landings, lean agents, cap 2.
Decides-by-default the fundamentals reserved in spec 19 §5 *for the MVP only*;
each default is revisited before the full IDE build (specs 19–21).

## 0. What the MVP is

A local web app that opens a `.hbcproj`, shows the decompiled listing with
disasm, xrefs, search and findings, and lets a human **rename across
references** and **comment** through the same write tools agents use
(`src/mcp/tools.ts`). Themed by one config, keybound by one config with a vim
preset, right-click menu as the primary workflow surface, live update by
polling the append-only log (spec 18/21).

Nothing built here is throwaway: the server, action registry, theme and keymap
are the ones the full IDE (spec 19 Option A) needs.

## 1. Defaults taken for the MVP (Fred's reserved decisions, spec 19 §5)

| Decision | MVP default | Revisit |
|---|---|---|
| Hosting/process | one Node process: HTTP JSON server over `src/mcp/{resources,tools,leads}.ts` + static UI, localhost only | full build |
| Auth | none (localhost bind) | full build |
| Live update wire | poll `GET /log/tail?since=<seq>` every 1 s | WS vs SSE, spec 21 |
| Token format | `ui/theme.json` → CSS variables at startup | full build |
| Art-direction seed | current prototype palette as **placeholder** (cool slate, `--bg:#0e1520 --accent:#4c9be8`, IBM Plex Sans/Mono) | Fred's seed before the full build |
| Layout engine | none (no graph view in MVP) | dagre vs elkjs |
| Worktrees | not used | spec 21 |

## 2. Scope

**In:** open project · module tree · function list · source-over-disasm in
CodeMirror 6 · xrefs panel (inline `{fn,name,size}`) · search (functions +
source, paged) · findings list with status · leads/security-sinks list ·
**rename** (inline, F2/`cr`, shows "N references in M modules" before commit)
· **comment** · right-click menu · `theme.json` (presets `dark`, `light`) ·
`keymap.json` (presets `default`, `vim`, `ghidra`) · density token
(`compact | comfortable`) · resizable panes, one right-hand panel at a time ·
log-tail polling so agent writes appear live.

**Out (rough edges, accepted):** graph view · AI workers/jobs/presence (spec
22-workers, later) · WebSocket push · screenshot-match loop · Playwright
beyond one smoke test · list virtualisation (sluggish past a few thousand
functions — cap the listing and say so in the UI) · only `dark` preset
visually checked.

## 3. Architecture

```
ui/            Vite + React 19 + TypeScript, Tailwind (tokens only), shadcn/Radix
  theme.json   one config: palette, severity colours, fonts, radius, density
  keymap.json  { preset, overrides }
  src/actions/ ACTION REGISTRY — the single source for menu, palette, keymap
src/ui-server/ node:http JSON routes → McpResources / McpTools / leads.ts
```

**Action registry (§3.1).** Every command is `{ id, title, when, run }`. The
context menu, the command palette (`:`), and the keymap are three views over
the registry; adding an action to the registry adds it everywhere. Rename and
comment call the same `McpTools.setName` / `addComment` as MCP clients, so
they are logged, exported and hash-locked identically (spec 18).

**Keymap (§3.2).** App-level multi-key chords via a small sequence dispatcher
(timeout, `<leader>`); editor-level vim via `@replit/codemirror-vim` (MIT).
Presets are JSON files, not code. Vim preset: `gd` definition · `gr` xrefs ·
`gc` comment · `cr` rename · `K` explain/hover · `]f [f ]m [m` next/prev
function/module · `Ctrl-o Ctrl-i` jump list · `/ n N` search · `:` palette ·
`zc zo` fold · `hjkl` in trees. Ghidra preset: `L` rename, `G` goto, `;`
comment. Overrides win over preset.

**Context menu (§3.3).** Radix ContextMenu on identifier / string / module /
finding, every item with its keymap twin shown: Rename · Add comment · Go to
definition · Find xrefs · Mark reviewed / suspicious · Copy disasm offset ·
Show raw Hermes · (greyed, later) Explain · Suggest name · Open in graph.

**Theme (§3.4).** `theme.json` loaded to `:root` CSS variables; components use
tokens only (spec 20 lint rule, enforced by a gate test that greps `ui/src`
for literal colours). Presets `dark`, `light`; a user file replaces the preset.

## 4. Landings (lean agents; each ships tests + docs + AGENT-LOG line)

| # | Landing | Acceptance |
|---|---|---|
| 1 | `src/ui-server` routes over the MCP classes + Vite shell + panes + `theme.json` + token lint gate | `curl` every route against `tests/fixtures/security/vuln-app` project; shell renders 3 panes; lint gate fails on a literal colour |
| 2 | module tree, function list, source-over-disasm (CodeMirror), jump-to | fixture functions open; disasm aligns with source segments |
| 3 | xrefs panel, search (functions + source, paged), findings + leads lists | xref counts equal `McpResources` output; paged search cursor round-trips |
| 4 | action registry + context menu + `keymap.json` with 3 presets + command palette | every registry action reachable by menu, palette and chord; vim chords `gd gr cr gc` tested with a DOM keyboard test |
| 5 | rename-across-references + comment via `McpTools`, with affected-reference preview | rename appears in `hbcproj export` output and in the log; hook still verifies |
| 6 | log-tail polling (writes from an MCP client appear ≤2 s), density toggle, rough-edge pass, `docs/UI.md` | smoke Playwright test: open project → rename → see it in log pane |

Estimate: ~6 landings ≈ 1–1.5 M tokens all-in, 1.5–2 days at the current
cadence. Rules in force: cap 2 agents, FOREGROUND gates only, never edit
`docs/STATUS.md`, BUGS.md cells without literal `|`, test count never drops.

## 5. Successor

`23-ui-workers.md` (server-initiated work: Agent-SDK / `claude -p` workers,
jobs rail, presence, sampling/elicitation as optional MCP capabilities) —
outlined to Fred 2026-09-04, not yet written.
