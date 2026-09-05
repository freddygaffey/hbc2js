// ui/src/mock.ts — the mock adapter the shell runs against until
// src/ui-server lands (spec 22 landing 1). Same `Api` surface, same
// contract shapes, obviously-fake data: nothing here is derived from a real
// artifact, and no component may special-case it.
import type { Api } from "./api.ts";
import type {
  Bounded, CallsFrom, FnContext, FnSummary, FunctionMatch, HistoryEntry, LeadsResult, LogTail,
  LocalsListing, ModuleInfo, PackageIdResult, ResolvedFinding, SearchPage, SourceMatch,
  SourceText, WhoCalls, XrefEdge, LineMap, LineMapEntry, StringExact, StringGrep, GlobalUses,
  WhoCallsByName, ObjectTable, ObjectTables,
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
    // Deterministic, not a real .hbc offset — mock mode has no bytecode.
    offset: fn * 64,
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

// The real `GET /api/fn/:fn/disasm` prints one line per instruction as
// `[@ <byte offset>] Opcode …` (src/disasm/print.ts). The mock's opcodes are
// invented, but the SHAPE is the real one, because the source<->disasm
// alignment (docs/specs/05-emitter.md §16) finds its line by that prefix and a
// mock in a different format would make the feature untestable in mock mode.
const DISASM = `L0:
  [@ 0] LoadParam r2<Reg8>, 1<UInt8>
  [@ 4] GetByIdShort r3<Reg8>, r2<Reg8>, "decodePayload"
  [@ 10] Call2 r1<Reg8>, r3<Reg8>, r2<Reg8>, r0<Reg8>
  [@ 16] JmpFalse L2<Addr8>, r1<Reg8>
L1:
  [@ 22] LoadConstUInt8 r4<Reg8>, 1<UInt8>
  [@ 26] Ret r4<Reg8>`;

/** Mock `linemap`: the fake SOURCE's five body lines against the fake DISASM's
 *  six instructions, in the same partial spirit as the real thing (line 1, the
 *  `function` header, and line 6, the closing brace, are unmapped). */
const LINE_MAP: readonly LineMapEntry[] = [
  [2, 0, 0, 4],
  [3, 0, 4, 10],
  [4, 0, 16, 22],
  [5, 0, 22, 26],
];

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

/** A handful of fake strings.json entries — enough for a substring/regex
 *  search to have something to find, and for two of them to have more than
 *  one use so the "expand a hit" flow has a real list to show. */
const MOCK_STRINGS: readonly { sid: number; v: string }[] = [
  { sid: 100, v: "licence.pub" },
  { sid: 101, v: "https://api.example.com/v1/licence" },
  { sid: 102, v: "AsyncStorage" },
  { sid: 103, v: "token" },
  { sid: 104, v: "verifySignature failed" },
];

const MOCK_STRING_USES: readonly { sid: number; fn: number; role: string; n: number }[] = [
  { sid: 100, fn: 0, role: "literal", n: 2 },
  { sid: 100, fn: 3, role: "property-get", n: 1 },
  { sid: 101, fn: 5, role: "call-arg-literal", n: 1 },
  { sid: 103, fn: 3, role: "literal", n: 3 },
  { sid: 103, fn: 11, role: "property-put", n: 1 },
];

/** A small deterministic fixture for `GET /api/object-tables` (spec 17
 *  §14.2) — two "endpoint table"-shaped literals so the Tables tab's
 *  filter/expand/jump flow has something real to exercise in mock mode.
 *  One member is `kind:"computed"` (a `BASE + "/x"` tail) so the muted
 *  `<computed>` rendering path is reachable without a real bundle. */
const MOCK_OBJECT_TABLES: readonly Omit<ObjectTable, "matched">[] = [
  {
    fn: 5, fnName: "storeToken", size: 96, offset: 40, module: 3, numProps: 4,
    members: [
      { key: "AUTH", value: "/v1/auth", kind: "string" },
      { key: "REFRESH", value: "/v1/auth/refresh", kind: "string" },
      { key: "LOGOUT", value: "/v1/auth/logout", kind: "string" },
      { key: "BASE_URL", value: null, kind: "computed" },
    ],
    strings: 3, nonStrings: 0, computed: 1,
  },
  {
    fn: 11, fnName: "parseDeepLink", size: 64, offset: 12, module: 3, numProps: 4,
    members: [
      { key: "HOME", value: "https://example.com/home", kind: "string" },
      { key: "PROFILE", value: "https://example.com/profile", kind: "string" },
      { key: "SETTINGS", value: "https://example.com/settings", kind: "string" },
      { key: "SUPPORT", value: "https://example.com/support", kind: "string" },
    ],
    strings: 4, nonStrings: 0, computed: 0,
  },
];

const MOCK_GLOBALS: readonly { fn: number; access: string; n: number }[] = [
  { fn: 0, access: "get", n: 3 },
  { fn: 5, access: "set", n: 1 },
];

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
  lineMap: (fn): Promise<LineMap> => delay({ fn, fnStartLine: 1, lines: fn === BIG_FN ? [] : LINE_MAP.map((r) => [r[0], fn, r[2], r[3]] as LineMapEntry) }),
  locals: (fn): Promise<LocalsListing> => {
    // The mock source is fixed text; derive its registers from it so the
    // identifier -> `reg:F:R` join has something real to resolve against.
    const text = sourceFor(fn).text;
    const regs = [...new Set([...text.matchAll(/\br(\d+)\b/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
    const rows = regs.map((reg) => ({
      reg,
      rendered: `r${reg}`,
      named: null,
      role: "passed",
      uses: text.match(new RegExp(`\\br${reg}\\b`, "g"))?.length ?? 1,
    }));
    return delay({ rows, total: rows.length });
  },
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
  // spec 17 §14.1: heuristic by-name caller candidates. `fn:999` is a
  // deliberate demo of the ambiguous-name path (no real fn is ever 999 in
  // this mock module set) — its rows are empty, `names[0].ambiguous` true.
  xrefWhoCallsByName: (fn): Promise<WhoCallsByName> => {
    if (fn === 999) {
      return delay({
        rows: [], total: 0, truncated: false,
        names: [{
          name: "default", sid: null, ambiguous: true,
          why: "\"default\" is a common JS member name; a property-get of it proves nothing about dynamic dispatch to a specific export",
        }],
        excludedModule: null,
      });
    }
    const candidates = MOCK_FUNCTIONS.filter((r) => r.fn !== fn).slice(0, 2);
    const rows = candidates.map((r) => ({
      fn: r.fn, callerName: r.name, size: r.size, name: "verifyLicence", role: "property-get", n: 1,
      file: MODULE_BY_ID.get(r.module ?? -1)?.file ?? null, line: 18, confidence: "by-name" as const,
    }));
    return delay({
      rows, total: rows.length, truncated: false,
      names: [{ name: "verifyLicence", sid: 42, ambiguous: false }],
      excludedModule: MOCK_FUNCTIONS.find((r) => r.fn === fn)?.module ?? null,
    });
  },
  module: (id): Promise<ModuleInfo> => delay({
    deps: [...(MODULE_BY_ID.get(id)?.deps ?? [])],
    dependents: MOCK_MODULES.filter((m) => m.deps.includes(id)).map((m) => m.id),
    ownedFnCount: MOCK_FUNCTIONS.filter((r) => r.module === id).length,
    file: MODULE_BY_ID.get(id)?.file ?? null,
  }),
  moduleSource: (id): Promise<ModuleSource> => delay(moduleSourceFor(id)),
  modules: (): Promise<ModuleListPage> =>
    delay({ rows: MOCK_MODULES, total: MOCK_MODULES.length, truncated: false }),
  // Paged exactly like the server (50 a page by default, up to `limit`) so
  // the catalogue hook's cursor walk is exercised in mock mode too.
  functions: (cursor = 0, limit = 50): Promise<FunctionListPage> => {
    const page = MOCK_FUNCTIONS.slice(cursor, cursor + limit);
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
  // Spec 26 L6: two revisions, newest first (as the server sends it) —
  // `HistoryPane` reverses this before rendering.
  history: (_target): Promise<Bounded<HistoryEntry>> => delay({
    rows: [
      { rid: 2, kind: "finding", ts: "2026-09-05T09:00:00Z", supersedes: null, reactivates: null, cleared: false, who: "ui" },
      { rid: 1, kind: "name", ts: "2026-09-05T08:00:00Z", supersedes: null, reactivates: null, cleared: false, who: "ui" },
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
  xrefStringSearch: (mode, pattern): Promise<StringGrep> => {
    const re = mode === "regex" ? new RegExp(pattern) : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const uses = new Map<number, number>();
    for (const u of MOCK_STRING_USES) uses.set(u.sid, (uses.get(u.sid) ?? 0) + u.n);
    const hits = MOCK_STRINGS.filter((s) => re.test(s.v)).map((s) => ({ sid: s.sid, head: s.v, uses: uses.get(s.sid) ?? 0 }));
    return delay({ rows: hits, total: hits.length, truncated: false });
  },
  xrefStringUses: (sid): Promise<StringExact> => {
    const value = MOCK_STRINGS.find((s) => s.sid === sid);
    const rows = MOCK_STRING_USES.filter((u) => u.sid === sid).map((u) => ({
      ...u, name: FN_BY_ID.get(u.fn)?.name ?? null, size: FN_BY_ID.get(u.fn)?.size ?? null,
    }));
    return delay({ value, uses: { rows, total: rows.length, truncated: false } });
  },
  // Mirrors `ArtifactService.objectTables` (`src/artifact/service.ts`):
  // `matched` counts the members satisfying EITHER pattern (the table's own
  // member count when neither is given, so an unfiltered query always
  // passes `minMatched`); defaults are >=4 members, >=50% string-valued,
  // >=1 matched; a FILTERED query ranks on `matched` then hit density then
  // size, an unfiltered one on size alone.
  objectTables: (query): Promise<ObjectTables> => {
    const minProps = query.minProps ?? 4;
    const stringRatio = query.stringRatio ?? 0.5;
    const minMatched = query.minMatched ?? 1;
    const keyRe = query.key !== undefined ? new RegExp(query.key) : undefined;
    const valueRe = query.value !== undefined ? new RegExp(query.value) : undefined;
    const filtered = keyRe !== undefined || valueRe !== undefined;
    const rows: ObjectTable[] = [];
    for (const t of MOCK_OBJECT_TABLES) {
      const n = t.members.length;
      if (n < minProps) continue;
      if (n === 0 || t.strings / n < stringRatio) continue;
      if (query.module !== undefined && t.module !== query.module) continue;
      if (keyRe !== undefined && !t.members.some((m) => keyRe.test(m.key))) continue;
      if (valueRe !== undefined && !t.members.some((m) => m.value !== null && valueRe.test(m.value))) continue;
      const matched = filtered
        ? t.members.filter((m) => (keyRe !== undefined && keyRe.test(m.key)) || (valueRe !== undefined && m.value !== null && valueRe.test(m.value))).length
        : n;
      if (matched < minMatched) continue;
      rows.push({ ...t, matched });
    }
    rows.sort((a, b) => {
      if (filtered) {
        const byMatched = b.matched - a.matched;
        if (byMatched !== 0) return byMatched;
        const byDensity = b.matched / b.members.length - a.matched / a.members.length;
        if (byDensity !== 0) return byDensity;
      }
      return b.members.length - a.members.length || a.fn - b.fn || a.offset - b.offset;
    });
    const limit = query.limit ?? 100;
    return delay({
      tables: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit,
      scanned: MOCK_FUNCTIONS.length, failed: 0,
    });
  },
  xrefGlobal: (name): Promise<GlobalUses> => {
    const rows = name.length === 0 ? [] : MOCK_GLOBALS.map((g) => ({
      ...g,
      file: MODULE_BY_ID.get(FN_BY_ID.get(g.fn)?.module ?? 0)?.file ?? null,
      line: 12,
      name: FN_BY_ID.get(g.fn)?.name ?? null,
      size: FN_BY_ID.get(g.fn)?.size ?? null,
    }));
    return delay({ rows, total: rows.length, truncated: false });
  },
};
