#!/usr/bin/env node
// tools/copy-build-assets.mjs — `tsc` only emits `.ts` -> `.js`/`.d.ts`; a
// couple of modules read a sibling non-TS asset at runtime via
// `import.meta.url` (src/projdb/db.ts's `schema.sql`, src/deps/db.ts's
// `sigdb-schema.sql`). Without this, `dist/cli.js` — the packaged
// `bin: hbc2js` entry point — fails on first use of any `hbcproj`/`deps`
// command with an ENOENT for the missing `.sql` file (found via
// docs/specs/18-project-storage-integrity.md §11's CI `hbcproj verify
// --full` smoke step, .github/workflows/ci.yml, which is the first thing
// to exercise a *built* `dist/cli.js` against a real project rather than
// `src/cli.ts` directly). Run as an `npm run build` post-step.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const assets = ["src/projdb/schema.sql", "src/deps/sigdb-schema.sql"];

for (const rel of assets) {
  const src = join(repoRoot, rel);
  const dest = join(repoRoot, "dist", rel.slice("src/".length));
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  process.stdout.write(`copy-build-assets: ${rel} -> ${dest}\n`);
}
