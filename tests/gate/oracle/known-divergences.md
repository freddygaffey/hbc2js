# Known divergences from `hbc-file-parser` (T6 oracle cross-check)

Per docs/specs/01-parser.md §8 T6: "Any divergence not on it fails the test." Every
entry here must name the byte evidence, not just assert a difference exists.

| # | Divergence | Evidence |
|---|---|---|
| 1 | v99's `DebugOffsets` | hermes-dec reads a 12-byte, 2-field `DebugOffsets` (`source_locs`, `scope_desc_data`) for every version. The real v99 (class D/E) struct is 4 bytes, one field (`sourceLocations`) — docs/HBC-FORMAT.md §4. hermes-dec's `scope_desc_data` for a v99 function is actually the *next* function's bytecode offset (it reads 4 bytes past the end of the struct). We assert our own value and never compare this field. |
| 2 | v99 header field names | hermes-dec labels the static_h (class D/E) header fields with the classic (pre-v97) names positionally. `tests/gate/oracle/hbc-file-parser.test.ts` maps by the label hermes-dec actually prints (which happens to still read correctly for the fields this project checks), not assuming its printed name matches our field's semantic name for class D/E files. |
| 3 | v99 builtin names | hermes-dec's builtin table may not match this project's pinned commit (`hbc99-mar2026`, `913d31ac`) exactly for less common builtins. M1 does not decode builtin call sites at all (that's spec 02's `GetBuiltinClosure`/`CallBuiltin` operand resolution), so this test never compares builtin names or numbers — noted here for whoever writes that spec 02 oracle cross-check next, so the comparison is by builtin *number*, not name, from the start. |

This list must not grow without a new row explaining the byte evidence — see spec 01
§9's acceptance criterion ("T6 passes ... with an allowlist of at most the three
entries named in T6").
