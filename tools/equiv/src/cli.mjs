#!/usr/bin/env node
// hbc2js-equiv — differential semantic-equivalence checker.
//
//   hbc2js-equiv a.js b.js
//   hbc2js-equiv --hbc original.hbc decompiled.js
//   hbc2js-equiv normalise dump-a.txt dump-b.txt
//
// Exit codes: 0 EQUIVALENT, 1 DIVERGENT, 2 INCONCLUSIVE, 3 harness error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram } from './runner.mjs';
import { compareTraces, VERDICT } from './compare.mjs';
import { renderRecord } from './trace.mjs';
import { hbcVersion, pickHermesVM, runHermes, printLines, findHermesVMs } from './hermes.mjs';
import { normaliseDisassembly, diffNormalised } from './normalise-disasm.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const USAGE = `hbc2js-equiv — is this decompiled JavaScript the same program?

  hbc2js-equiv <a.js> <b.js>              compare two JS programs by execution trace
  hbc2js-equiv --hbc <a.hbc> <b.js>       compare original bytecode (Hermes VM) with decompiled JS
  hbc2js-equiv normalise <a.txt> <b.txt>  diff two 'hermesc -dump-bytecode' dumps, normalised

Options
  --timeout <ms>      wall-clock budget per program (default 5000)
  --seed <n>          PRNG seed for Math.random and for fuzzing (default 0)
  --seeds <n>         re-run with seeds 0..n-1; all must agree (default 1)
  --fuzz[=<n>]        differentially call every function the program leaves on
                      the global object, <n> seeded argument tuples each (default 50)
  --relax <list>      comma-separated: fn-names, key-order, error-messages
  --hermes <path>     explicit hermes VM binary
  --engine <e>        node | hermes | auto   (default auto: hermes when --hbc, else node)
  --trace-out <dir>   write both traces as .ndjson for inspection
  --max-records <n>   cap trace length (default 20000)
  --json              machine-readable result on stdout
  --quiet             verdict line only
`;

function parseArgs(argv) {
  const o = {
    timeout: 5000,
    seed: 0,
    seeds: 1,
    fuzz: 0,
    relax: [],
    maxRecords: 20000,
    json: false,
    quiet: false,
    engine: 'auto',
    hermes: null,
    traceOut: null,
    hbc: false,
    positional: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--hbc') o.hbc = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--timeout') o.timeout = Number(argv[++i]);
    else if (a === '--seed') o.seed = Number(argv[++i]);
    else if (a === '--seeds') o.seeds = Number(argv[++i]);
    else if (a === '--fuzz') o.fuzz = 50;
    else if (a.startsWith('--fuzz=')) o.fuzz = Number(a.slice(7));
    else if (a === '--relax') o.relax = String(argv[++i]).split(',').filter(Boolean);
    else if (a === '--hermes') o.hermes = argv[++i];
    else if (a === '--engine') o.engine = argv[++i];
    else if (a === '--trace-out') o.traceOut = argv[++i];
    else if (a === '--max-records') o.maxRecords = Number(argv[++i]);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else o.positional.push(a);
  }
  return o;
}

async function main(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${e.message}\n\n${USAGE}`);
    return 3;
  }
  if (o.help || o.positional.length === 0) {
    process.stdout.write(USAGE);
    return o.help ? 0 : 3;
  }

  if (o.positional[0] === 'normalise') return normaliseCmd(o);

  const [a, b] = o.positional;
  if (!a || !b) {
    process.stderr.write(`need two files\n\n${USAGE}`);
    return 3;
  }
  for (const f of [a, b]) {
    if (!fs.existsSync(f)) {
      process.stderr.write(`no such file: ${f}\n`);
      return 3;
    }
  }

  if (o.hbc || a.endsWith('.hbc')) return hermesCmd(a, b, o);
  return nodeCmd(a, b, o);
}

async function nodeCmd(a, b, o) {
  const results = [];
  for (let s = 0; s < Math.max(1, o.seeds); s++) {
    const seed = o.seeds > 1 ? s : o.seed;
    const opts = {
      seed,
      timeout: o.timeout,
      fuzz: o.fuzz,
      relax: o.relax,
      maxRecords: o.maxRecords,
      syncTimeout: Math.max(100, o.timeout - 500),
    };
    const [ta, tb] = await Promise.all([runProgram(a, opts), runProgram(b, opts)]);
    if (o.traceOut) writeTraces(o.traceOut, seed, ta, tb);
    results.push({ seed, ...compareTraces(ta, tb), a: ta, b: tb });
  }

  // Worst verdict across seeds wins: any DIVERGENT is a divergence.
  const div = results.find((r) => r.verdict === VERDICT.DIVERGENT);
  const inc = results.find((r) => r.verdict === VERDICT.INCONCLUSIVE);
  const chosen = div ?? inc ?? results[0];

  report(chosen, { a, b, mode: 'node-vm-trace', seeds: results.length }, o);
  return code(chosen.verdict);
}

