# Template literals — plain string concatenation, no dedicated opcode

**Fixture:** `43-template-literals`
**Confidence:** ✅ single-version (v94, default `-O`)

## 1. Source

```js
const name = 'World';
const simple = `Hello, ${name}!`;
```

## 2. Bytecode

`tools/hermesc/v94/hermesc -O0 -dump-bytecode -pretty-disassemble=false`:
a template literal with N interpolations compiles to exactly the same
`LoadConstString`/`Add`/`AddS` chain a hand-written
`'Hello, ' + name + '!'` would produce — confirmed by the absence of any
opcode in the disassembly that doesn't already appear in ordinary
string-concatenation fixtures (e.g. `01-if-else-chain`'s
`'check(' + n + ')'`). There is no "build a template" opcode, no array of
raw/cooked string segments passed anywhere, and no distinct marker
separating "this `Add` came from a template literal" from "this `Add` came
from source-level `+`". Nested templates (`` `outer-${`inner-${1+1}`}-end` ``)
compile to nested `Add` chains with no additional structure — the nesting
is invisible once lowered.

## 3. CFG/IR shape

Straight-line expression evaluation only — no control flow, no distinct
terminator, nothing for spec 03's CFG builder to see beyond ordinary
instructions inside a block.

## 4. Matcher

**There is nothing to match at the bytecode level.** A `template-literal`
recovery pass, if one is ever written, is purely a stage-B **readability**
transform: it looks for a chain of `Add`/`AddS` on string operands
(post-`expr-rebuild`, spec 07 §6 pass 1) and *chooses* to render it as a
template literal instead of `+` concatenation when it improves readability
(e.g. more than one interpolation, or a multi-line string literal operand
present in the chain, which reveals the original probably used a template).
This is fundamentally a heuristic stylistic choice, not an idiom recovery
— **the source information needed to know for certain "this `+` chain was
originally a template literal" does not survive compilation**, and no
pass should claim otherwise.

## 5. Writer

Emits `` `...${expr}...` `` for a qualifying `Add`/`AddS` chain, or leaves it
as `+` concatenation — a judgement call, not a correctness requirement.

## 6. Checker

N/A beyond the stage-B default (same effect sequence, same value) — there
is no idiom-specific invariant to assert.

## 7. Version differences

None expected or observed — `AddS` (string-specialised add, seen in
`while-loop.md`'s v99 dumps) is an unrelated numeric/string-specialisation
optimizer detail, not a template-literal-specific opcode; it appears
equally in ordinary `+` concatenation.
