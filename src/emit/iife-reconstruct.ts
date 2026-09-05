// docs/specs/passes/27-iife-reconstruct.md -- reconstructing an INLINED IIFE.
//
// `hermesc -O` splices an immediately-invoked function expression into its
// caller but keeps the callee's OWN environment, so a caller that inlined
// several of them ends up with several environments side by side. Our emitter
// declares every environment a function owns as one flat `let _e<env>_<slot>`
// list in the function's top scope (src/emit/function.ts `ownedEnvSlots`), and
// recompiling that source gives hermesc a single scope: it allocates ONE
// environment with the slots renumbered end to end. That is the
// `diff:CreateFunctionEnvironment(imm)` / `diff:LoadFromEnvironment(imm)`
// bucket in docs/BUGS.md, reproduced by fixture 75-sibling-envs.
//
// The only source form that round-trips a sibling environment is the IIFE it
// came from (docs/reports/2026-09-05-sibling-envs.md section 3; ruled
// default-on in docs/PUSHBACK.md P-41), so this step wraps each such
// environment's statement range back up as `(function () { ... })();`.
//
// It is a placement step over the assembled statement list, not a stage-B
// rung: it needs the env graph (which environment owns which `_e<env>_<slot>`
// name, and which environment is the PARENT of which) and the emitter's own
// hoisted-children list, neither of which survives into `src/passes`, where a
// rung would have to re-derive environment ownership from name spelling.
// See the spec's "Why emit-side" section.
//
// Every guard below refuses by leaving the flat prologue exactly as it was, so
// a refusal is never a behaviour change.
import type { Stmt } from "./ast.ts";

const SLOT_RE = /^_e(\d+)_(\d+)$/;

export interface IifeRefusal {
  readonly env: number;
  readonly reason: string;
}

export interface IifeReconstruction {
  readonly stmts: Stmt[];
  /** Environments wrapped back into an IIFE, ascending. */
  readonly wrapped: readonly number[];
  /** Candidate environments left flat, with the guard that refused them. */
  readonly refusals: readonly IifeRefusal[];
}

export interface IifeReconstructInput {
  /** The function's label comment plus its prologue (declarations, hoisted
   *  children) -- everything before the lowered statements. */
  readonly header: readonly Stmt[];
  /** The lowered statements, in order. Ranges are taken over this list only. */
  readonly body: readonly Stmt[];
  /** Exactly `EmitFunctionInput.ownedEnvSlots` (already env-remapped). */
  readonly ownedEnvSlots: readonly string[];
  /** env id -> its parent env id, from the env graph. */
  readonly envParent: ReadonlyMap<number, number | null>;
  /** True for a lowered generator body, whose statements live in a re-entered
   *  same-frame closure: never wrapped. */
  readonly isGeneratorBody?: boolean;
  /**
   * May this hoisted child declaration travel into the IIFE? False for a
   * function this body only HOSTS (an orphan, or a copy created at more than
   * one site, src/emit/placement.ts): another function elsewhere in the module
   * names it, and moving it inside a wrapper makes that name unbound
   * (`E_UNBOUND_IDENT`). Defaults to refusing everything.
   */
  readonly movableChild?: (name: string) => boolean;
}

type Obj = Record<string, unknown>;

/** Structural walk. `visit` returning true prunes the subtree. Non-computed
 *  member property names are not identifiers and are never visited. */
function walk(node: unknown, visit: (n: Obj) => boolean | void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) walk(x, visit);
    return;
  }
  const obj = node as Obj;
  if (visit(obj) === true) return;
  const kind = obj["k"];
  for (const key of Object.keys(obj)) {
    if (key === "prop" && obj["computed"] === false && (kind === "member" || kind === "optmember")) continue;
    walk(obj[key], visit);
  }
}

/** Every identifier-ish name mentioned anywhere in `node`, declarations included. */
function namesIn(node: unknown, into: Set<string>): void {
  walk(node, (n) => {
    switch (n["k"]) {
      case "ident":
        into.add(String(n["name"]));
        break;
      case "init":
      case "func":
      case "classdecl":
        if (typeof n["name"] === "string") into.add(n["name"]);
        break;
      case "decl":
        for (const name of n["names"] as readonly string[]) into.add(name);
        break;
      default:
        break;
    }
  });
}

