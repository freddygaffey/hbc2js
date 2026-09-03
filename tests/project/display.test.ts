// A-DISPLAY, non-comment portion (spec 11 §6/§7 step 3 — comments' half of
// A-DISPLAY, incl. the opt-in `--with-comments` view, lands with the render
// wiring in a later step). Proves §4.3's guarantee for `tags`/`bookmarks`:
// "the canonical render is a function of binary + names overlay ONLY" — no
// project-store record type changes rendered code, by construction (there is
// no code path, not merely "empirically unchanged").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../support/paths.ts";
import { decompileTree } from "../../src/decompile.ts";
import { TagStore } from "../../src/project/tags.ts";
import { BookmarkStore } from "../../src/project/bookmarks.ts";

const FIXTURE = join(repoRoot(), "tests", "fixtures", "constructs", "01-if-else-chain", "v94.hbc");

function bytes(): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURE));
}

test("canonical decompile() takes no project-store input at all (by-construction guarantee)", () => {
  // `decompile`/`decompileTree` are the canonical render entry (spec 10
  // §4.2). Its options type never references a project-store shape — the
  // strongest form of "no code path": there is nowhere to plug one in.
  const src = readFileSync(join(repoRoot(), "src", "decompile.ts"), "utf8");
  assert.doesNotMatch(src, /project\/(tags|bookmarks|comments|schema|revision-store)/, "decompile.ts must not import any project-store module");
});

test("record modules never import a render/emit module (no reverse code path either)", () => {
  for (const f of ["tags.ts", "bookmarks.ts", "comments.ts"]) {
    const src = readFileSync(join(repoRoot(), "src", "project", f), "utf8");
    assert.doesNotMatch(src, /from ["'].*\/(emit|structure|cfg|passes)\//, `src/project/${f} must not import a render/emit module`);
  }
});

test("writing tags/bookmarks around a decompile leaves its output byte-identical", () => {
  const before = decompileTree(bytes());

  const tags = new TagStore();
  tags.setTag("fn:0", "suspicious", { source: "human", who: "analyst@duck.com" }, { note: "poking at this fixture" });
  const bookmarks = new BookmarkStore();
  bookmarks.setBookmark("fn:0", { source: "human", who: "analyst@duck.com" }, { label: "revisit" });

  const after = decompileTree(bytes());
  assert.equal(after, before, "decompileTree output must be byte-identical regardless of any in-flight project-store writes");
  // And the written values never leak into the render text either.
  assert.doesNotMatch(after, /suspicious|revisit|poking at this fixture/);
});
