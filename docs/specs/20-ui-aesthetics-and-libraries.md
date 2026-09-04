# 20 — Stage-3 UI: aesthetics-when-built-agentically + the library stack (investigation)

**Status: INVESTIGATION (2026-09-04, Fable). Decision-support only — nothing
here is decided, specified, or built.** This is the follow-on to spec 19,
which left two things open under its §5 "reserved for the owner": (a) how to
make the Stage-3 RE UI *look GOOD* when it is built agentically (spec 19's
verdict was HIGH confidence functional, **MEDIUM on polish**), and (b) which
concrete **libraries** to use. This document investigates both, names specific
options with trade-offs and a **licence check on every recommendation** (this
repo is MIT — see `LICENSE` — so a UI dep tree must stay MIT-compatible), and
ends with **one coherent recommended stack** plus the picks that remain the
owner's taste call. The owner rules; this document informs.

Reading list: `docs/specs/19-ui-investigation.md` (the parent — §0 the surface
table, §1 the three mitigations and the agent-tractable/needs-a-human split,
§2 the six test layers, §3 Option A the local web app, §5 the reserved
decisions this doc feeds); `docs/specs/17-mcp-harness.md` §14 (BINDING — the
contract the UI renders: `context/{fn}`, `xref/*`, `module/{mod}` direct-edges
only, `leads`/`security-sinks`, `search/*`); `src/mcp/resources.ts` +
`src/mcp/tools.ts` (the transport-agnostic seam the UI mounts).

## 0. Framing: what this doc adds over spec 19

Spec 19 established *that* the UI is buildable agentically and *how it is
tested*, and it deliberately fenced the framework/component/graph-library
choices into its §5 as owner decisions. It did not investigate them. The gap
it named honestly was polish: the screenshot loop gets the UI to "correct and
unembarrassing", not to "good taste" (spec 19 §1.2). This document attacks
exactly that residue. Its thesis in one line:

> **Polish is mostly a procurement-and-constraint problem, not a talent
> problem.** An agent produces good-looking UI when the aesthetic decisions
> are *pre-made* — as design tokens it obeys, as a component library whose
> defaults already look good, as concrete visual references it matches against
> screenshots. What is left after that is a small, well-defined slice of taste
> that only the owner's eye supplies. This doc specifies the pre-making.

Nothing here changes spec 19's surface, test stack, or Option-A architecture
recommendation; it fills in the "which libraries, and how to make it pretty"
that §5 reserved.

## 1. Making it look good AGENTICALLY

### 1.1 Why "medium confidence on polish" is beatable

The MEDIUM verdict assumed the agent *chooses* aesthetics (spacing, colour,
type scale, elevation) and verifies them by reading a screenshot — and an
agent reading a screenshot reliably detects **broken**, unreliably detects
**mediocre** (spec 19 §1.2). The lever is to remove the choosing. If every
aesthetic value the agent would otherwise guess is instead a **fixed
constraint it consumes**, the screenshot loop no longer has to *judge taste* —
it only has to confirm the constrained system was **applied correctly**, which
is exactly the "broken vs correct" axis the agent is reliable on. Four
mechanisms, in order of leverage:

### 1.2 Mechanism A — a design-token layer (aesthetics as constraints)

Adopt **design tokens** — a small, named, versioned set of primitives that
every component reads from and nothing hard-codes around:

- **Spacing**: a single scale (e.g. 4-px base: `space-1..space-8`), never a
  literal `margin: 13px` anywhere.
- **Type scale**: a fixed ramp (e.g. `text-xs/sm/base/lg` + one mono family
  for code/disasm panes, one UI sans for chrome) — a modular scale, not
  per-view font sizes.
- **Colour**: semantic tokens (`bg`, `bg-elevated`, `border`, `fg`,
  `fg-muted`, `accent`, plus a **severity ramp** for findings
  info/low/med/high/critical and a **syntax palette** shared by source and
  disasm) — chosen once for a dark theme, referenced everywhere.
- **Elevation / radius / border**: two or three elevation levels, one radius,
  one border colour. A dense pro tool wants *flat and bordered*, not
  shadow-heavy — encode that as tokens so the agent can't drift into a
  consumer-app look.

