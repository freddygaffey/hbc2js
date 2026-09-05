// src/workers/leads-worker.ts — off-main-thread compute for `GET /api/leads`
// / `GET /api/leads/security-sinks` (docs/UI-BURS.md bur 1 row 2, spec 26
// L6). `computeLeads` (src/mcp/leads.ts) is a whole-bundle scan — measured
// 37.7 s cold / 9.4 s warm on Service NSW — and the ui-server's event loop
// must never block on it: while the scan ran inline, every OTHER route
// (`/api/segregation`, `/api/findings`, `/api/log/tail`) landed ~41 s late
// on a real page load. This worker builds its OWN `ArtifactService` from
// `artifactDir` (read-only, exactly `ArtifactService`'s normal construction
// path — the same reasoning `src/workers/segregate-worker.ts` gives for
// re-deriving rather than sharing state across the thread boundary) and
// posts the plain-JSON-able `LeadsResult` back over `parentPort`. Never
// touches the project DB — `computeLeads` reads only `native`/`stringUses`/
// `globalUses`, never a write path.
import { parentPort, workerData } from "node:worker_threads";
import { ArtifactService } from "../artifact/service.ts";
import { computeLeads, type LeadsResult } from "../mcp/leads.ts";

/** `workerData` shape `runLeadsWorker` (`src/ui-server/list.ts`) sends.
 *  `computeLeads` reads only `native`/`stringUses`/`globalUses` — never
 *  `source(fn)` — so, like `segregationOf`, this never needs the `.hbc`
 *  path `ArtifactService`'s `opts.hbc` would otherwise carry. */
export interface LeadsWorkerInput {
  readonly artifactDir: string;
}

export type LeadsWorkerMessage = { readonly ok: true; readonly result: LeadsResult } | { readonly ok: false; readonly error: string };

if (parentPort !== null) {
  const input = workerData as LeadsWorkerInput;
  try {
    const artifact = new ArtifactService(input.artifactDir);
    const result = computeLeads(artifact);
    const msg: LeadsWorkerMessage = { ok: true, result };
    parentPort.postMessage(msg);
  } catch (err) {
    const msg: LeadsWorkerMessage = { ok: false, error: err instanceof Error ? err.message : String(err) };
    parentPort.postMessage(msg);
  }
}
