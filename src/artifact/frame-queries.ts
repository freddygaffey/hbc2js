// src/artifact/frame-queries.ts — the two LIVE query verbs (docs/specs/
// 10-artifact-format.md §3.1/§3.3, P2.1a(b)): `name list <fn>` and
// `name context <fn> <reg>`. Deliberately independent of any artifact
// directory — only needs the warm raw frame bodies the naming-overlay gate
// already builds (`src/name-overlay/frames.ts`) plus, optionally, an overlay
// store for the `named` column — so `hbc2js name list/context` (no --artifact)
// and `ArtifactService.list/context` (which HAS an artifact but still needs
// live bytecode-derived frames) share one implementation.
import type { Stmt } from "../emit/ast.ts";
import { gateForFrame } from "../name-overlay/gate.ts";
import { regId } from "../name-overlay/id.ts";
import { registerUses, isRegisterName } from "../passes/ast.ts";
import type { OverlayStore } from "../name-overlay/store.ts";

export interface NameableRegister {
  readonly reg: number;
  readonly uses: number;
  readonly role: string;
  readonly named: string | null;
}

/** §3.1 `name list <fn>`: every register the gate considers nameable — NOT
 *  refused `no-binding` (A7's own assertion) — with its use count and the
 *  gate's own verdict (`passed`/`overridden`/a refusal reason) as `role`. */
export function listNameable(frames: ReadonlyMap<number, readonly Stmt[]>, fn: number, overlay?: OverlayStore): readonly NameableRegister[] {
  const body = frames.get(fn);
  if (body === undefined) return [];
  const uses = registerUses(body);
  const regs = new Set<number>();
  for (const name of uses.keys()) if (isRegisterName(name)) regs.add(Number(name.slice(1)));
  const out: NameableRegister[] = [];
  for (const reg of [...regs].sort((a, b) => a - b)) {
    const verdict = gateForFrame(body, regId(fn, reg), "x", false);
    if (!verdict.ok && verdict.reason === "no-binding") continue; // never listed (A7)
    const role = verdict.ok ? verdict.gate : verdict.reason;
    const u = uses.get(`r${reg}`);
    out.push({ reg, uses: (u?.reads ?? 0) + (u?.writes ?? 0), role, named: overlay?.getName(regId(fn, reg))?.name ?? null });
  }
  return out;
}

/** §3.1 `name context <fn> <reg>`: def/use sites for one register, an
 *  independent small AST walk of the register's own raw frame body (kept
 *  separate from `registerUses`'s counting traversal — A7 wants an
 *  independent recount of the SITE list, not a re-export of the count). */
export function contextSites(frames: ReadonlyMap<number, readonly Stmt[]>, fn: number, reg: number): readonly string[] {
  const body = frames.get(fn);
  if (body === undefined) return [];
  const name = `r${reg}`;
  const out: string[] = [];
  let n = 0;
  const walkExpr = (e: unknown): void => {
    if (e === null || typeof e !== "object") return;
    const node = e as Record<string, unknown>;
    if (node.k === "ident" && node.name === name) {
      n++;
      out.push(`site ${n}: use`);
      return;
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) for (const item of v) walkExpr(item);
      else if (v !== null && typeof v === "object") walkExpr(v);
    }
  };
  const walkStmt = (s: unknown): void => {
    if (s === null || typeof s !== "object") return;
    const node = s as Record<string, unknown>;
    if (node.k === "assign" && (node.target as Record<string, unknown> | undefined)?.["name"] === name) {
      n++;
      out.push(`site ${n}: def`);
    }
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (Array.isArray(v)) for (const item of v) walkStmt(item);
      else if (v !== null && typeof v === "object") walkExpr(v);
    }
  };
  for (const s of body) walkStmt(s);
  return out;
}
