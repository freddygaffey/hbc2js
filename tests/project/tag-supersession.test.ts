// P3 (spec 11 §6, pre-implementation) — append-only supersession + revert on
// a non-name record (a tag), "reusing the overlay's own supersession test
// shape" to prove the extracted `RevisionStore<T>` (spec 11 §2.4, §7 step 1)
// behaves identically for a new record type. `src/project/revision-store.ts`
// does not exist yet — step 0 ships no product code (spec 11 §7) — so this
// test cannot genuinely pass until step 1 lands. Per the "skip/todo, never a
// red gate" rule, it is marked `todo` naming the flip-on step; the body below
// is written against the exact shape §2.4/§7 promises so step 1's implementer
// can delete the `{ todo }` option and the not-yet-landed guard and have a
// passing test, with no other edits.
//
// Shape mirrored from `tests/gate/name-overlay/store.test.ts`'s
// "setName is append-only" / "revert restores the prior name" tests (§2.4:
// "Comments/tags/bookmarks/findings are new `RevisionStore` instances over
// their own files... This is a refactor-with-no-behaviour-change... plus new
// record-type modules").
import { test } from "node:test";
import assert from "node:assert/strict";

const REVISION_STORE_PATH = "../../src/project/revision-store.ts";

test(
  "P3 tag record supersession + revert mirrors the overlay's RevisionStore shape (spec 11 §2.4/§7 step 1)",
  { todo: "lands with src/project/revision-store.ts, spec 11 §7 step 1 (RevisionStore extraction)" },
  async () => {
    const mod = (await import(REVISION_STORE_PATH).catch(() => null)) as null | {
      RevisionStore: new (opts: { bundle?: string }) => {
        now: () => string;
        set(target: string, value: unknown): { record: { rid: string; supersedes: string | null }; superseded: { rid: string } | null };
        get(target: string): { rid: string; value: unknown } | undefined;
        history(target: string): { rid: string; value: unknown }[];
        revert(target: string, to?: string): { value: unknown } | null;
        allRecords(): { active: boolean }[];
      };
    };
    assert.ok(mod, `${REVISION_STORE_PATH} does not exist yet (spec 11 §7 step 1)`);
    if (!mod) return;

    const { RevisionStore } = mod;
    const store = new RevisionStore({ bundle: "t.hbc" });
    let n = 0;
    store.now = () => `2026-01-01T00:00:${String(n++).padStart(2, "0")}.000Z`;

    const target = "reg:42:7";
    const first = store.set(target, { tag: "suspicious" });
    const second = store.set(target, { tag: "source" });

    // Append-only: a second record supersedes without loss (mirrors the
    // overlay's "setName is append-only" test).
    assert.equal((store.get(target)?.value as { tag: string }).tag, "source");
    assert.equal(second.superseded!.rid, first.record.rid);
    assert.equal(second.record.supersedes, first.record.rid);
    const h = store.history(target);
    assert.deepEqual(
      h.map((r) => (r.value as { tag: string }).tag),
      ["source", "suspicious"],
    );
    assert.equal(store.allRecords().filter((r) => r.active).length, 1);

    // Revert restores the prior record (mirrors the overlay's "revert
    // restores the prior name" test).
    const reverted = store.revert(target);
    assert.equal((reverted!.value as { tag: string }).tag, "suspicious");
    assert.equal(store.revert(target), null); // nothing earlier left to revert to
  },
);
