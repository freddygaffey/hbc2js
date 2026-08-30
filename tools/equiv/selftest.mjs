#!/usr/bin/env node
// Self-test for the equivalence harness, runnable in one command:
//
//   node tools/equiv/selftest.mjs            # phases 1 and 2
//   node tools/equiv/selftest.mjs --hermes   # + phase 3 (Hermes VM cross-check)
//   node tools/equiv/selftest.mjs --mutants 8 --only 12,16,31
//
// Phase 1 — determinism and fidelity. Every constructs/*/source.js is executed
//   twice, in two independent child processes, and the traces must be
//   identical (this tests the sandbox's determinism, not merely reflexivity).
//   The `print` projection of the trace must equal the fixture's expected.txt.
//
// Phase 2 — mutation kill rate. Deliberately broken copies of each fixture must
//   be reported DIVERGENT. Survivors are the interesting output: each one is a
//   class of decompiler bug this harness would not catch.
//
// Phase 3 — Hermes VM cross-check. Each fixture's own .hbc, run under a
//   matching Hermes VM, compared against the Node trace. Divergences here are
//   engine differences, not harness bugs, and they tell you which oracle the
//   real harness must trust.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runProgram } from './src/runner.mjs';
import { compareTraces, VERDICT } from './src/compare.mjs';
import { mutants, OPERATOR_IDS } from './src/mutate.mjs';
import { findHermesVMs, hbcVersion, runHermes, printLines } from './src/hermes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const CONSTRUCTS = path.join(REPO, 'tests', 'fixtures', 'constructs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hbc2js-equiv-selftest-'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const MUTANTS = Number(opt('--mutants', 6));
const ONLY = opt('--only', null);
const DO_HERMES = flag('--hermes');
const VERBOSE = flag('--verbose');
const FUZZ = flag('--fuzz') ? Number(opt('--fuzz-cases', 30)) : 0;
// Phase 1 never fuzzes: it compares the `print` projection against expected.txt,
// and fuzz-driven calls would append output of their own.
const RUN_OPTS = { timeout: 8000, seed: 0, fuzz: 0, relax: [], maxRecords: 20000, syncTimeout: 7000 };
const P2_OPTS = { ...RUN_OPTS, fuzz: FUZZ, timeout: 15000, syncTimeout: 14000 };

const fixtures = fs
  .readdirSync(CONSTRUCTS)
  .filter((d) => fs.existsSync(path.join(CONSTRUCTS, d, 'source.js')))
  .filter((d) => (ONLY ? ONLY.split(',').some((p) => d.startsWith(p)) : true))
  .sort();

// A tiny promise pool; the child processes are the expensive part.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await fn(items[j], j);
      }
    })
  );
  return out;
}

const CONC = Math.max(2, Math.min(8, os.cpus().length));

// ---------------------------------------------------------------- phase 1
console.log(`# phase 1 — determinism + expected.txt fidelity (${fixtures.length} fixtures)\n`);

const phase1 = await pool(fixtures, CONC, async (name) => {
  const dir = path.join(CONSTRUCTS, name);
  const src = path.join(dir, 'source.js');
  const [t1, t2] = await Promise.all([runProgram(src, RUN_OPTS), runProgram(src, RUN_OPTS)]);
  const cmp = compareTraces(t1, t2);
  const expected = fs.readFileSync(path.join(dir, 'expected.txt'), 'utf8').replace(/\n$/, '');
  const got = printLines(t1.records).join('\n');
  return {
    name,
    trace: t1,
    deterministic: cmp.verdict === VERDICT.EQUIVALENT,
    verdict: cmp.verdict,
    why: cmp.why,
    fidelity: got === expected,
    expected,
    got,
    evidence: cmp.evidence,
  };
});

let p1fail = 0;
for (const r of phase1) {
  const ok = r.deterministic && r.fidelity;
  if (!ok) {
    p1fail++;
    console.log(`FAIL ${r.name}`);
    if (!r.deterministic) console.log(`     non-deterministic / not self-equivalent: ${r.verdict} — ${r.why}`);
    if (!r.fidelity) {
      console.log('     print-trace does not match expected.txt:');
      const a = r.expected.split('\n');
      const b = r.got.split('\n');
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`       line ${i + 1}\n       - ${a[i] ?? '<end>'}\n       + ${b[i] ?? '<end>'}`);
          break;
        }
      }
    }
  } else if (VERBOSE) {
    console.log(`ok   ${r.name} (${r.evidence} evidence records)`);
  }
}
console.log(`\nphase 1: ${fixtures.length - p1fail}/${fixtures.length} passed\n`);

// ---------------------------------------------------------------- phase 2
console.log(`# phase 2 — mutation kill rate (up to ${MUTANTS} mutants per fixture, fuzz=${FUZZ})\n`);

const baseByName = new Map(phase1.map((r) => [r.name, r.trace]));
if (FUZZ > 0) {
  const rerun = await pool(fixtures, CONC, (name) => runProgram(path.join(CONSTRUCTS, name, 'source.js'), P2_OPTS));
  fixtures.forEach((n, i) => baseByName.set(n, rerun[i]));
}

