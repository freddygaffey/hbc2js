// ui/src/listing/disasm-highlight.ts: syntax colour for the disasm block.
// Spec 20 §1.2: the syntax palette is shared by source and disasm; source
// gets it through `@codemirror/lang-javascript` + `hbcHighlightStyle`
// (./cm-theme.ts), but the disasm text (src/disasm/print.ts's canonical
// mode) has no lezer grammar, so it is plain text. This is a small
// line-oriented classifier (NOT a parser: it never throws, never partially
// matches, and a line it does not recognise is left uncoloured) that marks
// ranges with the same `.hbc-syn-*` classes `cm-theme.ts` defines, so both
// panes read as one palette.
//
// Recognised line shapes (docs/specs/02-disassembler.md §2 canonical mode):
//   "; ..."                 module/function header and comments
//   "L3:"                   a label
//   "  003a  Mnemonic  ops" an instruction: offset, mnemonic, operands
//   "  .switch ..."         a switch table head/case line
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const commentMark = Decoration.mark({ class: "hbc-syn-comment" });
const keywordMark = Decoration.mark({ class: "hbc-syn-keyword" });
const stringMark = Decoration.mark({ class: "hbc-syn-string" });
const numberMark = Decoration.mark({ class: "hbc-syn-number" });
const functionMark = Decoration.mark({ class: "hbc-syn-function" });
const variableMark = Decoration.mark({ class: "hbc-syn-variable" });

const OFFSET_RE = /^(\s*)([0-9a-f]{4})(\s+)(\S+)(\s*)(.*)$/;
const LABEL_RE = /^(L\d+):$/;
const STRING_RE = /"[^"]*"/g;
const LABEL_REF_RE = /\bL\d+\b/g;
const REGISTER_RE = /\br\d+\b/g;
const NUMBER_RE = /(?:#c)?\b\d+(?:\.\d+)?\b/g;

/** One line's decorations, as `[from, to, mark]` relative to `lineStart`. */
function lineRanges(lineStart: number, text: string): (readonly [number, number, Decoration])[] {
  const out: (readonly [number, number, Decoration])[] = [];
  const trimmed = text.trimStart();
  if (trimmed.startsWith(";")) {
    out.push([lineStart, lineStart + text.length, commentMark]);
    return out;
  }
  const label = LABEL_RE.exec(text.trim());
  if (label !== null) {
    out.push([lineStart, lineStart + text.length, functionMark]);
    return out;
  }
  const insn = OFFSET_RE.exec(text);
  if (insn === null) return out;
  const [, lead, offsetHex, gap1, mnemonic, gap2, rest] = insn;
  const offsetStart = lineStart + (lead?.length ?? 0);
  out.push([offsetStart, offsetStart + (offsetHex?.length ?? 0), commentMark]);
  const mnemonicStart = offsetStart + (offsetHex?.length ?? 0) + (gap1?.length ?? 0);
  out.push([mnemonicStart, mnemonicStart + (mnemonic?.length ?? 0), keywordMark]);
  if (rest === undefined || rest.length === 0) return out;
  const restStart = mnemonicStart + (mnemonic?.length ?? 0) + (gap2?.length ?? 0);
  for (const re of [STRING_RE, LABEL_REF_RE, REGISTER_RE, NUMBER_RE]) {
    re.lastIndex = 0;
    for (const m of rest.matchAll(re)) {
      const from = restStart + (m.index ?? 0);
      const to = from + m[0].length;
      const mark = re === STRING_RE ? stringMark : re === LABEL_REF_RE ? functionMark : re === REGISTER_RE ? variableMark : numberMark;
      out.push([from, to, mark]);
    }
  }
  return out;
}

function buildDecorations(view: EditorView): DecorationSet {
  // Every range collected then sorted once: the matchers above are not
  // guaranteed to visit a line's ranges in document order (STRING_RE before
  // REGISTER_RE could still find a later match first), and `RangeSetBuilder`
  // requires non-decreasing `from`.
  const ranges: (readonly [number, number, Decoration])[] = [];
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos);
      ranges.push(...lineRanges(line.from, line.text));
      if (line.to >= view.state.doc.length) break;
      pos = line.to + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const builder = new RangeSetBuilder<Decoration>();
  for (const [from, to, mark] of ranges) if (from < to) builder.add(from, to, mark);
  return builder.finish();
}

/** Line-based syntax colour for the disasm block (spec 20 §1.2's shared
 *  syntax palette). Recomputed on doc/viewport change only, which is cheap
 *  since it only walks the currently visible lines. */
export const disasmHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view);
    }
  },
  { decorations: (v) => v.decorations },
);
