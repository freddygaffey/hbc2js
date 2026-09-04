// docs/specs/24-compute-node.md §5 item 5 — the host picker in
// tools/deb/pick.mjs, exercised with fake /jobs responses so this is
// unit-testable without a network. Also a bash -n parse check on run.sh and
// install.sh (spec §3/§2), since the client-side logic they carry is not
// otherwise typechecked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../../support/paths.ts";
import { pickHost } from "../../../tools/deb/pick.mjs";

const root = repoRoot();

function jobs(counts: { queued?: number; running?: number; done?: number }): { status: string }[] {
  const out: { status: string }[] = [];
  for (let i = 0; i < (counts.queued ?? 0); i++) out.push({ status: "queued" });
  for (let i = 0; i < (counts.running ?? 0); i++) out.push({ status: "running" });
  for (let i = 0; i < (counts.done ?? 0); i++) out.push({ status: "done" });
  return out;
}

test("pickHost chooses the host with the fewest queued+running jobs", async () => {
  const fake = new Map<string, { status: string }[]>([
    ["http://a", jobs({ queued: 3, running: 1, done: 100 })],
    ["http://b", jobs({ queued: 0, running: 1 })],
    ["http://c", jobs({ queued: 5 })],
  ]);
  const result = await pickHost(["http://a", "http://b", "http://c"], async (h) => fake.get(h) ?? []);
  assert.equal(result.host, "http://b");
  assert.equal(result.load, 1);
  assert.deepEqual(result.skipped, []);
});

test("pickHost skips unreachable/timed-out hosts", async () => {
  const result = await pickHost(
    ["http://timeout", "http://good"],
    async (h) => {
      if (h === "http://timeout") throw new Error("timed out");
      return jobs({ queued: 2 });
    },
  );
  assert.equal(result.host, "http://good");
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.host, "http://timeout");
});

test("pickHost ties go to list order", async () => {
  const result = await pickHost(
    ["http://first", "http://second"],
    async () => jobs({ queued: 2 }),
  );
  assert.equal(result.host, "http://first");
});

test("pickHost throws with a clear message when every host is unreachable", async () => {
  await assert.rejects(
    () => pickHost(["http://x", "http://y"], async () => { throw new Error("unreachable"); }),
    /no host reachable/,
  );
});

test("pickHost with a single host returns it directly when reachable", async () => {
  const result = await pickHost(["http://only"], async () => jobs({ queued: 4 }));
  assert.equal(result.host, "http://only");
  assert.equal(result.load, 4);
});

test("run.sh and install.sh parse cleanly under bash (macOS/Linux bash 3.2-compatible)", () => {
  execFileSync("bash", ["-n", join(root, "tools", "deb", "run.sh")]);
  execFileSync("bash", ["-n", join(root, "tools", "deb", "install.sh")]);
});

test("run.sh does not use bash-4+-only constructs (mapfile, ${var,,})", () => {
  // Strip comment lines (# ...) first so mentioning these constructs by name
  // in a doc comment — as this repo's own comments do, to say they're
  // avoided — doesn't self-trigger the check; only actual code matters.
  const code = readFileSync(join(root, "tools", "deb", "run.sh"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
  assert.ok(!/\bmapfile\b/.test(code), "run.sh must not use mapfile (bash 4+ only)");
  assert.ok(!/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(code), "run.sh must not use ${var,,} (bash 4+ only)");
});
