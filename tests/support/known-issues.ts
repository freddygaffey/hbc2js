// Known, understood parser limitations shared across test files (each documents its
// own reasoning at the call site; this just avoids duplicating the fixture list).
//
// M1 review Finding 1 fix: full-file structural verification
// (src/parse/layout.ts's decodeAndVerifyFunction) can PROVE that hbc98-late and
// hbc99-mar2026 genuinely disagree on these construct fixtures' meaning for at least
// one function -- hbc99-mar2026's misreading happens to realign and pass every
// bounds/id/jump-boundary check anyway. Per the review's own algorithm this is
// correctly E_LAYOUT_AMBIGUOUS on auto-probe (D8: refuse rather than silently guess).
// External evidence (this project's 223-function cross-validation against its own
// verified hbc99-mar2026 decoder, plus a hermes-disassembler cross-check) says
// hbc98-late is right for all of these; `--opcode-table=hbc98-late` resolves every
// one. See docs/STATUS.md's "Review responses" section for the full derivation.
export const KNOWN_AMBIGUOUS_V98: readonly string[] = [
  "20-let-const-tdz",
  "22-nested-closures-counters",
  "33-class-inheritance-super",
  "34-class-static-members",
  "40-spread-array",
  "41-spread-object",
  "43-template-literals",
  "47-typeof-instanceof-in",
  // Added 2026-09-05 with the fixture itself (the v99 setFunctionName fix): its
  // v98 build is ambiguous for exactly the reason above, and
  // `--opcode-table=hbc98-late` resolves it the same way. Nothing about the
  // fixture's own construct is special here.
  "64-computed-method-names",
];

export function isKnownAmbiguousV98(group: string, name: string, version: number): boolean {
  return group === "constructs" && version === 98 && KNOWN_AMBIGUOUS_V98.includes(name);
}