function mentionsAny(node: unknown, names: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  namesIn(node, seen);
  for (const name of seen) if (names.has(name)) return true;
  return false;
}

/** Names a top-level range statement binds in the range's own scope. */
function declaredBy(stmt: Stmt): string[] {
  switch (stmt.k) {
    case "decl":
      return [...stmt.names];
    case "init":
      return [stmt.name];
    case "func":
      return [stmt.name];
    case "classdecl":
      return [stmt.name];
    default:
      return [];
  }
}

/**
 * Guard: nothing inside the range may refer to anything outside it that an
 * IIFE boundary would capture differently. `return` never survives; `this`,
 * `arguments`, `yield` and `await` bind to the wrapper instead of the real
 * function; `break`/`continue` are fine only when the loop or switch or label
 * they target is itself inside the range. Nested functions carry their own
 * boundary, so they are pruned.
 */
function opaqueReason(stmts: readonly Stmt[]): string | null {
  let reason: string | null = null;
  const fail = (r: string): void => {
    reason ??= r;
  };
  const expr = (node: unknown): void => {
    walk(node, (n) => {
      switch (n["k"]) {
        case "func":
          return true; // its own `this`/`arguments`/`return` boundary
        case "this":
          fail("this");
          return true;
        case "argumentsObject":
          fail("arguments");
          return true;
        case "yield":
          fail("yield");
          return true;
        case "await":
          fail("await");
          return true;
        default:
          return false;
      }
    });
  };
  const visit = (list: readonly Stmt[], breakable: boolean, continuable: boolean, labels: ReadonlySet<string>): void => {
    for (const s of list) {
      switch (s.k) {
        case "return":
          fail("return");
          if (s.arg !== null) expr(s.arg);
          break;
        case "break":
          if (s.label === null ? !breakable : !labels.has(s.label)) fail("break out of range");
          break;
        case "continue":
          if (s.label === null ? !continuable : !labels.has(s.label)) fail("continue out of range");
          break;
        case "raw":
          fail("raw text");
          break;
        case "func":
          break; // own boundary; body not scanned
        case "if":
          expr(s.test);
          visit(s.then, breakable, continuable, labels);
          visit(s.else, breakable, continuable, labels);
          break;
        case "while":
        case "do-while":
        case "for":
        case "for-in":
        case "for-of": {
          const inner = s.label === null ? labels : new Set([...labels, s.label]);
          for (const key of ["test", "init", "update", "left", "right"] as const) {
            if (key in s) expr((s as unknown as Obj)[key]);
          }
          visit(s.body, true, true, inner);
          break;
        }
        case "switch":
          expr(s.disc);
          for (const c of s.cases) {
            if (c.test !== null) expr(c.test);
            visit(c.body, true, continuable, labels);
          }
          break;
        case "labeled":
          visit(s.body, breakable, continuable, new Set([...labels, s.label]));
          break;
        case "try":
          visit(s.block, breakable, continuable, labels);
          visit(s.handler, breakable, continuable, labels);
          break;
        case "iife":
          break; // already its own boundary
        default:
          expr(s);
          break;
      }
    }
  };
  visit(stmts, false, false, new Set());
  return reason;
}

/**
 * Wraps every owned environment that provably came from an inlined IIFE back
 * into `(function () { ... })();`. Pure: returns a new statement list.
 */
