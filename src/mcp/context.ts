// src/mcp/context.ts — docs/specs/17-mcp-harness.md §15 (spec 22 §3.5's
// read-after-write note): `McpResources` and `McpTools` used to each build
// their OWN `ArtifactService`/`ProjectService` pair (both classes' own
// constructor doc comments, before this round, said as much — "this round
// does not share a live pair across the two classes ... deferred to the
// transport binding"). That meant a write through one `McpTools` was
// invisible to a DIFFERENT `McpResources`'s in-memory-cached reads
// (`ProjectService`'s `tagStore`/`commentStore`/etc, spec 16 §3.2's "warm
// services") until that `McpResources` was rebuilt from scratch — the
// workaround `src/ui-server/server.ts` carried ("rebuilds `ctx.resources`
// after every write-tool call that lands a change").
//
// `McpContext` is that "transport binding's decision", made once: it
// builds ONE `ArtifactService`/`ProjectService` pair and hands out a
// `McpResources`/`McpTools` constructed OVER those same instances (the
// injection point both classes' constructors added this round). A write
// through `.tools` calls `ProjectService`'s own write path, which reloads
// ITS OWN in-memory caches (`reloadFromDb()`) — since `.resources` reads
// through that SAME instance, the next read sees the write with no rebuild
// step anywhere. `McpResources`/`McpTools` constructed directly (the
// existing 2-arg form) are completely unaffected — this file adds a THIRD
// way to get either, it changes neither existing one.
import { ArtifactService } from "../artifact/service.ts";
import { ProjectService } from "../project/service.ts";
import { McpResources } from "./resources.ts";
import { McpTools } from "./tools.ts";

export interface McpContextOpts {
  readonly hbc?: string;
  readonly overlayStorePath?: string;
}

export class McpContext {
  readonly artifact: ArtifactService;
  readonly project: ProjectService;
  readonly resources: McpResources;
  readonly tools: McpTools;

  constructor(artifactDir: string, opts: McpContextOpts = {}) {
    this.artifact = new ArtifactService(artifactDir, opts);
    this.project = new ProjectService(artifactDir, this.artifact);
    const services = { artifact: this.artifact, project: this.project };
    this.resources = new McpResources(artifactDir, opts, services);
    this.tools = new McpTools(artifactDir, opts, services);
  }
}
