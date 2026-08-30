// D3 prototype: canonicalise `hermesc -dump-bytecode` output so that two
// disassemblies of *semantically* equal programs compare equal despite the
// incidental choices Hermes's backend makes.
//
// What has to be normalised, and why:
//
//   Source hash / file name  — a hash of the source text; always differs.
//   String table             — Hermes orders strings by kind then by first use;
//                              a decompiler that emits the same code in a
//                              different textual order gets a different table.
//                              The strings themselves already appear inline in
//                              the instruction operands, so the table is
//                              redundant for a semantic diff. Dropped.
//   Register numbers         — regalloc output. Renamed by order of first
//                              appearance within each function (r13 -> %0, ...).
//                              Sound as a *canonical form only if* the
//                              instruction sequence is otherwise identical;
//                              a different sequence can rename to the same
//                              thing, so this is a strong equality test but not
//                              a proof of equivalence.
//   Labels                   — renumbered by first appearance (L3 -> @0).
//   Property-cache indices   — `TryGetById r, r0, 1, "print"` — the `1` is an
//                              inline-cache slot, assigned per function in
//                              emission order. Masked to `#`.
//   Function names           — decompiled output uses generated names.
//                              Masked; arity is kept, register/symbol counts
//                              are dropped (they are allocator output).
//   Debug-table offsets      — dropped.
//
// The remaining text is: for each function, its arity and its instruction
// sequence with opcode, register roles and literal operands intact. That is a
// tight, cheap approximation of "same bytecode".

const DROP_LINE = [
  /^\s*Source hash:/,
  /^\s*Offset in debug table:/,
  /^\s*Bytecode version number:/,
  /^\s*Function count:/,
  /^\s*String count:/,
  /^\s*BigInt count:/,
  /^\s*String Kind Entry count:/,
  /^\s*RegExp count:/,
  /^\s*Segment ID:/,
  /^\s*CommonJS module count/,
  /^\s*Function source count:/,
  /^\s*Bytecode options:/,
  /^\s*staticBuiltins:/,
  /^\s*cjsModulesStaticallyResolved:/,
  /^\s*Bytecode File Information:/,
];

export function normaliseDisassembly(text, opts = {}) {
  const maskFunctionNames = opts.maskFunctionNames ?? true;
  const lines = text.split('\n');
  const out = [];

  let inStringTable = false;
  let regs = new Map();
  let labels = new Map();
  let pendingFunction = null;
  let body = [];
  const functions = [];

  const regName = (n) => {
    if (!regs.has(n)) regs.set(n, `%${regs.size}`);
    return regs.get(n);
  };
  const labelName = (n) => {
    if (!labels.has(n)) labels.set(n, `@${labels.size}`);
    return labels.get(n);
  };

  const flush = () => {
    if (pendingFunction !== null) functions.push({ header: pendingFunction, body });
    pendingFunction = null;
    body = [];
    regs = new Map();
    labels = new Map();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    // Everything from the first debug section onward is source-position data:
    // file paths, line/column numbers, scope descriptors. It differs whenever
    // the two files have different names or line counts, which they always do.
    if (/^(Debug \w+ table:|Textified callees table:)/.test(line)) break;
    if (/^Global String Table:/.test(line)) {
      inStringTable = true;
      continue;
    }
    if (inStringTable) {
      // Table entries look like `s0[ASCII, 0..9]:  computed=` — skip them all,
      // and end the section at the first blank line.
      if (line.trim() === '') {
        inStringTable = false;
      }
      continue;
    }
    if (DROP_LINE.some((re) => re.test(line))) continue;
    if (line.trim() === '') continue;

    // Function header: `Function<gen>(1 params, 23 registers, 4 symbols):`
    const fh = /^Function<([^>]*)>\((\d+) params(?:, (\d+) registers)?(?:, (\d+) symbols)?\)/.exec(line);
    if (fh) {
      flush();
      const name = maskFunctionNames ? (fh[1] === 'global' ? 'global' : '~') : fh[1];
      pendingFunction = `Function<${name}>(${fh[2]} params)`;
      continue;
    }

    // Label definition: `L3:`
    const ld = /^(L\d+):$/.exec(line.trim());
    if (ld) {
      body.push(`${labelName(ld[1])}:`);
      continue;
    }

    body.push(normaliseInstruction(line, regName, labelName));
  }
  flush();

  // Function *order* in the bytecode file follows source order of definitions.
  // Compare in order by default; `--sort-functions` compares them as a multiset
  // so that a decompiler that emits nested functions in a different order is
  // not penalised.
  const rendered = functions.map((f) => [f.header, ...f.body.map((b) => '    ' + b)].join('\n'));
  if (opts.sortFunctions) rendered.sort();
  return rendered.join('\n\n') + '\n';
}

function normaliseInstruction(line, regName, labelName) {
  let s = line.trim();
  // Collapse the opcode/operand column padding.
  s = s.replace(/^(\S+)\s+/, '$1 ');

  // Labels before registers: `L1` and `r1` are unambiguous, but do labels first
  // so a jump target is never mistaken for a register.
  s = s.replace(/\bL(\d+)\b/g, (_, n) => labelName('L' + n));
  s = s.replace(/\br(\d+)\b/g, (_, n) => regName('r' + n));

  // Inline-cache / property-cache slot: the bare integer operand that sits
  // between the object register and the quoted property name.
  s = s.replace(/(,\s*)\d+(\s*,\s*"(?:[^"\\]|\\.)*")/g, '$1#$2');

  return s;
}

// Line-oriented diff of two normalised disassemblies: first divergence plus a
// similarity ratio, so the round-trip check can be used as a ratchet (percent
// of functions matching) before it is strict enough to be a gate.
export function diffNormalised(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  let i = 0;
  while (i < Math.min(la.length, lb.length) && la[i] === lb[i]) i++;
  const setB = new Set(lb);
  let common = 0;
  for (const l of la) if (setB.has(l)) common++;
  const similarity = la.length + lb.length === 0 ? 1 : (2 * common) / (la.length + lb.length);
  return {
    equal: la.length === lb.length && i === la.length,
    firstDivergence: i < Math.max(la.length, lb.length) ? { line: i + 1, a: la[i] ?? '<eof>', b: lb[i] ?? '<eof>' } : null,
    similarity,
    lines: [la.length, lb.length],
  };
}
