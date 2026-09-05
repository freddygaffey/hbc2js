// tools/passes/ctor-this-refusals.ts -- classify a bundle's recovered class
// constructors by `ctor-this` refusal code (docs/specs/passes/26-ctor-this.md
// section 6, R-CT0..R-CT5).
//
// Why a tool and not a diagnostic: R-CT0 ("not this shape at all") is
// deliberately silent in the rung -- almost every class in a real bundle is
// R-CT0 and one `W_PASS_REFUSED` each would drown the diagnostics stream. This
// script instead wraps `ctorThis.match` for the duration of one whole-bundle
// decompile and re-derives the outcome of `foldCtorBody` for every class it
// sees, R-CT0 included, plus a coarse "shape" for the first executable
// statement of each refused constructor so the biggest refused *shape* (not
// just the biggest code) is visible.
//
//   node --max-old-space-size=8192 tools/passes/ctor-this-refusals.ts \
//     <bundle.hbc> [--corpus <roundtrip-corpus .json>] [--bucket <substring>]
//
// With `--corpus` (a `tools/e2e/roundtrip-corpus.ts --out` report) and
// `--bucket`, the counts are also broken down for the modules that own at
// least one function in that round-trip bucket -- which is how the
// `diff:GetOwnPrivateBySym/GetByVal` row in docs/BUGS.md gets classified.
//
// Output is aggregate only (counts per code/shape). It never prints a
// bundle-derived identifier, so its output is safe to quote in docs.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { Expr, Stmt } from "../../src/emit/ast.ts";
import { walk } from "../../src/passes/ast.ts";
import { ctorThis } from "../../src/passes/ctor-this/index.ts";
import type { ClassExpr } from "../../src/passes/ctor-this/match.ts";
import { classesIn, ctorMember, foldCtorBody } from "../../src/passes/ctor-this/match.ts";
import { superCall } from "../../src/passes/super-call/index.ts";
import { foldSuperBody } from "../../src/passes/super-call/match.ts";
import { splitProject } from "../../src/split/index.ts";

export interface ClassRecord {
  /** Refusal code, or "FOLD" when the rung folds this constructor. */
  readonly code: string;
  /** Coarse shape of the constructor's first executable statement. */
  readonly shape: string;
  /** The statement list holding the class also declares a `Symbol("#name")`
   *  private name -- i.e. this is a class the `private-fields` rung cares
   *  about (`src/passes/private-fields/match.ts` `symbolCandidates`). */
  readonly privateNames: boolean;
  readonly functionIndex: number;
}

function calleeName(e: Expr): string {
  if (e.k === "ident") return e.name;
  if (e.k === "member" && !e.computed && e.prop.k === "lit") return `${calleeName(e.obj)}.${e.prop.text}`;
  if (e.k === "member") return `${calleeName(e.obj)}[..]`;
  if (e.k === "lit") return e.text;
  return e.k;
}

/** A one-line, identifier-free description of what a refused constructor
 *  opens with: enough to tell "seeded Object.assign" from "super() call" from
 *  "plain field store" without naming anything from the bundle. */
export function ctorShape(body: readonly Stmt[]): string {
  let at = 0;
  while (at < body.length && (body[at]!.k === "comment" || body[at]!.k === "directive" || body[at]!.k === "decl")) at++;
  const s = body[at];
  if (s === undefined) return "empty";
  const value = s.k === "init" ? s.value : s.k === "expr" && s.expr.k === "assign" && s.expr.target.k === "ident" ? s.expr.value : null;
  if (value !== null) {
    if (value.k === "call") return `store:call ${calleeName(value.callee)}`;
    if (value.k === "member" && !value.computed && value.obj.k === "lit" && value.obj.text === "new.target") return `store:new.target.${value.prop.k === "lit" ? value.prop.text : "[..]"}`;
    return `store:${value.k}`;
  }
  if (s.k === "expr") return s.expr.k === "call" ? `expr:call ${calleeName(s.expr.callee)}` : `expr:${s.expr.k}`;
  return s.k;
}

/** `Symbol("#name")` anywhere in the statement list that holds the class. */
export function hasPrivateNames(list: readonly Stmt[]): boolean {
  let found = false;
  walk(list, {
    expr: (e) => {
      if (e.k !== "call" || e.args.length !== 1) return;
      if (e.callee.k !== "ident" || e.callee.name !== "Symbol") return;
      const a = e.args[0]!;
      if (a.k === "lit" && a.text.startsWith('"#')) found = true;
    },
  });
  return found;
}

/** Key that survives the pass driver's fixed point: the same class re-visited
 *  on a later iteration (or from an enclosing site list) overwrites its own
 *  record instead of adding one. */
function classKey(fnIdx: number, cls: ClassExpr): string {
  const ctor = ctorMember(cls);
  return `${fnIdx}|${cls.name ?? ""}|${cls.members.length}|${ctor === null ? -1 : ctor.params.length}`;
}

/**
 * Runs one whole-bundle decompile with passes on, spying on `ctor-this` --
 * and, when `superRecords` is given, on `super-call` (row R13, spec 28) in the
 * same run, so one decompile re-measures both rungs. `super-call` runs FIRST,
 * so its spy sees the untouched derived-constructor lowering while
 * `ctor-this`'s sees whatever survived it.
 */
