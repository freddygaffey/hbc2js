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
  // Added 2026-09-05 with the fixture itself (F24-3 regression, two aliased
  // class-creation opcodes): same v98 hbc98-late/hbc99-mar2026 function-id
  // disagreement as 34-class-static-members above, resolved the same way by
  // `--opcode-table=hbc98-late`.
  "67-class-static-and-new",
  // Added 2026-09-05 with the fixture itself (the env-slot-order fix): its v98
  // build hits exactly the ambiguity above -- hbc98-late and hbc99-mar2026 both
  // verify structurally but disagree on function id 0 -- and
  // `--opcode-table=hbc98-late` resolves it the same way. Nothing about
  // `arr[i++]` over a captured environment is special here.
  "71-env-slot-captured-index",
  // Added 2026-09-05 with the fixture itself (the sibling-environment repro):
  // its v98 build hits exactly the ambiguity above -- hbc98-late and
  // hbc99-mar2026 both verify structurally but disagree on function ids 0 and
  // 1 -- and `--opcode-table=hbc98-late` resolves it the same way. Nothing
  // about the inlined IIFEs is special here; the v99 build of the same source
  // probes cleanly, and the fixture's own test
  // (tests/gate/emit/sibling-env-slots.test.ts) forces the table.
  "75-sibling-envs",
];

export function isKnownAmbiguousV98(group: string, name: string, version: number): boolean {
  return group === "constructs" && version === 98 && KNOWN_AMBIGUOUS_V98.includes(name);
}
