// ui/src/mock.ts — the mock adapter the shell runs against until
// src/ui-server lands (spec 22 landing 1). Same `Api` surface, same
// contract shapes, obviously-fake data: nothing here is derived from a real
// artifact, and no component may special-case it.
import type { Api } from "./api.ts";
import type {
  Bounded, CallsFrom, FnContext, FnSummary, FunctionMatch, LeadsResult, LogTail,
  ModuleInfo, PackageIdResult, ResolvedFinding, SearchPage, SourceMatch,
  SourceText, WhoCalls, XrefEdge,
} from "./contracts.ts";

const FN_NAMES: readonly string[] = [
  "validateLicence", "decryptPayload", "fetchRemoteConfig", "onAppStart",
  "renderRoot", "storeToken", "parseDeepLink", "verifySignature",
];

function fnName(fn: number): string {
  return FN_NAMES[fn % FN_NAMES.length] ?? `fn${fn}`;
}

const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 60));

function summary(fn: number): FnSummary {
  return {
    fn, name: fnName(fn), overlayName: null, module: fn % 4, file: `mod${fn % 4}/index.js`,
    lines: [10, 42], params: fn % 3, kind: "function", edgesIn: 3, edgesOut: 5,
    nativeSurfaceCount: 0, degraded: null,
  };
}

const SOURCE = `function ${"validateLicence"}(token, now) {
  const claims = decodePayload(token);
  if (!verifySignature(claims, PUBLIC_KEY)) return false;
  if (claims.exp < now) return false;
  return claims.tier === "pro";
}`;

const DISASM = `L0:
  0x0000  LoadParam         r2, 1
  0x0004  GetByIdShort      r3, r2, "decodePayload"
  0x000a  Call2             r1, r3, r2, r0
  0x0010  JmpFalse          L2, r1
L1:
  0x0016  LoadConstUInt8    r4, 1
  0x001a  Ret               r4`;

const edge = (fn: number, kind: string): XrefEdge => ({
  fn, name: fnName(fn), size: 24, file: `mod${fn % 4}/index.js`, line: 12, kind,
});

const FINDING: ResolvedFinding = {
  record: {
    rid: "f-0001", kind: "finding", target: "fn:7", prov: { source: "tool", who: "leads" },
    ts: "2026-09-04T09:00:00Z", supersedes: null, active: true,
    claim: "Signature verification result is discarded on the error path",
    severity: "high", evidence: [{ ref: "fn:7", role: "sink" }], status: "open",
  },
  status: "open", valid: true, refs: [{ ref: { ref: "fn:7", role: "sink" }, resolved: true }],
};

export const mockApi: Api = {
  fn: (fn) => delay(summary(fn)),
  source: (): Promise<SourceText> => delay({ text: SOURCE, totalLines: 6, truncated: false }),
  disasm: (): Promise<SourceText> => delay({ text: DISASM, totalLines: 7, truncated: false }),
  context: (fn): Promise<FnContext> => delay({
    fn,
    metadata: summary(fn),
    source: { text: SOURCE, totalLines: 6, truncated: false },
    callers: { rows: [edge(3, "call"), edge(5, "call")], total: 2, truncated: false },
    callees: { rows: [edge(11, "call")], total: 1, truncated: false },
    strings: { rows: [{ sid: 42, head: "licence.pub", role: "arg", n: 2 }], total: 1, truncated: false },
  }),
  whoCalls: (): Promise<WhoCalls> =>
    delay({ rows: [edge(3, "call"), edge(5, "call")], total: 2, truncated: false, unknownInScope: 1 }),
  callsFrom: (): Promise<CallsFrom> => delay({ rows: [edge(11, "call")], total: 1, truncated: false }),
  module: (): Promise<ModuleInfo> => delay({ deps: [2, 3], dependents: [0], ownedFnCount: 12, file: "mod1/index.js" }),
  packageId: (mod): Promise<PackageIdResult> =>
    delay({ available: false, mod, reason: "mock adapter: no signature DB in the browser" }),
  findings: (): Promise<Bounded<ResolvedFinding>> => delay({ rows: [FINDING], total: 1, truncated: false }),
  leads: (): Promise<LeadsResult> => delay({
    groups: [
      { class: "verify", leads: [{ fn: 7, name: "verifySignature", class: "verify", evidence: "fn:7", detail: "calls crypto.verify" }], total: 1, truncated: false },
      { class: "keychain", leads: [{ fn: 5, name: "storeToken", class: "keychain", evidence: "fn:5", detail: "RNKeychainManager" }], total: 1, truncated: false },
    ],
    total: 2, truncated: false,
  }),
  // Oldest-first with a seq cursor, exactly like /api/log/tail (spec 22 §3.5).
  logTail: (since): Promise<LogTail> => delay({
    rows: [
      { seq: 1, ts: "2026-09-04T09:00:02Z", who: "mock", op: "open", detail: "project opened" },
      { seq: 2, ts: "2026-09-04T09:01:40Z", who: "mock", op: "add_comment", detail: "fn:5" },
      { seq: 3, ts: "2026-09-04T09:02:11Z", who: "mock", op: "set_name", detail: "fn:7 -> verifySignature" },
    ].filter((r) => r.seq > since),
    cursor: 3,
  }),
  searchFunctions: (query): Promise<SearchPage<FunctionMatch>> => delay({
    rows: FN_NAMES.filter((n) => n.toLowerCase().includes(query.toLowerCase()))
      .map((n, i) => ({ fn: i, name: n, size: 20 + i })),
    total: FN_NAMES.length, truncated: false, nextCursor: null,
  }),
  searchSource: (query): Promise<SearchPage<SourceMatch>> => delay({
    rows: [{ fn: 0, name: "validateLicence", file: "mod0/index.js", line: 3, text: `  // match for ${query}` }],
    total: 1, truncated: false, nextCursor: null,
  }),
};