export function classify(bytes: Uint8Array, moduleName: string, superRecords?: Map<string, ClassRecord>): Map<string, ClassRecord> {
  const records = new Map<string, ClassRecord>();
  const scSpy = superCall as unknown as { match: typeof superCall.match };
  const scOriginal = scSpy.match;
  if (superRecords !== undefined) {
    scSpy.match = (before, ctx) => {
      const priv = hasPrivateNames(before);
      for (const cls of classesIn(before)) {
        const ctor = ctorMember(cls);
        if (ctor === null) continue;
        const key = classKey(ctx.functionIndex, cls);
        // The driver's fixed point re-visits a class it has already folded,
        // and `foldSuperBody` then answers R-SC0 (its own super site is gone).
        // A recorded FOLD is final.
        if (superRecords.get(key)?.code === "FOLD") continue;
        const outcome = foldSuperBody(before, cls, ctor.body, ctor.params);
        superRecords.set(key, {
          code: "code" in outcome ? outcome.code : "FOLD",
          shape: ctorShape(ctor.body),
          privateNames: priv,
          functionIndex: ctx.functionIndex,
        });
      }
      return scOriginal(before, ctx);
    };
  }
  const spy = ctorThis as unknown as { match: typeof ctorThis.match };
  const original = spy.match;
  spy.match = (before, ctx) => {
    const priv = hasPrivateNames(before);
    for (const cls of classesIn(before)) {
      const ctor = ctorMember(cls);
      if (ctor === null) continue;
      const outcome = foldCtorBody(cls, ctor.body);
      records.set(classKey(ctx.functionIndex, cls), {
        code: "code" in outcome ? outcome.code : "FOLD",
        shape: ctorShape(ctor.body),
        privateNames: priv,
        functionIndex: ctx.functionIndex,
      });
    }
    return original(before, ctx);
  };
  try {
    splitProject(bytes, { moduleName, passes: {} });
  } finally {
    spy.match = original;
    scSpy.match = scOriginal;
  }
  return records;
}

interface CorpusReport {
  readonly modes: Record<string, { readonly results: readonly { readonly fn: number; readonly module: number; readonly bucket: string }[] } | undefined>;
}

/** fn -> module, and the set of modules owning a function in `bucket`. */
function corpusIndex(path: string, bucket: string): { readonly moduleOf: Map<number, number>; readonly hot: Set<number>; readonly hits: number } {
  const report = JSON.parse(readFileSync(path, "utf8")) as CorpusReport;
  const moduleOf = new Map<number, number>();
  const hot = new Set<number>();
  let hits = 0;
  for (const mode of Object.values(report.modes)) {
    for (const r of mode?.results ?? []) {
      moduleOf.set(r.fn, r.module);
      if (bucket.length > 0 && r.bucket.includes(bucket)) {
        hot.add(r.module);
        hits++;
      }
    }
  }
  return { moduleOf, hot, hits };
}

function tally(rows: readonly ClassRecord[], label: string): string {
  const byCode = new Map<string, number>();
  const byShape = new Map<string, number>();
  for (const r of rows) {
    byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
    if (r.code !== "FOLD") byShape.set(`${r.code} ${r.shape}`, (byShape.get(`${r.code} ${r.shape}`) ?? 0) + 1);
  }
  const sort = (m: Map<string, number>): [string, number][] => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = [`\n## ${label}: ${rows.length} class constructor(s)`, "", "| code | classes |", "|---|---|"];
  for (const [k, n] of sort(byCode)) out.push(`| ${k} | ${n} |`);
  out.push("", "| refused shape | classes |", "|---|---|");
  for (const [k, n] of sort(byShape).slice(0, 12)) out.push(`| \`${k}\` | ${n} |`);
  return out.join("\n");
}

async function main(argv: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let corpus: string | undefined;
  let bucket = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--corpus") corpus = String(argv[++i]);
    else if (a === "--bucket") bucket = String(argv[++i]);
    else positional.push(a);
  }
  const bundle = positional[0];
  if (bundle === undefined) throw new Error("usage: ctor-this-refusals.ts <bundle.hbc> [--corpus <json>] [--bucket <substring>]");
  const superMap = new Map<string, ClassRecord>();
  const records = [...classify(new Uint8Array(readFileSync(bundle)), basename(bundle), superMap).values()];
  const superRows = [...superMap.values()];
  process.stdout.write(`# ctor-this / super-call refusal classification -- ${basename(bundle)}\n`);
  process.stdout.write(tally(records, "ctor-this (R-CT*), whole bundle") + "\n");
  process.stdout.write(tally(superRows, "super-call (R-SC*), whole bundle") + "\n");
  process.stdout.write(tally(records.filter((r) => r.privateNames), "classes with a Symbol(\"#name\") private name in scope") + "\n");
  if (corpus !== undefined) {
    const { moduleOf, hot, hits } = corpusIndex(corpus, bucket);
    process.stdout.write(`\n(bucket \`${bucket}\`: ${hits} function(s) in ${hot.size} module(s))\n`);
    process.stdout.write(tally(records.filter((r) => hot.has(moduleOf.get(r.functionIndex) ?? -1)), `classes in modules owning a \`${bucket}\` function`) + "\n");
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`ctor-this-refusals: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exit(1);
  });
}