The rule that makes this work is enforceable in the gate the same way the
project already enforces testing rules: a lint/test that **fails on any raw
colour hex, raw px spacing, or off-scale font size in UI source** (only
tokens allowed). This converts "does the spacing feel right" (untestable by
agent) into "are all spacings on the scale" (a text assertion). Tokens are
the single highest-leverage move: they are the artifact the owner's taste seed
(§1.5) is *expressed as*, and the thing the agent is *forbidden to invent*.

Token format is itself a small choice: **W3C Design Tokens JSON** (portable,
tool-agnostic) generated into CSS custom properties, or — with the Tailwind
recommendation below — the Tailwind `theme` config *is* the token layer
(`theme.colors`, `theme.spacing`, `theme.fontSize`). The latter is less
ceremony for a single-app repo and is the recommendation (§3).

### 1.3 Mechanism B — a component library whose DEFAULTS already look good

"Compose, don't style" (spec 19 §1.3) only raises the floor if the components
being composed *look good untouched*. The selection criterion is therefore not
just "has a virtualized table" but "**does its out-of-the-box dark render look
like a pro tool**". Libraries whose defaults are neutral/flat/dense clear this
bar; libraries whose defaults carry a strong consumer-brand look (rounded,
shadowed, colourful) fight the RE-tool aesthetic and make the agent *remove*
style, which is harder than adding none. This is the primary axis of the §2
component-library comparison.

### 1.4 Mechanism C — a reference-driven screenshot loop

Spec 19 §1.2 established the agent can screenshot and read the PNG. This doc
adds the missing half: **what it compares against**. Give the agent concrete
**visual references** committed in the repo (`docs/ui-refs/`): annotated
screenshots of **Ghidra**, **IDA Pro**, **Binary Ninja**, and one or two
**modern IDE dark themes** (VS Code Dark+, JetBrains Darcula) — the
established grammar of the genre (dense multi-pane, flat panels, mono code,
muted chrome, one accent). The loop becomes:

1. Agent implements a view against the token layer + component library.
2. Agent renders it headless (Playwright) against the golden `.hbcproj` and
   screenshots (spec 19 §2 layer 3–4).
3. Agent reads its screenshot **beside the reference** and checks concrete,
   nameable deltas: *is the panel chrome as flat? is the code pane as dense?
   is the tree indentation as tight? is there exactly one accent colour? is
   the type hierarchy as quiet?* These are "match the reference" judgments —
   far more reliable for an agent than free-form "is this pretty".
4. Deltas that are token values → fix the token. Deltas that are structure →
   fix the composition. Re-screenshot.

References turn open-ended taste into a **matching task**, which is the same
broken-vs-correct axis the agent is good at. This is the core answer to
"beat medium confidence".

### 1.5 Mechanism D — the owner's single art-direction seed

One owner action up front raises the floor more than any number of agent
iterations: **pick the seed**. Concretely, before the agent builds view two,
the owner supplies **one** of:

- a chosen base theme/palette (e.g. "Darcula-like", or a named theme the
  owner likes), OR
- one reference screenshot marked "make it feel like this", OR
- a filled-in token file (the strongest form — the owner edits ~20 token
  values once).

The agent then obeys the seed as a constraint (Mechanism A) and matches it
(Mechanism C). This is a **~1-session, ~20-value** owner investment that
converts the whole build from "agent guesses a look" to "agent applies the
owner's look". It is the cheapest, highest-return thing in this document.

### 1.6 The honest limits (what still needs the owner's eye)

Even with A–D, three things stay with the owner (unchanged from spec 19 §1.5,
sharpened here):

- **The seed itself** — an agent cannot originate taste; it can only propagate
  and match it. D is an owner input, by definition.
- **Information hierarchy at first run** — which panes exist by default, what
  the analyst sees on opening a project, one-click vs three-click. This is
  product judgment, not styling, and tokens don't touch it.
- **Graph-view readability** — the flagged top visual risk (spec 19 §1.3,
  §4); §2.4 below. No component library or token solves graph legibility at
  RE scale; it needs iterative owner review.

**Revised verdict: with A–D adopted, polish confidence rises from MEDIUM to
MEDIUM-HIGH.** The residue is a bounded, named list (seed + hierarchy +
graph), reviewed in a handful of owner sessions — not an open-ended "will it
look good" risk spread across every view.

### 1.7 The playbook (what an implementing agent follows, in order)

0. **(Owner, once)** Supply the art-direction seed (§1.5). Commit
   `docs/ui-refs/` reference screenshots.
