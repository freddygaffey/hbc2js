// tests/gate/ui/activity.test.ts — wave-2 track 3 (the bottom pane's
// activity feed) invariants.
//
// `summarize()`/`targetFn()` (`ui/src/activity/format.ts`) are the only
// place that turns a raw `log` row into what the "Activity" tab shows;
// getting the `op`/`detail` mapping wrong would silently make every row say
// "annotate: {}" instead of "renamed" and no build-time check would catch
// it. Exercised against the exact rows the live Service NSW project server
// returned for `GET /api/log/tail?since=0` (seq 1-4: `init`,
// `rebuild-index`, two `annotate` rows) — real payload shapes, not
// invented ones.
//
// Pure dynamic import of the pure helper, same pattern as
// tests/gate/ui/listing.test.ts: runs under the root `npm test` with no
// `ui/node_modules` present.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../../support/paths.ts";

const formatFile = join(repoRoot(), "ui", "src", "activity", "format.ts");

interface LogEntry {
  readonly seq: number;
  readonly ts: string;
  readonly who: string;
  readonly op: string;
  readonly detail: string | null;
}

function row(seq: number, ts: string, who: string, op: string, detail: string | null): LogEntry {
  return { seq, ts, who, op, detail };
}

test("summarize() matches the live server's real log rows", async () => {
  const { summarize } = await import(pathToFileURL(formatFile).href);
  assert.equal(
    summarize(row(1, "2026-09-04T12:56:27.493Z", "hbc2js-cli", "init", '{"bundleSha256":"427014..."}')),
    "project initialised",
  );
  assert.equal(
    summarize(row(2, "2026-09-04T12:56:27.493Z", "hbc2js-cli", "rebuild-index", '{"functions":43384,"calls":175350,"strings":57097,"modules":4510}')),
    "project initialised: 43,384 functions",
  );
  assert.equal(summarize(row(3, "2026-09-04T12:58:14.268Z", "ui", "annotate", '{"kind":"name"}')), "renamed");
  assert.equal(summarize(row(4, "2026-09-04T12:58:14.308Z", "ui", "annotate", '{"kind":"comment"}')), "commented");
});

test("summarize() covers every RevisionKind and reverts", async () => {
  const { summarize } = await import(pathToFileURL(formatFile).href);
  for (const kind of ["name", "comment", "tag", "bookmark", "finding", "status", "conflict"]) {
    const text = summarize(row(1, "2026-01-01T00:00:00Z", "ui", "annotate", `{"kind":"${kind}"}`));
    assert.ok(text.length > 0 && !text.includes("undefined"), `kind "${kind}" produced "${text}"`);
  }
  assert.match(summarize(row(1, "2026-01-01T00:00:00Z", "ui", "revert", '{"kind":"tag"}')), /^reverted/);
});

test("summarize() never throws on malformed or missing detail", async () => {
  const { summarize } = await import(pathToFileURL(formatFile).href);
  assert.doesNotThrow(() => summarize(row(1, "2026-01-01T00:00:00Z", "ui", "annotate", "not json")));
  assert.doesNotThrow(() => summarize(row(1, "2026-01-01T00:00:00Z", "ui", "annotate", null)));
  assert.doesNotThrow(() => summarize(row(1, "2026-01-01T00:00:00Z", "ui", "some-future-op", '{"x":1}')));
});

test("targetFn() reads detail.target/detail.fn defensively, null otherwise", async () => {
  const { targetFn } = await import(pathToFileURL(formatFile).href);
  assert.equal(targetFn(row(1, "t", "ui", "annotate", '{"kind":"name"}')), null);
  assert.equal(targetFn(row(1, "t", "ui", "annotate", '{"target":"fn:7992"}')), 7992);
  assert.equal(targetFn(row(1, "t", "ui", "annotate", '{"fn":42}')), 42);
  assert.equal(targetFn(row(1, "t", "ui", "annotate", '{"target":"reg:7992:3"}')), null);
});

test("formatTime() renders HH:MM:SS and degrades gracefully on a bad timestamp", async () => {
  const { formatTime } = await import(pathToFileURL(formatFile).href);
  assert.match(formatTime("2026-09-04T12:58:14.268Z"), /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(formatTime("not-a-date"), "not-a-date");
});
