# 19 — Stage-3 UI: can a Ghidra-like RE interface be built agentically? (investigation)

**Status: INVESTIGATION (2026-09-04, Fable). Decision-support only — nothing
here is decided, specified, or built.** This document investigates whether and
how the Stage-3 goal — a Ghidra-like reverse-engineering UI over the Stage-2
substrate — can be built by agents, how such a UI would be tested, and which
architecture best reuses the existing TS/Node backend. It ends with a
recommendation, but the fundamentals (§5) are the owner's decision, made in
person, exactly as spec 17 §6 fenced the MCP server's transport off from its
business logic. The owner rules; this document informs.

Reading list: `docs/specs/17-mcp-harness.md` §1–§2 (the read/write contract the
UI would be a client of), §6 (the deferral pattern this investigation extends),
§14 (the revised surface: `context/{fn}` presets, merged `xref/string`, inlined
neighbor metadata, `leads`/`security-sinks`, `search/*`); `docs/specs/
16-project-db.md` §0–§3 (the one `.hbcproj` per bundle, the query caps, the
logged write path, SQLite's single writer); `src/mcp/resources.ts` +
`src/mcp/tools.ts` (the transport-agnostic `McpResources`/`McpTools` classes —
already the exact seam a UI server would mount); `tests/mcp/resources.test.ts`
(the golden-`.hbcproj` fixture recipe, and the documented construct-fixture
gap); `docs/specs/re-tooling-roadmap-IDEAS.md` §0 (the Ghidra/Binary Ninja
ambition and the collaboration+UI line).

## 0. Framing: what the UI is, and what it is not

The Stage-3 UI is a **graphical client of the same contract the MCP serves**.
Its surface is the spec-17 surface, re-projected as panes instead of tool
calls:

| UI element | Contract it renders |
|---|---|
| function/module navigator | `search/functions`, `module/{mod}`, `fn/{fn}` |
| source pane | `source/{fn}` (+ name overlay, spec Design-D) |
| raw-disasm pane | `disasm/{fn}` |
| xref panel | `xref/who-calls`, `xref/calls-from`, `xref/string`, `xref/global-uses` |
| call-graph / CFG view | `module/{mod}` direct edges, walked; frames/CFG per fn |
| rename / comment / tag / finding forms | `set_name`, `add_comment`, `add_tag`, `record_finding`, `set_finding_status` — the evidence-gated logged write path, unchanged |
| search | `search/functions`, `search/source`, `xref/string` |
| leads panel | `leads` / `security-sinks` (spec 17 §14 addition) |
| history / audit view | `log`, `history/{target}` |

Nothing in the table is a new answer, a new cap, or a new store: the UI adds a
**presentation layer and interaction model** over verbs that already exist,
are already capped, and are already tested (~2,000 gate tests as of
2026-09-04, including `tests/mcp/*`). This framing is the single most
important fact in the whole investigation, because it converts "build a
reverse-engineering tool" (hard, semantic, visual) into "build views over a
tested API" (mostly mechanical, mostly verifiable in text).

What the UI is NOT, in this investigation: not a new analysis engine, not a
multi-user server, not a public web app. Single analyst, local machine, one
`.hbcproj` open at a time — the same operating model as the CLI and the MCP.

## 1. Can it be built agentically? The honest assessment

### 1.1 The real blocker, stated plainly

UI quality normally depends on a visual feedback loop: a human looks at the
rendered screen, feels that the spacing is wrong or the hierarchy is muddled,
and adjusts. Agents historically lacked that loop — they emitted CSS blind and
shipped layouts that pass every functional test while looking broken. Any
honest plan must either close that loop or route around it. Three mitigations
do most of the work; none of them is speculative.

### 1.2 Mitigation (a): the agent can now SEE the screen

A headless browser (Playwright) renders the real UI against the real golden
`.hbcproj` and writes a PNG; the agent reads that PNG as an image and judges
the render. This genuinely closes the loop — an agent can catch overlapping
panes, clipped text, an empty panel that should have data, a graph rendered
off-canvas. Two honest caveats:

- **Bandwidth.** Each screenshot is a tool call and a vision read; the loop is
  ~100× slower and costlier than a human glance. So screenshots must be the
  *verification* step, not the *exploration* step: the agent designs in the
  DOM (roles, order, structure — all text, all cheap), then screenshots to
  confirm at defined checkpoints, not per tweak.
- **Resolution of judgment.** An agent reading a screenshot reliably detects
  *broken* (overlap, truncation, missing data, wrong pane) and unreliably
  detects *mediocre* (weak hierarchy, cramped density, tone-deaf color). The
  screenshot loop gets the UI to "correct and unembarrassing", not to "good
  taste". That residue is §1.5's human share.

### 1.3 Mitigation (b): component library, not bespoke CSS

Bespoke CSS is exactly where the blind spots live. A mature component library
/ design system (the specific pick is the owner's, §5) pre-decides spacing,
typography, focus states, dark mode, and accessible semantics, and — decisive
for a Ghidra-like tool — ships the hard primitives: virtualized data tables
(4,510 modules on NSW; a naive list dies), trees, tabs, split/dockable panes,
command palette. The agent then *composes tested components* instead of
inventing pixels, and the class of bug the agent can't see mostly stops being
expressible. Corollary: the one component with no good off-the-shelf answer is
the **graph view** (call graph / CFG). Graph *layout* should come from an
established layout library (again owner's pick), but graph *readability* at
RE scale (clustering, collapsing, edge routing) is the single most
visually-demanding surface in the tool and should be flagged as the highest
human-review area — and the last thing built.

### 1.4 Mitigation (c): thin view over a tested contract

All correctness — what the source is, who calls whom, whether a finding's
evidence resolves, whether a confirm is allowed — lives behind
`McpResources`/`McpTools` and is already enforced by the gate. The UI should
hold **no analysis logic**: fetch, render, navigate, dispatch writes, display
errors the backend already produces (e.g. `record_finding`'s
evidence-rejection message becomes a form validation message verbatim). Then
the failure modes that remain in the UI are presentation and wiring — both of
which DOM tests and screenshots catch — and every data bug is by construction
a backend bug with an existing test home. The discipline to enforce in any
future spec: **if a UI feature needs an answer the contract doesn't give, the
contract grows first (its own spec change, its own tests), never a
UI-side workaround.**

### 1.5 The division of labor (the honest split)

**Agent-tractable (build without a human in the loop, verified by DOM asserts
+ screenshots):**
- every functional view in §0's table, wired to the tested API;
- navigation model: address-style routing (`fn`, module, sid as URL state),
  back/forward, cross-pane sync (click xref row → source pane jumps);
- keyboard-driven operation (Ghidra's real ergonomics are keys, not mouse —
  and keyboard behaviour is 100% testable in text);
- the write forms with the evidence gate surfaced (backend messages shown);
- empty/loading/error/cap-hit states (the caps are published constants —
  `RESOURCE_CAPS` — so "result truncated at N" is a testable state);
- performance floors on the golden fixture (virtualized lists, no
  whole-bundle fetches — the caps make the API side safe already).

**Needs a human eye (the owner, as periodic design reviewer):**
- aesthetic taste: theme, color, density, typography beyond library defaults;
- information hierarchy: which panes exist by default, what is one click vs
  three, what the analyst sees first on opening a project;
- graph-view readability at real-bundle scale (§1.3);
- first-run ergonomics and "does it feel like a tool or a demo" judgment.

The workable loop is the one this project already runs for code: agent
implements to a spec, owner reviews — here, reviews *screenshots and a running
build* — and returns concrete, screenshot-anchored notes ("callers list
should be left of source, findings need severity color") that the agent then
applies mechanically. Taste enters as review input, not as agent guesswork.

**Verdict: yes, buildable agentically, with confidence HIGH for the
functional tool and MEDIUM for the polish layer** — provided the three
mitigations are all adopted (screenshot verification, component library, thin
view) and the owner accepts the design-reviewer role for a handful of
sessions. Without (b) or (c) the verdict flips: an agent hand-rolling CSS
over ad-hoc endpoints is how bad UIs get built.

## 2. How the UI is tested

Six layers, cheapest first. Layers 1–2 run in the gate on every commit;
3–5 are a separate suite (browser-dependent, slower), run like `test:sweep`.

1. **Logic/state unit tests** (`node --test`, the existing runner, no DOM):
   view-models, selectors, URL↔state mapping, pagination/cap handling,
   navigation reducers. This is where most UI *logic* should live precisely
   so it is testable here.
2. **Component/DOM tests** (Testing Library discipline over jsdom or a
   browser-mode runner — exact harness is a framework-coupled choice, §5):
   assert semantics, not pixels — roles, accessible names, row counts, sort
   order, "the confirm button is disabled until an evidence ref is entered".
   Note honestly: this is where the project's first heavyweight dev-deps
   arrive; keeping them out of the core package (workspace split) is a §5
   packaging question.
3. **E2E** (Playwright, headless): drive the real served UI against the real
   backend and the golden fixture — open project, search "verify", click a
   result, assert the source pane shows that fn, click a caller in the xref
   panel, assert navigation, record a finding with a bad evidence ref, assert
   the backend's rejection surfaces. Real interactions, real contract, real
   DB writes (asserted via `log` — the audit trail doubles as a test oracle).
4. **Visual regression** (Playwright screenshot diffing against committed
   baselines): one baseline per major view over the golden fixture. This is
   the automated form of the closed visual loop — layout drift fails CI, and
   the agent reads the diff image to understand what moved. Baselines are
   golden artifacts: regeneration goes through the existing rule (owner
   approves, reviewed as a batch, CLAUDE.md testing rules). Baselines are
   UI-private fixtures, so the "no exact-output assertions on shared
   fixtures" rule is not violated — but a `docs/CONSOLIDATION.md` note should
   say so explicitly when the time comes.
5. **Golden `.hbcproj` fixture**: `tests/mcp/resources.test.ts` already
   contains the recipe — build a real project DB from rn-template-0.72 via
   the `hbc2js init` path. Every view therefore renders *real data* in every
   test layer. (Known constraint, already documented in that test's header:
   construct fixtures have zero CJS modules → empty ranges → unusable for
   source-view testing; the RN-template fixture is the golden one.)
6. **The contract tests double as the UI's data guarantee.** Because the UI
   speaks only the spec-17 contract, `tests/mcp/*` and the spec-10/11/16
   query-bounds tests *are* the UI's data-correctness suite. The UI suites
   above never re-test what the source of fn 12 is — only that whatever the
   contract returned is rendered where it should be.

The load-bearing fact for agentic development: **an agent can run layer 3–4
itself and read the screenshots**, so the same stack that gates regressions
is the loop the agent builds with. Nothing in the testing story requires a
human except baseline approval and taste review.

## 3. Architecture options

Constraints that score the options: single-user local tool; must reuse the
TS/Node backend (`ArtifactService`/`ProjectService` warm pair, `node:sqlite`,
Node ≥22) and the spec-17 contract; SQLite single-writer (spec 16 §1.2) means
exactly one process may hold the writable `.hbcproj`; macOS + Linux; the
project's zero-runtime-dep discipline is a value, not an accident; and — for
this investigation specifically — agentic buildability and testability.

### Option A — local web app over a project API server (recommended)

One Node process (the same one that can host the MCP server) additionally
serves: (1) a static SPA bundle, (2) a thin localhost HTTP/JSON (+WebSocket
for change-push, optional) projection of `McpResources`/`McpTools` — the same
methods the MCP binding calls, so MCP and UI are literally **two transports
over one warm service pair**, which also solves single-writer coordination
by construction (one process, one writer, writes serialized in-process, every
write still one `log` row).

- **Reuse: maximal.** `src/mcp/resources.ts`/`tools.ts` were deliberately
  written transport-agnostic; an HTTP projection is a mounting exercise, and
  the caps/evidence-gates come along untouched.
- **Agentic fit: best of the three.** The browser is the platform agents are
  strongest on; Playwright tests the exact artifact users run; component
  libraries are richest here.
- **Distribution: trivial.** `hbc2js ui <artifact>` starts the server and
  prints/opens a localhost URL. No signing, no installers, works over SSH
  port-forward to `deb` for free (the 28 GB sigdb stays put — a niceness the
  other options lack).
- **Costs.** A serving layer must exist — and the server *is* a transport
  decision of exactly the kind spec 17 §6 reserved, so it lands in §5, not
  here. Localhost exposure needs the standard hygiene (bind 127.0.0.1,
  random port + token) — owner's call on the details. No native chrome/file
  dialogs (irrelevant: projects are opened by path from the CLI).

### Option B — Electron (or Tauri-class shell)

A native-feeling app with its own icon and window management.
- Adds the heaviest dependency and packaging burden in the ecosystem
  (per-OS builds, signing/notarization on macOS) against a repo that today
  has zero runtime deps — a culture cost, not just a byte cost.
- Testing is still Playwright (electron driver), but flakier, and the agent
  is now debugging a shell as well as a UI.
- Everything Electron adds (native menus, file dialogs, dock icon) is
  marginal for a single-user tool launched from a CLI workflow; everything it
  costs is paid immediately. Not recommended for Stage 3. Note: if Option A
  is built, wrapping it in a shell later is cheap and loses nothing — this
  door stays open.

### Option C — TUI (terminal UI)

Fully agent-legible — the interface IS text, so the visual gap vanishes
entirely, which is the honest reason to take it seriously.
- But the flagship Stage-3 views are the ones a terminal is worst at:
  call-graph/CFG rendering in character cells is a toy at RE scale, and
  side-by-side source+disasm+xref+findings exceeds terminal real estate fast.
- It also forecloses the roadmap's collaboration/UI ambition (roadmap §0)
  rather than building toward it.
- Verdict: not the Stage-3 answer; possibly a later cheap *complement* (a
  `less`-grade browser for SSH sessions) built on the same HTTP projection.

### Option D — MCP-native transport and native webview shells (owner prompt, 2026-09-04)

Owner's mid-investigation prompt: look at native frameworks (pywebview-class)
and at leveraging the MCP itself. Two distinct ideas worth separating:

- **The UI as an MCP client — leverage the MCP as the UI's transport.** The
  strongest version of the "one contract" argument: instead of adding an
  HTTP/JSON projection beside the MCP binding, the UI speaks MCP (resources +
  tools) to the same server the assistant does. One transport, one binding,
  one audit path; the UI is provably just another client, and any contract
  gap the UI hits is by definition a gap the assistant has too. Costs to
  weigh honestly: MCP is a tool-call protocol, not a UI protocol — no
  request coalescing, coarse streaming, and browser-side MCP client tooling
  is younger than plain `fetch`; and the transport binding itself is still
  the very thing spec 17 §6 defers. Verdict: a *real* candidate for the §5
  transport decision, not a separate architecture — Option A's shape is
  unchanged whether the wire says MCP or HTTP, because both mount the same
  `McpResources`/`McpTools`. The investigation's advice: design the UI's
  data layer as a thin client interface so the MCP-vs-HTTP wire choice stays
  swappable, then let the owner pick the wire.
- **Native webview shells (pywebview / Tauri-class).** These wrap the same
  web UI in a lightweight native window instead of a browser tab — i.e. a
  packaging variant of Option A, cheaper than Electron (Option B). A
  Python-based shell (pywebview) would add a second language runtime purely
  as a window frame around a Node backend — poor fit for the TS/Node-reuse
  constraint; a Rust/Tauri-class shell avoids that but still adds per-OS
  build burden. Same conclusion as Option B: build Option A's web app first;
  a native shell can be wrapped around it later without rework, and which
  shell (if any) is a §5 packaging decision.

### Recommendation

**Option A**: a local web app, served by the same Node process that hosts the
warm services (and, if the owner so decides, the MCP binding), speaking a
thin HTTP projection of the existing spec-17 contract, rendered with a
mature component library, tested with the §2 stack. It maximizes contract
reuse, is the strongest agentic-buildability profile, keeps distribution at
"run a command", and respects the single-writer model structurally. Build
order that de-risks it: read-only views first (navigator, source, disasm,
xref, search — all pure §1 resources), the write UI second (it inherits the
evidence gate), the graph view last (highest visual risk, §1.3).

## 4. Risks and open questions (for the eventual spec, not decided here)

- **Graph view readability** at 4,510-module scale — the one place "thin view
  over the API" doesn't dissolve the difficulty. Mitigation: scope-limited
  graphs only (neighborhood-of-fn, module-local CFG), never whole-graph — the
  UI-side analogue of §14 cutting `module-graph`.
- **Dependency policy**: the UI brings the repo's first real dependency tree.
  A workspace split (core stays zero-dep; `ui/` owns its deps) is the obvious
  shape, but it is a packaging decision (§5).
- **Live-update model**: when an MCP-driven agent writes a finding while the
  UI is open, does the UI poll `log` or get pushed? Cheap either way over one
  process; needs a line in the spec.
- **Read-only first?** Shipping Stage 3.0 with no write UI at all halves the
  surface and zeroes the risk to the audit trail. Worth the owner's explicit
  yes/no.

## 5. Reserved for the owner (the actual decision)

Per the spec-17 §6 pattern: this investigation argues, but the following
fundamentals are **the owner's decision, made in person**, and nothing above
pre-commits them:

1. **Framework choice** — UI framework (React / Svelte / Solid / other), the
   component library / design system, the graph-layout library, and the
   DOM-test harness that follows from the framework.
2. **Transport / serving model** — whether the UI server co-hosts the MCP
   binding in one process (the single-writer question); whether the UI's wire
   is a plain HTTP/WebSocket projection or **the MCP protocol itself**
   (Option D — the UI as just another MCP client);
   localhost binding, port, and auth-token hygiene; how a
   long-lived UI server interacts with the `.hbcproj` `-wal` hand-off rule
   (spec 16 §1.1).
3. **Packaging / distribution** — workspace split vs new package; whether UI
   dev-deps may enter the root `package.json`; `hbc2js ui` as the launcher;
   whether a desktop shell (Option B) is ever wrapped around it; how/whether
   the UI ships in `dist`.
4. **Process policy** — read-only-first (yes/no), and the visual-baseline
   approval workflow as an extension of the existing golden-regeneration
   rule.

The recommendation of this investigation is Option A with the §1 mitigations
and the §2 test stack; the decision is the owner's.