1. **Stand up the token layer** (§1.2) from the seed. Add the gate lint: no
   raw hex / off-scale spacing / off-scale type in UI source.
2. **Install the component library** (§3 pick); build a `Storybook`-style or
   single "kitchen-sink" route rendering every primitive once, on the dark
   theme, so screenshots cover components in isolation before views exist.
3. **Build views** (spec 19 §0 table order: navigator → source/disasm →
   xref → write forms → search → graph LAST), each: compose components →
   DOM-test (semantics) → Playwright-render against golden `.hbcproj` →
   screenshot → compare to reference (§1.4) → fix tokens/structure → repeat.
4. **Screenshot at checkpoints, not per tweak** (spec 19 §1.2 bandwidth
   rule): design in the DOM (cheap text), verify in pixels (expensive) only
   at a completed view.
5. **Hand each completed view to the owner as a screenshot + running build**
   for taste review; apply the returned screenshot-anchored notes
   mechanically (spec 19 §1.5).
6. **Graph view last, flagged for heaviest owner review** (§2.4).

## 2. Library selection (options, trade-offs, licences)

Selection axes for this specific tool: **dense/large-data** (4,510-node
navigator, virtualization mandatory), **dark pro-tool aesthetic** (flat
defaults, §1.3), **agent-composability** (well-documented, huge training
corpus, headless-boot-strapped), **MIT-compatibility** (this repo is MIT).

### 2.1 Framework — React vs Svelte / Solid

| Option | Licence | For | Against |
|---|---|---|---|
| **React** | MIT | Largest ecosystem *by far* for every dense-tool primitive below (virtual tables, graph wrappers, code editors, panes all have first-class React bindings); largest agent-training corpus → best agent familiarity; the whole component-library field targets it first. | Runtime overhead vs Svelte/Solid — irrelevant for a single-user local tool. |
| **Svelte 5** | MIT | Smaller/faster output; pleasant DX. | Thinner ecosystem for the *specific* heavy primitives; smaller agent corpus → more agent guessing; component libraries less mature. |
| **Solid** | MIT | Fastest reactivity; JSX familiar. | Smallest ecosystem + corpus of the three; highest agent-uncertainty. |

**Pick: React.** For an agentic build the decisive factor is corpus size +
ecosystem depth — the agent should be *composing well-trodden bindings*, not
pioneering. All three are MIT; no licence tiebreak needed. React 19 + Vite
(MIT) as the build.

### 2.2 Component library — the dense-pro-tool axis

| Option | Licence | Defaults look | Density fit | Agent-composability | Verdict |
|---|---|---|---|---|---|
| **shadcn/ui + Radix + Tailwind** | MIT (all three) | Flat, neutral, professional; **you own the component source** (copied in, not a dep) so tokens are trivially applied | Excellent — unstyled Radix primitives + Tailwind density utilities | **Best** — components are plain source the agent reads/edits; Tailwind config *is* the token layer (§1.2) | **Recommended** |
| **Mantine** | MIT | Good, slightly consumer-rounded; strong dark mode | Very good — ships virtualized bits, spotlight/command palette, rich hooks | Good — large, well-documented | Strong runner-up |
| **MUI (Material UI)** | MIT | Strongly *Material* — brandy, shadowed; fights RE aesthetic (§1.3) | Good tables (esp. MUI X — but **MUI X Pro/Premium features are commercial-licensed**) | Good corpus | Rejected — wrong default look + licence asterisk on the good tables |
| **Ant Design** | MIT | Enterprise-dense but distinctly "Ant"; heavy to re-theme | Very good for tables | Good | Viable but hard to de-brand |
| **Chakra** | MIT | Clean but consumer-app rounded | Moderate | Good | Rejected — not dense enough by default |

**Pick: shadcn/ui + Radix UI + Tailwind CSS** (all MIT). Decisive for *this*
build: (1) shadcn components are **copied into the repo as source**, not a
dependency — the agent edits them directly and the token layer applies with no
override-fighting; (2) Radix gives accessible, **unstyled** primitives (dialog,
dropdown, tabs, context-menu, command palette) — semantics without an imposed
look, so §1.3's "compose don't style" starts from a neutral floor; (3)
Tailwind's `theme` config **is** Mechanism A's token layer, and its utilities
make dense layouts terse and lintable (§1.2 gate). Caveat: shadcn-as-source
means the agent maintains more files — acceptable, and it is exactly what makes
tokens frictionless.

