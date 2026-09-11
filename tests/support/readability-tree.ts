// tests/support/readability-tree.ts -- a tiny, gate-fast readable tree built
// from a CONSTRUCT FIXTURE, for the spec 28 landing 3 transaction/file-op
// tests. Real decompiled text and real `{fn,reg}` binding ids, no whole-bundle
// render (docs/specs/28-llm-readability.md landing 3: the held-out-app pass is
// a `tests/sweep/` follow-up, not the 2-minute gate).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { repoRoot } from "./paths.ts";
import { parseForDecompile } from "../../src/decompile.ts";
import { analyseModule } from "../../src/cfg/index.ts";
import { NameService, OverlayStore, regId } from "../../src/name-overlay/index.ts";
import { rawFrameBodies } from "../../src/name-overlay/frames.ts";
import { listNameable } from "../../src/artifact/frame-queries.ts";
import type { BindingOrigin } from "../../src/readability/types.ts";

export const FIXTURE = "04-for-loop-basic";

/** The fixture's faithful render plus a couple of real register binding ids
 *  from it -- the origins a readable file must keep tracing back to. */
export function fixtureSource(fixture = FIXTURE): { code: string; bindings: BindingOrigin[] } {
  const bytes = new Uint8Array(readFileSync(join(repoRoot(), "tests", "fixtures", "constructs", fixture, "v94.hbc")));
  const analysis = analyseModule(parseForDecompile(bytes, {}).module, { strictEnv: true });
  const store = new OverlayStore({ bundle: fixture });
  const service = new NameService(analysis, store);
  const frames = rawFrameBodies(analysis);
  const bindings: BindingOrigin[] = [];
  for (let fn = 0; fn < analysis.module.functions.length && bindings.length < 4; fn++) {
    for (const nameable of listNameable(frames, fn, store)) {
      if (bindings.length >= 4) break;
      // Both module files in the tree below hold the same fixture body, so
      // the same {fn,reg} id is a legitimate origin under either module
      // index; alternating gives the combine/split tests two distinct
      // modules to union and partition.
      bindings.push({ module: bindings.length % 2 === 0 ? 1 : 2, binding: regId(fn, nameable.reg) });
    }
  }
  return { code: service.render({ fn: 0 }).code, bindings };
}

export interface Fixture {
  readonly db: DatabaseSync;
  readonly projectDir: string;
  readonly treeDir: string;
  readonly bindings: readonly BindingOrigin[];
}

const ddl = readFileSync(new URL("../../src/projdb/schema.sql", import.meta.url), "utf8");

export function freshProjectDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return db;
}

function write(root: string, path: string, content: string): void {
  const abs = join(root, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

/** A two-module split tree (spec 08 shape) whose module bodies are the real
 *  decompile of a construct fixture. */
export function makeTree(prefix = "hbc2js-readability-"): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const projectDir = join(root, "project");
  const treeDir = join(root, "tree");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(treeDir, { recursive: true });
  const { code, bindings } = fixtureSource();
  write(treeDir, "src/module_1.js", `function loopBody() {\n${code}\n}\nexports.loopBody = loopBody;\n`);
  write(treeDir, "src/module_2.js", `function second() {\n${code}\n}\nexports.second = second;\n`);
  write(treeDir, "index.js", `const a = require("./src/module_1.js");\nconst b = require("./src/module_2.js");\nmodule.exports = { a, b };\n`);
  write(
    treeDir,
    "MODULES.json",
    `${JSON.stringify({ entry: 0, modules: [{ id: 1, file: "src/module_1.js", deps: [] }, { id: 2, file: "src/module_2.js", deps: [1] }] }, null, 2)}\n`,
  );
  return { db: freshProjectDb(), projectDir, treeDir, bindings };
}
