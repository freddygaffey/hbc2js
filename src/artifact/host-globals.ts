// src/artifact/host-globals.ts — the curated host-global list (docs/specs/
// 10-artifact-format.md §2.5, §9 ruling 2, §10 E6). In-repo data file, pinned
// exactly by `tests/artifact/host-globals.test.ts` (A10): appended to only
// via a reviewed commit citing evidence for the addition. The builder never
// promotes a name into this list on its own — an unlisted global used in
// read/call access by >= 3 functions is surfaced as `host-global?`
// (`src/artifact/native.ts`), never silently written back here.
//
// Evidence for the current list: the RN bridge surface (`nativeCallSyncHook`,
// `__turboModuleProxy`, `__fbBatchedBridge`, `nativeLoggingHook`,
// `HermesInternal` — every RN app's JS<->native boundary goes through one of
// these) plus the web-ish hosts hermesc's own template-literal lowering and
// RN's `fetch` polyfill assume exist (`fetch`, `XMLHttpRequest`, `WebSocket`).
export const HOST_GLOBALS: readonly string[] = ["HermesInternal", "WebSocket", "XMLHttpRequest", "__fbBatchedBridge", "__turboModuleProxy", "fetch", "nativeCallSyncHook", "nativeLoggingHook"];

export const HOST_GLOBALS_SET: ReadonlySet<string> = new Set(HOST_GLOBALS);