### 2.3 Code / source viewer — CodeMirror 6 vs Monaco

Two panes need syntax-highlighted code: `source/{fn}` (JS-ish) and
`disasm/{fn}` (custom Hermes disasm text). Requirements: read-mostly, dark
theme matching tokens, **large-doc performant**, custom language for disasm,
gutter/decoration API for the name-overlay (Design-D) and xref click targets.

| Option | Licence | For | Against |
|---|---|---|---|
| **CodeMirror 6** | **MIT** | Lightweight, modular, fast on large docs; first-class custom-language support (Lezer) for the disasm grammar; clean decoration/gutter API; small bundle | Editing UX less "IDE-complete" (we barely edit — read-mostly, fine) |
| **Monaco** | MIT | The VS Code engine — richest editing, familiar | Heavy (web-worker, large bundle); overkill for read-mostly; custom-language (disasm) setup heavier; awkward with Vite/bundlers | 

**Pick: CodeMirror 6** (MIT). Read-mostly + a **custom disasm language** +
bundle weight all favour CM6; Monaco's editing strengths are wasted here.
Both MIT.

### 2.4 Graph view — the flagged top visual risk, at 4,510-node scale

Spec 19 §4 already **scopes the risk away from raw scale**: the contract only
serves `module/{mod}` **direct edges** and per-fn CFG — spec 17 §14 *cut* the
whole `module-graph`. So the UI **never draws 4,510 nodes at once**; it draws
**neighbourhoods** (a function and its callers/callees, a module and its direct
edges, one function's CFG). The realistic on-screen size is **tens to low
hundreds of nodes**, expandable on click. That reframes the library choice
from "WebGL-mandatory massive-graph renderer" to "clean small/medium graph
with good layout".

| Renderer | Licence | Scale model | For | Against |
|---|---|---|---|---|
| **React Flow** (`@xyflow/react`) | **MIT** | SVG/DOM, hundreds of nodes comfortably | React-native; custom node components (render fn name + size + severity token); pan/zoom/collapse built-in; great DX + corpus | Not for 10k+ nodes — **not needed** given neighbourhood scoping |
| **Cytoscape.js** | MIT | Canvas, thousands of nodes | Powerful graph algorithms + many layouts | Imperative, non-React API; heavier to theme to tokens |
| **sigma.js** | MIT | **WebGL, tens of thousands** | The scale answer *if* we ever draw whole-graph | Overkill here; lower-level; more agent work |
| **d3-force** | ISC (MIT-compat) | Manual | Total control | You build everything; most agent-risk |

**Layout** (all separable from the renderer): **elkjs** (EPL-2.0 — see licence
note below) or **dagre** (MIT) for hierarchical CFG/call layouts; force layout
for neighbourhoods. dagre is MIT and adequate; elkjs gives nicer layered
routing but is EPL-2.0.

**Pick: React Flow (`@xyflow/react`, MIT) + dagre (MIT) for layout.** It
matches the neighbourhood-scoped scale (spec 19 §4), is React-native and
token-themeable (custom node components consume the severity/syntax tokens
directly), and has the largest agent corpus. **The scale answer**: scale is
handled by the *contract* (neighbourhood/CFG only, never whole-graph), not by
the renderer — so a mid-weight SVG/DOM renderer is the right call, and WebGL
(sigma.js) is held in reserve only if a future spec ever adds a whole-graph
view. If low-hundreds-node neighbourhoods ever stutter, add level-of-detail
(hide labels when zoomed out) and node collapsing *before* reaching for WebGL.
**Licence note for the owner**: prefer **dagre (MIT)** over elkjs (EPL-2.0) to
keep the tree cleanly MIT-compatible; EPL is a weak copyleft that is generally
fine to depend on but is not MIT — flag it, owner's call.

### 2.5 Virtualized tables/trees + split panes

The 4,510-node navigator (tree) and every xref/search result list (table)
**must** virtualize (spec 19 §1.3: "a naive list dies").

| Need | Pick | Licence | Note |
|---|---|---|---|
| Virtual rows/grid | **TanStack Virtual** | MIT | Headless, framework-agnostic core, React binding; composes with shadcn table markup |
| Table logic (sort/filter/paginate) | **TanStack Table** | MIT | Headless — pairs with TanStack Virtual + shadcn cells; maps cleanly onto the contract's paginated `search/*` + caps |
| Tree navigator | **react-arborist** | MIT | Purpose-built virtualized tree (the 4,510-node navigator); or a TanStack Virtual + own tree state if finer control wanted |
| Split / resizable panes | **react-resizable-panels** | MIT | Simple, keyboard-accessible, persists layout; the multi-pane spine |
| (alt panes) | Allotment | MIT | VS Code-style; heavier — react-resizable-panels preferred |

All MIT. TanStack Table+Virtual being **headless** is ideal for the token
system: no imposed styling to fight, semantics + virtualization only, cells
rendered with shadcn/Tailwind.

## 3. Recommendation — one coherent stack

Everything below is **MIT** unless annotated; the tree is MIT-clean.

| Layer | Pick | Licence |
|---|---|---|
| Framework / build | **React 19 + Vite** | MIT |
| Component primitives | **shadcn/ui + Radix UI** | MIT |
| Styling / **token layer** | **Tailwind CSS** (`theme` config = design tokens, §1.2) | MIT |
| Code / disasm viewer | **CodeMirror 6** (custom Lezer grammar for disasm) | MIT |
| Graph (call-graph / CFG) | **React Flow** (`@xyflow/react`) | MIT |
| Graph layout | **dagre** (elkjs held as EPL-2.0 alternative — owner's call) | MIT (elkjs EPL-2.0) |
| Virtual table logic + rows | **TanStack Table + TanStack Virtual** (headless) | MIT |
| Tree navigator | **react-arborist** | MIT |
| Split panes | **react-resizable-panels** | MIT |
| E2E + visual regression | **Playwright** (spec 19 §2) | Apache-2.0 (MIT-compat) |
| DOM tests | **Testing Library** + Vitest (or node test + jsdom) | MIT |

Why this stack answers the four demands:

- **Looks good by default**: shadcn+Radix defaults are flat/neutral (§1.3);
  Tailwind config carries the owner's seed as tokens (§1.2, §1.5); headless
  table/graph impose no look to override.
- **Agent-composable**: React's is the largest corpus; shadcn is *source in
  the repo* the agent edits directly; every heavy primitive is headless (logic
  only) so composition, not styling, is the agent's job.
- **Handles the scale**: virtualization everywhere (TanStack Virtual +
  react-arborist); the graph scale is solved by the **contract**
  (neighbourhood/CFG-only, spec 17 §14 / spec 19 §4), so a DOM/SVG renderer
  suffices and WebGL is reserve, not baseline (§2.4).
- **MIT-compatible**: entire tree MIT except Playwright (Apache-2.0, MIT-compat
  and dev-only) and the elkjs *option* (EPL-2.0, avoidable via dagre). Flagged.

This stack slots into spec 19's **Option A** (local web app, one Node process,
two transports over one warm service pair) and its **six-layer test stack**
unchanged — this doc only fills the client-side library choices §5 reserved.

## 4. Reserved for the owner (the picks this doc does not make)

Per spec 19 §5 and spec 17 §6, the recommendation argues but does not decide.
The owner's calls:

1. **The art-direction seed (§1.5)** — the one high-leverage taste input:
   theme/palette, or one reference screenshot, or a filled-in token file.
   *Nothing else in the aesthetic playbook works without this.*
2. **Ratify or override the stack (§3)** — any single swap (Mantine instead of
   shadcn; Monaco instead of CM6; Cytoscape/sigma instead of React Flow) is
   the owner's, and each is a clean substitution given the headless/token
   discipline.
3. **elkjs vs dagre** — accept EPL-2.0 for nicer layered layout, or stay MIT
   with dagre (§2.4).
4. **Token format** — Tailwind config as the token layer (recommended, less
   ceremony) vs a standalone W3C Design Tokens JSON generating CSS vars
   (§1.2).
5. **Reference set** — which RE tools / IDE themes go in `docs/ui-refs/` as the
   match targets (§1.4), and how strict the "match the reference" bar is.
6. **The gate lint strictness** — whether no-raw-hex / on-scale-only is a hard
   gate failure or a warning (§1.2).
7. Everything spec 19 §5 already reserved (transport, packaging, read-only
   first, baseline-approval workflow) — unchanged.

The recommendation of this investigation is the §3 stack driven by the §1.7
playbook, with the seed (§1.5) as the owner's one indispensable input; the
decision is the owner's.