const phase2 = await pool(fixtures, CONC, async (name) => {
  const dir = path.join(CONSTRUCTS, name);
  const src = fs.readFileSync(path.join(dir, 'source.js'), 'utf8');
  const ms = mutants(src, MUTANTS, 0);
  const base = baseByName.get(name);
  const results = [];
  for (const m of ms) {
    const f = path.join(TMP, `${name}.${m.operator}.${results.length}.js`);
    fs.writeFileSync(f, m.text);
    const t = await runProgram(f, P2_OPTS);
    const cmp = compareTraces(base, t);
    results.push({ ...m, verdict: cmp.verdict, why: cmp.why });
  }
  return { name, results };
});

let killed = 0;
let survived = 0;
let inconclusive = 0;
const survivors = [];
const byOperator = new Map(OPERATOR_IDS.map((id) => [id, { killed: 0, survived: 0, inconclusive: 0 }]));

for (const f of phase2) {
  for (const r of f.results) {
    const bucket = byOperator.get(r.operator);
    if (r.verdict === VERDICT.DIVERGENT) {
      killed++;
      bucket.killed++;
    } else if (r.verdict === VERDICT.INCONCLUSIVE) {
      inconclusive++;
      bucket.inconclusive++;
      survivors.push({ ...r, fixture: f.name });
    } else {
      survived++;
      bucket.survived++;
      survivors.push({ ...r, fixture: f.name });
    }
  }
}
const total = killed + survived + inconclusive;

if (survivors.length) {
  console.log('Mutants NOT reported DIVERGENT (each is a blind spot worth understanding):\n');
  for (const s of survivors) {
    console.log(`  ${s.verdict.padEnd(12)} ${s.fixture} [${s.operator}] ${trunc(s.was)} -> ${trunc(s.now)}`);
  }
  console.log('');
}
console.log('Per-operator kill rate:');
for (const [id, b] of byOperator) {
  const n = b.killed + b.survived + b.inconclusive;
  if (!n) continue;
  console.log(`  ${id.padEnd(26)} ${b.killed}/${n} killed${b.survived ? `, ${b.survived} EQUIVALENT` : ''}${b.inconclusive ? `, ${b.inconclusive} INCONCLUSIVE` : ''}`);
}
console.log(`\nphase 2: ${killed}/${total} mutants killed (${((killed / Math.max(1, total)) * 100).toFixed(1)}%), ${survived} survived as EQUIVALENT, ${inconclusive} INCONCLUSIVE\n`);

// ---------------------------------------------------------------- phase 3
let p3 = null;
if (DO_HERMES) {
  const vms = findHermesVMs(REPO);
  console.log(`# phase 3 — Hermes VM cross-check (VMs found: ${vms.map((v) => v.dir).join(', ') || 'none'})\n`);
  if (!vms.length) {
    console.log('  skipped: no `hermes` binary under tools/hermesc/*/ (run tools/get-hermesc.sh 84)\n');
  } else {
    const rows = [];
    for (const vmi of vms) {
      for (const r of phase1) {
        const hbc = path.join(CONSTRUCTS, r.name, `v${vmi.version}.hbc`);
        if (!fs.existsSync(hbc)) continue;
        if (hbcVersion(hbc) !== vmi.version) continue;
        const h = runHermes(vmi.path, hbc, { timeout: 10000, bytecode: true });
        // Compare rendered text, not record boundaries: one `print` call of a
        // multi-line template literal is one trace record but several lines of
        // Hermes stdout, and comparing those directly reports a phantom
        // divergence (43-template-literals).
        const nodeLines = printLines(r.trace.records).join('\n').split('\n');
        const same = h.lines.length === nodeLines.length && h.lines.every((l, i) => l === nodeLines[i]);
        rows.push({ vm: vmi.dir, name: r.name, same, hermes: h.lines, node: nodeLines });
      }
    }
    const bad = rows.filter((x) => !x.same);
    for (const x of bad) {
      let i = 0;
      while (i < Math.min(x.hermes.length, x.node.length) && x.hermes[i] === x.node[i]) i++;
      console.log(`DIVERGES ${x.vm} ${x.name} at line ${i + 1}`);
      console.log(`     node   : ${x.node[i] ?? '<end>'}`);
      console.log(`     hermes : ${x.hermes[i] ?? '<end>'}`);
    }
    console.log(`\nphase 3: ${rows.length - bad.length}/${rows.length} bytecode fixtures behave identically under the Hermes VM and the Node sandbox\n`);
    p3 = { total: rows.length, diverging: bad.length, names: bad.map((x) => `${x.vm}:${x.name}`) };
  }
}

// ---------------------------------------------------------------- summary
console.log('# summary');
console.log(`  phase 1 determinism+fidelity : ${fixtures.length - p1fail}/${fixtures.length}`);
console.log(`  phase 2 mutation kill rate   : ${killed}/${total} (${survivors.length} not killed)`);
if (p3) console.log(`  phase 3 hermes agreement     : ${p3.total - p3.diverging}/${p3.total}${p3.diverging ? ` (diverging: ${p3.names.join(', ')})` : ''}`);

fs.rmSync(TMP, { recursive: true, force: true });

// Phase 1 must be perfect. Phase 2 survivors are reported, not fatal — the
// point of the check is to enumerate blind spots, and a mutation that produces
// a genuinely equivalent program is not a harness bug.
process.exitCode = p1fail === 0 ? 0 : 1;

function trunc(s, n = 48) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
