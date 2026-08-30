// Mutation generation for negative testing of the harness itself.
//
// An equivalence checker that never says DIVERGENT is worthless, and the only
// way to know it says DIVERGENT often enough is to feed it programs that are
// deliberately wrong. These are textual mutations rather than AST rewrites
// (no parser dependency); every candidate is validated with `node --check`
// before use, and mutations that produce a syntactically invalid or
// textually unchanged program are discarded.
//
// The operators model the mistakes a decompiler actually makes: an off-by-one
// in a loop bound, an inverted branch condition, a dropped `finally`, a
// swapped `break`/`continue`, a lost statement from a mis-structured region.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OPERATORS = [
  {
    id: 'flip-relational',
    apply: (src, pick) => replaceNth(src, /(?<![<>=!])(<=|>=|<|>)(?!=)/g, pick, (m) => ({ '<': '<=', '<=': '<', '>': '>=', '>=': '>' })[m]),
  },
  {
    id: 'flip-equality',
    apply: (src, pick) => replaceNth(src, /(===|!==|==(?!=)|!=(?!=))/g, pick, (m) => ({ '===': '!==', '!==': '===', '==': '!=', '!=': '==' })[m]),
  },
  {
    id: 'bump-numeric-literal',
    apply: (src, pick) => replaceNth(src, /(?<![\w.$])(\d+)(?![\w.$n])/g, pick, (m) => String(Number(m) + 1)),
  },
  {
    id: 'break-to-continue',
    apply: (src, pick) => replaceNth(src, /\bbreak\b(?!\s*:)/g, pick, () => 'continue'),
  },
  {
    id: 'continue-to-break',
    apply: (src, pick) => replaceNth(src, /\bcontinue\b/g, pick, () => 'break'),
  },
  {
    id: 'negate-condition',
    apply: (src, pick) => replaceNth(src, /\b(if|while)\s*\(/g, pick, (m) => `${m}!(`),
  },
  {
    id: 'drop-finally',
    apply: (src, pick) => dropBlock(src, /\bfinally\s*\{/g, pick),
  },
  {
    id: 'drop-statement',
    apply: (src, pick) => dropStatementLine(src, pick),
  },
  {
    id: 'swap-adjacent-statements',
    apply: (src, pick) => swapAdjacentLines(src, pick),
  },
  {
    id: 'plus-to-minus',
    apply: (src, pick) => replaceNth(src, /(?<![+\-=<>!*/%&|^])\+(?![+=])/g, pick, () => '-'),
  },
  {
    id: 'and-to-or',
    apply: (src, pick) => replaceNth(src, /&&/g, pick, () => '||'),
  },
  {
    id: 'strip-await',
    apply: (src, pick) => replaceNth(src, /\bawait\s+/g, pick, () => ''),
  },
];

// Mutating inside a comment or a string literal produces a program that is
// trivially equivalent, which silently inflates the "survivor" count and hides
// real blind spots. (Found the hard way: `break-to-continue` was rewriting the
// word "break" in a fixture's header comment.) So every operator only fires at
// offsets this scanner classifies as code.
export function isCodeMask(src) {
  const mask = new Uint8Array(src.length); // 1 = code
  mask.fill(1);
  let i = 0;
  let prevSignificant = '';
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      mask.fill(0, i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      mask.fill(0, i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        if (c !== '`' && src[j] === '\n') break; // unterminated; bail out safely
        j++;
      }
      mask.fill(0, i, Math.min(j + 1, src.length));
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    // Regex literal: a `/` in a position where a value may start.
    if (c === '/' && (prevSignificant === '' || '(,=:[!&|?{};+-*%~^<>'.includes(prevSignificant) || /\b(return|typeof|case|in|of|new|delete|void|do|else)$/.test(src.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        const d = src[j];
        if (d === '\\') {
          j += 2;
          continue;
        }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') {
          j = i; // not a regex after all
          break;
        }
        j++;
      }
      if (j > i) {
        while (j < src.length && /[a-z]/.test(src[j + 1] ?? '')) j++;
        mask.fill(0, i, Math.min(j + 1, src.length));
        i = j + 1;
        prevSignificant = '/';
        continue;
      }
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return mask;
}

function matchIndices(src, re, mask) {
  const out = [];
  for (const m of src.matchAll(re)) {
    if (mask && !mask[m.index]) continue;
    out.push(m);
  }
  return out;
}

function replaceNth(src, re, pick, fn) {
  const ms = matchIndices(src, re, isCodeMask(src));
  if (!ms.length) return null;
  const m = ms[pick % ms.length];
  const rep = fn(m[0]);
  if (rep === undefined || rep === m[0]) return null;
  return { text: src.slice(0, m.index) + rep + src.slice(m.index + m[0].length), at: m.index, was: m[0], now: rep };
}

// Remove a whole `finally { ... }` (or any keyword-introduced block) by
// brace-matching from the opening brace.
function dropBlock(src, re, pick) {
  const ms = matchIndices(src, re, isCodeMask(src));
  if (!ms.length) return null;
  const m = ms[pick % ms.length];
  const open = src.indexOf('{', m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        return { text: src.slice(0, m.index) + src.slice(i + 1), at: m.index, was: m[0], now: '<removed>' };
      }
    }
  }
  return null;
}

// Statement-ish lines only: a line that ends in `;` and does not open or close
// a block, so removing it keeps the program parseable most of the time.
function dropStatementLine(src, pick) {
  const lines = src.split('\n');
  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('//')) continue;
    if (!t.endsWith(';')) continue;
    if (/[{}]/.test(t)) continue;
    if (/^(let|const|var|function)\b/.test(t)) continue; // dropping a declaration usually just throws
    cands.push(i);
  }
  if (!cands.length) return null;
  const i = cands[pick % cands.length];
  const was = lines[i].trim();
  lines.splice(i, 1);
  return { text: lines.join('\n'), at: i, was, now: '<removed>' };
}