export function reconstructIifes(input: IifeReconstructInput): IifeReconstruction {
  const flat = (): IifeReconstruction => ({ stmts: [...input.header, ...input.body], wrapped: [], refusals: [] });

  const byEnv = new Map<number, string[]>();
  for (const name of input.ownedEnvSlots) {
    const m = SLOT_RE.exec(name);
    if (m === null) return flat();
    const env = Number(m[1]);
    const list = byEnv.get(env);
    if (list === undefined) byEnv.set(env, [name]);
    else list.push(name);
  }
  // One environment is just the function's own scope: the flat prologue
  // already round-trips it. Sibling environments are what this step is for.
  if (byEnv.size < 2) return flat();
  if (input.isGeneratorBody === true) {
    return { ...flat(), refusals: [...byEnv.keys()].map((env) => ({ env, reason: "generator body" })) };
  }

  const refusals: IifeRefusal[] = [];
  const refuse = (env: number, reason: string): void => {
    refusals.push({ env, reason });
  };

  // The prologue declaration that holds the owned slot names.
  const owned = new Set(input.ownedEnvSlots);
  const declIdx = input.header.findIndex((s) => s.k === "decl" && s.names.some((n) => owned.has(n)));
  if (declIdx < 0) {
    for (const env of byEnv.keys()) refuse(env, "no env-slot prologue");
    return { ...flat(), refusals };
  }
  const declStmt = input.header[declIdx] as Extract<Stmt, { k: "decl" }>;
  if (!declStmt.names.every((n) => owned.has(n))) {
    for (const env of byEnv.keys()) refuse(env, "env-slot prologue shared with other names");
    return { ...flat(), refusals };
  }

  // A parent of another owned environment is the function's own scope, not an
  // inlined callee's: wrapping it would move the caller's own bindings.
  const parentOfOwned = new Set<number>();
  for (const env of byEnv.keys()) {
    const parent = input.envParent.get(env);
    if (parent !== undefined && parent !== null && byEnv.has(parent)) parentOfOwned.add(parent);
  }

  // Hoisted children: which owned environments each one reads.
  const children: { readonly index: number; readonly name: string; readonly envs: Set<number> }[] = [];
  for (let i = 0; i < input.header.length; i++) {
    const s = input.header[i]!;
    if (s.k !== "func") continue;
    const names = new Set<string>();
    namesIn(s, names);
    const envs = new Set<number>();
    for (const name of names) {
      if (!owned.has(name)) continue;
      envs.add(Number(SLOT_RE.exec(name)![1]));
    }
    children.push({ index: i, name: s.name, envs });
  }

  interface Candidate {
    readonly env: number;
    readonly slots: ReadonlySet<string>;
    readonly childIndices: readonly number[];
    from: number;
    to: number;
    readonly hoist: string[];
  }
  const candidates: Candidate[] = [];

  for (const [env, slots] of [...byEnv.entries()].sort((a, b) => a[0] - b[0])) {
    if (parentOfOwned.has(env)) {
      refuse(env, "parent of a sibling environment");
      continue;
    }
    const mine = new Set(slots);
    const kids = children.filter((c) => c.envs.has(env));
    if (kids.some((c) => c.envs.size > 1)) {
      refuse(env, "closure spans two environments");
      continue;
    }
    if (!kids.every((c) => input.movableChild?.(c.name) === true)) {
      refuse(env, "hosted closure cannot move into the range");
      continue;
    }
    // A closure that stays outside may not name one that moves in.
    const moving = new Set(kids.map((c) => c.name));
    if (children.some((c) => !moving.has(c.name) && mentionsAny(input.header[c.index], moving))) {
      refuse(env, "moved closure named from outside the range");
      continue;
    }
    for (const c of kids) mine.add(c.name);

    let from = -1;
    let to = -1;
    for (let i = 0; i < input.body.length; i++) {
      if (!mentionsAny(input.body[i], mine)) continue;
      if (from < 0) from = i;
      to = i;
    }
    if (from < 0) {
      refuse(env, "environment unused in the body");
      continue;
    }
    candidates.push({ env, slots: new Set(slots), childIndices: kids.map((c) => c.index), from, to, hoist: [] });
  }

  // Ranges must be contiguous and disjoint: two environments interleaved
  // cannot both become a range of consecutive statements.
  const overlapping = new Set<number>();
  for (const a of candidates) {
    for (const b of candidates) {
      if (a === b) continue;
      if (a.from <= b.to && b.from <= a.to) overlapping.add(a.env);
    }
  }
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    if (overlapping.has(c.env)) {
      refuse(c.env, "overlapping statement ranges");
      continue;
    }
    const range = input.body.slice(c.from, c.to + 1);
    const opaque = opaqueReason(range);
    if (opaque !== null) {
      refuse(c.env, opaque);
      continue;
    }
    // A slot name may not be read outside its own range (a reader closure that
    // is not hoisted with it, an unrelated statement) -- the IIFE would hide it.
    let leaks = false;
    for (let i = 0; i < input.body.length; i++) {
      if (i >= c.from && i <= c.to) continue;
      if (mentionsAny(input.body[i], c.slots)) leaks = true;
    }
    // ...and the range may not touch a SIBLING environment's slots. A closure
    // emitted inside the range that reads another of the function's
    // environments would gain a scope level from the wrapper, so its parent
    // chain no longer matches the original (`diff:GetParentEnvironment/...`).
    const foreign = new Set<string>();
    for (const name of owned) if (!c.slots.has(name)) foreign.add(name);
    for (let i = c.from; i <= c.to; i++) {
      if (mentionsAny(input.body[i], foreign)) leaks = true;
    }
    for (const child of children) {
      if (c.childIndices.includes(child.index)) continue;
      if (child.envs.has(c.env)) leaks = true;
    }
    if (leaks) {
      refuse(c.env, "environment read outside the range");
      continue;
    }
    // Anything the range declares and something after it reads must be hoisted
    // to a declaration in front of the IIFE (fixture 75's `let r0 = undefined;`
    // is the shape this exists for). `var` is function-scoped: refuse instead.
    let varInRange = false;
    for (const s of range) {
      walk(s, (n) => {
        if (n["k"] === "func") return true;
        if ((n["k"] === "decl" || n["k"] === "init") && n["kind"] === "var") varInRange = true;
        return false;
      });
    }
    if (varInRange) {
      refuse(c.env, "var declared in the range");
      continue;
    }
    const outside = new Set<string>();
    for (let i = 0; i < input.body.length; i++) {
      if (i >= c.from && i <= c.to) continue;
      namesIn(input.body[i], outside);
    }
    let unhoistable: string | null = null;
    for (let i = c.from; i <= c.to; i++) {
      const s = input.body[i]!;
      for (const name of declaredBy(s)) {
        if (c.slots.has(name) || !outside.has(name)) continue;
        if ((s.k === "decl" || s.k === "init") && s.kind === "let") c.hoist.push(name);
        else unhoistable ??= `${s.k} declaration outlives the range`;
      }
    }
    if (unhoistable !== null) {
      refuse(c.env, unhoistable);
      continue;
    }
    accepted.push(c);
  }

  if (accepted.length === 0) return { ...flat(), refusals };

  // --- apply ---------------------------------------------------------------
  const movedChildren = new Set<number>();
  const wrappedSlots = new Set<string>();
  for (const c of accepted) {
    for (const i of c.childIndices) movedChildren.add(i);
    for (const n of c.slots) wrappedSlots.add(n);
  }

  const header: Stmt[] = [];
  for (let i = 0; i < input.header.length; i++) {
    if (movedChildren.has(i)) continue;
    if (i === declIdx) {
      const keep = declStmt.names.filter((n) => !wrappedSlots.has(n));
      if (keep.length > 0) header.push({ ...declStmt, names: keep });
      continue;
    }
    header.push(input.header[i]!);
  }

  const byStart = new Map(accepted.map((c) => [c.from, c] as const));
  const covered = new Set<number>();
  for (const c of accepted) for (let i = c.from; i <= c.to; i++) covered.add(i);

  const body: Stmt[] = [];
  for (let i = 0; i < input.body.length; i++) {
    const c = byStart.get(i);
    if (c !== undefined) {
      if (c.hoist.length > 0) body.push({ k: "decl", kind: "let", names: [...new Set(c.hoist)] });
      const inner: Stmt[] = [{ k: "decl", kind: "let", names: [...c.slots] }];
      for (const idx of c.childIndices) inner.push(input.header[idx]!);
      for (let j = c.from; j <= c.to; j++) {
        const s = input.body[j]!;
        // A hoisted `let x = v;` keeps its value here as a plain assignment
        // against the binding now declared in front of the IIFE.
        if (s.k === "init" && c.hoist.includes(s.name)) inner.push({ k: "expr", expr: { k: "assign", target: { k: "ident", name: s.name }, value: s.value } });
        else if (s.k === "decl") {
          const keep = s.names.filter((n) => !c.hoist.includes(n));
          if (keep.length > 0) inner.push({ ...s, names: keep });
        } else inner.push(s);
      }
      body.push({ k: "iife", body: inner });
      continue;
    }
    if (covered.has(i)) continue;
    body.push(input.body[i]!);
  }

  return { stmts: [...header, ...body], wrapped: accepted.map((c) => c.env).sort((a, b) => a - b), refusals };
}