async function hermesCmd(a, b, o) {
  const isHbc = a.endsWith('.hbc');
  const version = isHbc ? hbcVersion(a) : null;
  const vm = o.hermes ? { path: o.hermes, version } : version !== null ? pickHermesVM(REPO, version) : null;

  if (!vm) {
    const have = findHermesVMs(REPO).map((h) => `v${h.version}`).join(', ') || 'none';
    const out = {
      verdict: VERDICT.INCONCLUSIVE,
      why: `no Hermes VM for HBC version ${version}; available: ${have}. The Hermes VM refuses bytecode whose version is not exactly its own, and only hermes-engine-cli ships a VM (HBC <= 89). Build Hermes from source for v94/v99, or fall back to 'hbc2js-equiv a.js b.js' after decompiling.`,
      mode: 'hermes',
    };
    process.stdout.write(o.json ? JSON.stringify(out, null, 2) + '\n' : `INCONCLUSIVE — ${out.why}\n`);
    return 2;
  }

  const ra = runHermes(vm.path, a, { timeout: o.timeout, bytecode: isHbc });
  const rb = runHermes(vm.path, b, { timeout: o.timeout, bytecode: false });

  const la = ra.lines;
  const lb = rb.lines;
  let i = 0;
  while (i < Math.min(la.length, lb.length) && la[i] === lb[i]) i++;
  const equal = la.length === lb.length && i === la.length;

  const result = {
    verdict: equal ? (la.length ? VERDICT.EQUIVALENT : VERDICT.INCONCLUSIVE) : VERDICT.DIVERGENT,
    why: equal
      ? la.length
        ? `${la.length} output lines matched under Hermes ${vm.dir ?? ''}`.trim()
        : 'both programs produced no output under Hermes; nothing was observed'
      : `output diverges at line ${i + 1}`,
    mode: `hermes:${vm.path}`,
    divergence: equal ? null : { index: i, a: la[i] ?? '<end>', b: lb[i] ?? '<end>' },
    context: equal ? null : lineContext(la, lb, i),
  };
  report(result, { a, b, mode: result.mode, seeds: 1 }, o);
  return code(result.verdict);
}

function lineContext(la, lb, i, span = 3) {
  const out = [];
  for (let j = Math.max(0, i - span); j < Math.min(Math.max(la.length, lb.length), i + span + 1); j++) {
    const A = la[j] ?? '<end>';
    const B = lb[j] ?? '<end>';
    if (A === B) out.push(`  ${String(j + 1).padStart(4)}   ${A}`);
    else {
      out.push(`  ${String(j + 1).padStart(4)} - ${A}`);
      out.push(`  ${String(j + 1).padStart(4)} + ${B}`);
    }
  }
  return out.join('\n');
}

function normaliseCmd(o) {
  const [, a, b] = o.positional;
  if (!a) {
    process.stderr.write('normalise needs one or two dump files\n');
    return 3;
  }
  const na = normaliseDisassembly(fs.readFileSync(a, 'utf8'));
  if (!b) {
    process.stdout.write(na);
    return 0;
  }
  const nb = normaliseDisassembly(fs.readFileSync(b, 'utf8'));
  const d = diffNormalised(na, nb);
  if (o.json) {
    process.stdout.write(JSON.stringify(d, null, 2) + '\n');
  } else if (d.equal) {
    process.stdout.write(`EQUIVALENT (normalised disassembly identical, ${d.lines[0]} lines)\n`);
  } else {
    process.stdout.write(
      `DIVERGENT (similarity ${(d.similarity * 100).toFixed(1)}%, ${d.lines[0]} vs ${d.lines[1]} lines)\n` +
        `  first difference at normalised line ${d.firstDivergence.line}:\n` +
        `    - ${d.firstDivergence.a}\n    + ${d.firstDivergence.b}\n`
    );
  }
  return d.equal ? 0 : 1;
}

function writeTraces(dir, seed, ta, tb) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `a.seed${seed}.ndjson`), ta.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `b.seed${seed}.ndjson`), tb.records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function report(result, meta, o) {
  if (o.json) {
    process.stdout.write(
      JSON.stringify(
        {
          verdict: result.verdict,
          why: result.why,
          a: meta.a,
          b: meta.b,
          mode: meta.mode,
          seeds: meta.seeds,
          evidence: result.evidence ?? null,
          records: result.records ?? null,
          divergence: result.divergence ?? null,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }
  process.stdout.write(`${result.verdict} — ${result.why}\n`);
  if (o.quiet) return;
  if (result.divergence) {
    process.stdout.write(`\n  a = ${meta.a}\n  b = ${meta.b}\n\n${result.context}\n`);
  }
}

function code(v) {
  return v === VERDICT.EQUIVALENT ? 0 : v === VERDICT.DIVERGENT ? 1 : 2;
}

process.exitCode = await main(process.argv.slice(2));