function swapAdjacentLines(src, pick) {
  const lines = src.split('\n');
  const cands = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i].trim();
    const b = lines[i + 1].trim();
    if (!a || !b || a.startsWith('//') || b.startsWith('//')) continue;
    if (!a.endsWith(';') || !b.endsWith(';')) continue;
    if (/[{}]/.test(a) || /[{}]/.test(b)) continue;
    cands.push(i);
  }
  if (!cands.length) return null;
  const i = cands[pick % cands.length];
  const was = `${lines[i].trim()} / ${lines[i + 1].trim()}`;
  const t = lines[i];
  lines[i] = lines[i + 1];
  lines[i + 1] = t;
  return { text: lines.join('\n'), at: i, was, now: '<swapped>' };
}

let tmpCounter = 0;
export function syntaxOk(text) {
  const f = path.join(os.tmpdir(), `hbc2js-equiv-check-${process.pid}-${tmpCounter++}.js`);
  fs.writeFileSync(f, text);
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  } finally {
    fs.unlinkSync(f);
  }
}

// Generate up to `count` distinct, syntactically valid mutants of `src`,
// cycling deterministically through the operator list.
export function mutants(src, count = 6, seed = 0) {
  const out = [];
  const seen = new Set([src]);
  for (let round = 0; out.length < count && round < 6; round++) {
    for (let oi = 0; oi < OPERATORS.length && out.length < count; oi++) {
      const op = OPERATORS[(oi + seed) % OPERATORS.length];
      const r = op.apply(src, round + seed);
      if (!r || seen.has(r.text)) continue;
      if (!syntaxOk(r.text)) continue;
      seen.add(r.text);
      out.push({ operator: op.id, ...r });
    }
  }
  return out;
}

export const OPERATOR_IDS = OPERATORS.map((o) => o.id);
