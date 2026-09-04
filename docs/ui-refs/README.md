# docs/ui-refs/ — the screenshot-match target

Spec 20 §1.4 ("Mechanism C — a reference-driven screenshot loop"): the agent
building a view does not judge its own screenshot against free-form taste. It
judges it against a **reference screenshot committed here** and answers four
concrete, nameable questions. This directory is the match target; L7
(docs/specs/26-ui-full-ide.md) turns the loop into a repeatable step
(implement -> screenshot -> compare -> fix tokens/structure -> re-screenshot).

## The four-question checklist (spec 20 §1.4)

For a rendered view sitting next to its reference, an implementing agent (or
reviewer) answers, in order:

1. **Is the panel chrome as flat?** No shadows-as-default; panels are
   distinguished by `elevation`/`border` tokens, not drop shadows. A "yes"
   means every panel boundary in the rendered view is a 1px `border` (or an
   `elevation` background step), never a box-shadow.
2. **Is the code pane as dense?** Line height, gutter width and padding
   should read as a professional disassembler/IDE, not a prose editor. A
   "yes" means the code/disasm pane's line spacing and left gutter width are
   visually close to the reference's, not noticeably airier.
3. **Is the tree indentation as tight?** The left-pane module/function tree's
   per-level indent and row height should match the reference's density, not
   a consumer-app list's generous indent.
4. **Is there exactly one accent colour?** Every "this is interactive/active"
   signal (selection, focus ring, primary action) uses the theme's single
   `palette.accent` / `border.focus` token. A "yes" means no second "brand"
   colour has crept in anywhere in the screenshot.

A "no" on any question is a **concrete, actionable delta**: a token value
(`ui/themes/*.json`) if the delta is a size/colour/spacing number, or a
structural change (padding, layout) if it is not. This is the same
broken-vs-correct axis the agent is already good at — re-screenshot after
each fix.

## Needs Fred

The reference screenshots themselves are the owner's art-direction seed
(spec 20 §1.5) and are **not fabricated by an agent**. L3 lands this
checklist and the named slots below; Fred supplies the actual PNGs (or says
"skip this one") before L7 uses this directory as a real baseline gate.

Named slots (spec 20 §1.4's reference set — "the established grammar of the
genre: dense multi-pane, flat panels, mono code, muted chrome, one accent"):

- `ghidra.png` — Ghidra's default dark theme, a representative multi-pane
  view (listing + tree + a data window).
- `ida-pro.png` — IDA Pro's dark theme, disassembly view.
- `binary-ninja.png` — Binary Ninja's dark theme, disassembly/graph view.
- `vscode-dark-plus.png` — VS Code, "Dark+" theme, any source file open
  (the "modern IDE dark theme" reference spec 20 §1.4 names).
- `jetbrains-darcula.png` — a JetBrains IDE (e.g. IntelliJ/WebStorm) in the
  Darcula theme, any source file open.

Until these land, `docs/UI.md`'s "Art direction is a placeholder" note stays
accurate: the token *structure* this spec landed does not depend on the
seed's values, so no later landing needs to redo its work when the seed
arrives — only `ui/themes/*.json`'s values change.

## Attribution

Any screenshot placed here is a small, clearly-labelled reference image of a
third-party tool's UI, used for internal design comparison only (never
shipped, never redistributed) — the same basis on which spec 20 §1.4
recommends it. Hermes-dec (AGPL) is never a source for anything in this
repository, screenshots included; the reference tools above are unrelated to
it.
