// src/workers/presence.ts — sessions, heartbeats and advisory claims
// (docs/specs/23-ui-workers.md §3). Three participant classes share one table:
// `human` (the UI), `worker` (a server-owned job runner) and `external` (an
// MCP client someone connected themselves) — the design point of spec 23 §0 is
// that they are peers, so presence must not privilege any of them.
//
// Liveness is a TTL over `last_seen`, EVALUATED ON READ: `expire()` is a sweep
// a caller may run, never a correctness requirement, so a crashed UI or a
// killed worker cannot hold a claim forever even if nothing sweeps.
//
// Claims are ADVISORY. They draw "Fred is editing this function" and stop two
// workers racing the same target; they never block a write, because the
// annotation store is append-only and supersession already resolves concurrent
// writes (spec 11 §2.1).
import type { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "../projdb/export.ts";
import { appendWorkerEvent } from "./events.ts";
import type { Clock } from "./queue.ts";

export type SessionKind = "human" | "worker" | "external";

export interface Session {
  readonly id: string;
  readonly kind: SessionKind;
  readonly who: string;
  readonly openedAt: string;
  readonly lastSeen: string;
  readonly closedAt: string | null;
  readonly meta: Record<string, unknown> | null;
}

export interface Claim {
  readonly target: string;
  readonly session: string;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

/** §3's default TTL: a session is live while its heartbeat is under 30 s old
 *  (the UI beats every 10 s, so two missed beats drop it). */
export const DEFAULT_TTL_MS = 30_000;

interface SessionRow {
  readonly id: string;
  readonly kind: string;
  readonly who: string;
  readonly opened_at: string;
  readonly last_seen: string;
  readonly closed_at: string | null;
  readonly meta: string | null;
}

interface ClaimRow {
  readonly target: string;
  readonly session: string;
  readonly acquired_at: string;
  readonly expires_at: string;
}

function toSession(r: SessionRow): Session {
  return {
    id: r.id,
    kind: r.kind as SessionKind,
    who: r.who,
    openedAt: r.opened_at,
    lastSeen: r.last_seen,
    closedAt: r.closed_at,
    meta: r.meta === null ? null : (JSON.parse(r.meta) as Record<string, unknown>),
  };
}

function toClaim(r: ClaimRow): Claim {
  return { target: r.target, session: r.session, acquiredAt: r.acquired_at, expiresAt: r.expires_at };
}

export class Presence {
  private readonly db: DatabaseSync;
  private readonly clock: Clock;
  private readonly ttlMs: number;
  private seq = 0;

  constructor(db: DatabaseSync, opts: { readonly now?: Clock; readonly ttlMs?: number } = {}) {
    this.db = db;
    this.clock = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  /** Opens a session and emits `session.open`. The id is content-derived
   *  (kind+who+open time+a per-instance counter) so two sessions opened in the
   *  same millisecond by the same participant still differ. */
  open(input: { readonly kind: SessionKind; readonly who: string; readonly meta?: Record<string, unknown> }): Session {
    const ts = this.nowIso();
    this.seq += 1;
    const id = `s-${sha256Hex(`${input.kind}\n${input.who}\n${ts}\n${this.seq}`).slice(0, 16)}`;
    this.db
      .prepare("INSERT INTO sessions (id, kind, who, opened_at, last_seen, closed_at, meta) VALUES (?, ?, ?, ?, ?, NULL, ?)")
      .run(id, input.kind, input.who, ts, ts, input.meta === undefined ? null : JSON.stringify(input.meta));
    appendWorkerEvent(this.db, { type: "session.open", ts, session: id, detail: { kind: input.kind, who: input.who } });
    return this.session(id)!;
  }

  session(id: string): Session | undefined {
    const row = this.db.prepare("SELECT id, kind, who, opened_at, last_seen, closed_at, meta FROM sessions WHERE id = ?").get(id) as
      | unknown as SessionRow
      | undefined;
    return row === undefined ? undefined : toSession(row);
  }

  /** Refreshes `last_seen`. A closed session is NOT resurrected (the caller
   *  opens a new one) — that keeps `closed_at` a fact about the past. */
  heartbeat(id: string): boolean {
    const res = this.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ? AND closed_at IS NULL").run(this.nowIso(), id);
    return Number(res.changes) > 0;
  }

  /** Closes a session, releasing every claim it holds (each with its own
   *  `claim.release`), and emits `session.close`. */
  close(id: string, reason = "closed"): void {
    const s = this.session(id);
    if (s === undefined || s.closedAt !== null) return;
    const ts = this.nowIso();
    for (const c of this.claimsOf(id)) this.releaseClaimRow(c, ts, reason);
    this.db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ?").run(ts, id);
    appendWorkerEvent(this.db, { type: "session.close", ts, session: id, detail: { reason } });
  }

  /** Sessions still within the TTL (evaluated against the injected clock). */
  liveSessions(): readonly Session[] {
    const cutoff = this.clock() - this.ttlMs;
    const rows = this.db
      .prepare("SELECT id, kind, who, opened_at, last_seen, closed_at, meta FROM sessions WHERE closed_at IS NULL ORDER BY opened_at, id")
      .all() as unknown as SessionRow[];
    return rows.map(toSession).filter((s) => Date.parse(s.lastSeen) >= cutoff);
  }

  claim(target: string, session: string): Claim | undefined {
    const s = this.session(session);
    if (s === undefined || s.closedAt !== null) return undefined;
    const now = this.clock();
    const ts = new Date(now).toISOString();
    const held = this.claimOn(target);
    if (held !== undefined && held.session !== session && Date.parse(held.expiresAt) > now) return undefined;
    const expires = new Date(now + this.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO claims (target, session, acquired_at, expires_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(target) DO UPDATE SET session = excluded.session, acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
      )
      .run(target, session, ts, expires);
    appendWorkerEvent(this.db, { type: "claim.acquire", ts, session, target, detail: { expiresAt: expires } });
    return this.claimOn(target);
  }

  /** The row on `target` regardless of expiry — `claimHolder` is the live
   *  question, this is the raw read. */
  claimOn(target: string): Claim | undefined {
    const row = this.db.prepare("SELECT target, session, acquired_at, expires_at FROM claims WHERE target = ?").get(target) as
      | unknown as ClaimRow
      | undefined;
    return row === undefined ? undefined : toClaim(row);
  }

  /** The session currently holding `target`, or undefined when the claim is
   *  absent or expired — expiry is computed on read, so this is correct even
   *  if nothing ever calls `expire()`. */
  claimHolder(target: string): string | undefined {
    const c = this.claimOn(target);
    if (c === undefined) return undefined;
    return Date.parse(c.expiresAt) > this.clock() ? c.session : undefined;
  }

  claimsOf(session: string): readonly Claim[] {
    const rows = this.db
      .prepare("SELECT target, session, acquired_at, expires_at FROM claims WHERE session = ? ORDER BY target")
      .all(session) as unknown as ClaimRow[];
    return rows.map(toClaim);
  }

  release(target: string, session: string): boolean {
    const c = this.claimOn(target);
    if (c === undefined || c.session !== session) return false;
    this.releaseClaimRow(c, this.nowIso(), "released");
    return true;
  }

  private releaseClaimRow(c: Claim, ts: string, reason: string): void {
    this.db.prepare("DELETE FROM claims WHERE target = ? AND session = ?").run(c.target, c.session);
    appendWorkerEvent(this.db, { type: "claim.release", ts, session: c.session, target: c.target, detail: { reason } });
  }

  /** The sweep: drops expired claims and closes sessions whose heartbeat has
   *  aged out, emitting the events either way. Returns what it reaped, so a
   *  caller (or a test) can assert on it. Idempotent. */
  expire(): { readonly claims: readonly string[]; readonly sessions: readonly string[] } {
    const now = this.clock();
    const ts = new Date(now).toISOString();
    const claims: string[] = [];
    for (const c of this.db
      .prepare("SELECT target, session, acquired_at, expires_at FROM claims ORDER BY target")
      .all() as unknown as ClaimRow[]) {
      if (Date.parse(c.expires_at) > now) continue;
      this.releaseClaimRow(toClaim(c), ts, "expired");
      claims.push(c.target);
    }
    const sessions: string[] = [];
    for (const s of this.db
      .prepare("SELECT id, kind, who, opened_at, last_seen, closed_at, meta FROM sessions WHERE closed_at IS NULL ORDER BY opened_at, id")
      .all() as unknown as SessionRow[]) {
      if (Date.parse(s.last_seen) >= now - this.ttlMs) continue;
      this.close(s.id, "ttl-expired");
      sessions.push(s.id);
    }
    return { claims, sessions };
  }
}
