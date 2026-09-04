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
import type { ModuleSource } from "./contracts.ts";
import type { FunctionListPage, FunctionListRow, ModuleEntry, ModuleListPage } from "./listing/wire.ts";

const FN_NAMES: readonly string[] = [
  "validateLicence", "decryptPayload", "fetchRemoteConfig", "onAppStart",
  "renderRoot", "storeToken", "parseDeepLink", "verifySignature",
];

/** A fake module catalogue with the two shapes the tree must handle: the
 *  app's own `src/` modules and third-party `node_modules/<pkg>` ones,
 *  including a scoped package. Nothing here comes from a real artifact. */
const MOCK_MODULES: readonly ModuleEntry[] = [
  { id: 0, file: "src/index.js", factoryFn: 100, deps: [1, 2], segment: 0 },
  { id: 1, file: "src/auth/licence.js", factoryFn: 110, deps: [3, 7], segment: 0 },
  { id: 2, file: "src/net/config.js", factoryFn: 120, deps: [5], segment: 0 },
  { id: 3, file: "src/storage/keychain.js", factoryFn: 130, deps: [], segment: 0 },
  { id: 4, file: "node_modules/react-native/Libraries/Core/setUpNavigator.js", factoryFn: 140, deps: [], segment: 0 },
  { id: 5, file: "node_modules/react-native/Libraries/Network/fetch.js", factoryFn: 150, deps: [], segment: 0 },
  { id: 6, file: "node_modules/@react-navigation/native/lib/module/index.js", factoryFn: 160, deps: [4], segment: 0 },
  { id: 7, file: "node_modules/lodash/isEqual.js", factoryFn: 170, deps: [], segment: 0 },
];

/** Every module owns a handful of functions, ids `mod*10 + i`, so a fn id
 *  says which module it is in — handy when eyeballing the mock tree. */
const MOCK_FUNCTIONS: readonly FunctionListRow[] = MOCK_MODULES.flatMap((m) =>
  Array.from({ length: 3 + (m.id % 3) }, (_unused, i) => ({
    fn: m.id * 10 + i,
    name: m.id < 4 ? (FN_NAMES[(m.id * 3 + i) % FN_NAMES.length] ?? null) : null,
    size: 40 + i * 17 + m.id,
    module: m.id,
  })),
);

const FN_BY_ID = new Map(MOCK_FUNCTIONS.map((r) => [r.fn, r]));
const MODULE_BY_ID = new Map(MOCK_MODULES.map((m) => [m.id, m]));

/** The one deliberately huge function, so the "truncated, N more" bar has
 *  something to show without a real bundle. */
const BIG_FN = 42;
const BIG_TEXT_LINES = 6000;
const BIG_TOTAL_LINES = 6200;

function fnName(fn: number): string {
  const row = FN_BY_ID.get(fn);
  if (row?.name != null && row.name !== "") return row.name;
  return FN_NAMES[fn % FN_NAMES.length] ?? `fn${fn}`;
}

const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 60));

function summary(fn: number): FnSummary {
  const row = FN_BY_ID.get(fn);
  const mod = row?.module ?? fn % MOCK_MODULES.length;
  return {
    fn, name: row?.name ?? fnName(fn), overlayName: null, module: mod,
    file: MODULE_BY_ID.get(mod)?.file ?? null,
    lines: [10, 42], params: fn % 3, kind: "function", edgesIn: 3, edgesOut: 5,
    nativeSurfaceCount: 0, degraded: null,
  };
}

/** Per-fn fake source: the same body with the fn's own name, so clicking
 *  around the tree visibly changes the listing. */
function sourceFor(fn: number): SourceText {
  if (fn === BIG_FN) {
    const text = Array.from({ length: BIG_TEXT_LINES }, (_u, i) => `  step_${i}(state, ${i});`).join("\n");
    return { text: `function hugeGeneratedThing(state) {\n${text}\n}`, totalLines: BIG_TOTAL_LINES, truncated: true };
  }
  const name = fnName(fn);
  return {
    text: SOURCE.replace("validateLicence", name),
    totalLines: SOURCE.split("\n").length,
    truncated: false,
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

/** The file view: every function of a module concatenated, with the line
 *  ranges the real `/api/module/{id}/source` reports. */
function moduleSourceFor(id: number): ModuleSource {
  const file = MODULE_BY_ID.get(id)?.file ?? `module-${id}.js`;
  const header = [`// ${file}`, `// module ${id} — mock adapter`, ""];
  const lines: string[] = [...header];
  const functions: { fn: number; name: string | null; lines: [number, number] }[] = [];
  for (const row of MOCK_FUNCTIONS.filter((r) => r.module === id)) {
    const start = lines.length + 1;
    lines.push(...sourceFor(row.fn).text.split("\n"), "");
    functions.push({ fn: row.fn, name: row.name, lines: [start, lines.length - 1] });
  }
  return { module: id, file, text: lines.join("\n"), functions };
}

export const mockApi: Api = {
  fn: (fn) => delay(summary(fn)),
  source: (fn): Promise<SourceText> => delay(sourceFor(fn)),
  disasm: (): Promise<SourceText> => delay({ text: DISASM, totalLines: DISASM.split("\n").length, truncated: false }),
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
  module: (id): Promise<ModuleInfo> => delay({
    deps: [...(MODULE_BY_ID.get(id)?.deps ?? [])],
    dependents: MOCK_MODULES.filter((m) => m.deps.includes(id)).map((m) => m.id),
    ownedFnCount: MOCK_FUNCTIONS.filter((r) => r.module === id).length,
    file: MODULE_BY_ID.get(id)?.file ?? null,
  }),
  moduleSource: (id): Promise<ModuleSource> => delay(moduleSourceFor(id)),
  modules: (): Promise<ModuleListPage> =>
    delay({ rows: MOCK_MODULES, total: MOCK_MODULES.length, truncated: false }),
  // Paged exactly like the server (50 a page) so the catalogue hook's cursor
  // walk is exercised in mock mode too.
  functions: (cursor = 0): Promise<FunctionListPage> => {
    const page = MOCK_FUNCTIONS.slice(cursor, cursor + 50);
    const next = cursor + page.length;
    return delay({
      rows: page, total: MOCK_FUNCTIONS.length, truncated: false,
      nextCursor: next < MOCK_FUNCTIONS.length ? next : null,
    });
  },
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
  searchFunctions: (query): Promise<SearchPage<FunctionMatch>> => {
    const q = query.toLowerCase();
    const hits = MOCK_FUNCTIONS.filter((r) => (r.name ?? `fn ${r.fn}`).toLowerCase().includes(q));
    return delay({
      rows: hits.slice(0, 50).map((r) => ({ fn: r.fn, name: r.name, size: r.size })),
      total: hits.length, truncated: hits.length > 50, nextCursor: null,
    });
  },
  searchSource: (query): Promise<SearchPage<SourceMatch>> => delay({
    rows: [{ fn: 0, name: "validateLicence", file: "mod0/index.js", line: 3, text: `  // match for ${query}` }],
    total: 1, truncated: false, nextCursor: null,
  }),
};
