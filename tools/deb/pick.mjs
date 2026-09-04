#!/usr/bin/env node
// tools/deb/pick.mjs — host picker for tools/deb/run.sh (docs/specs/24-compute-node.md
// §3). Given a list of candidate compute-node URLs, picks the one with the
// fewest `queued + running` jobs by polling each host's GET /jobs (2 s
// timeout each), skipping unreachable hosts. Pure `pickHost` takes an
// injectable fetcher so this is unit-testable without a network
// (tests/gate/tools/deb-pick.test.ts) — run.sh shells out to the CLI entry
// below, which uses the real `fetch` with an AbortSignal timeout.

/**
 * @typedef {{status: string}} JobSummary
 */

/**
 * Picks the reachable host with the fewest queued+running jobs. Ties go to
 * list order (first host with the minimum count wins). Throws if no host
 * is reachable.
 *
 * @param {readonly string[]} hosts - candidate host URLs, in preference order.
 * @param {(host: string) => Promise<JobSummary[]>} fetchJobs - resolves with
 *   that host's `/jobs` array, or rejects/times out if unreachable.
 * @returns {Promise<{host: string, load: number, skipped: {host: string, error: string}[]}>}
 */
export async function pickHost(hosts, fetchJobs) {
  const skipped = [];
  let best;
  for (const host of hosts) {
    let jobs;
    try {
      jobs = await fetchJobs(host);
    } catch (e) {
      skipped.push({ host, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const load = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    if (best === undefined || load < best.load) {
      best = { host, load };
    }
  }
  if (best === undefined) {
    const detail = skipped.map((s) => `${s.host} (${s.error})`).join(", ");
    throw new Error(`no host reachable: ${detail || "no hosts given"}`);
  }
  return { host: best.host, load: best.load, skipped };
}

/** Real fetcher: GET <host>/jobs with a 2s timeout via curl-equivalent fetch. */
async function fetchJobsReal(host) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${host}/jobs`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function main(argv) {
  const hosts = argv.filter((a) => a.length > 0);
  if (hosts.length === 0) {
    process.stderr.write("usage: pick.mjs <host-url> [<host-url> ...]\n");
    return 2;
  }
  try {
    const result = await pickHost(hosts, fetchJobsReal);
    for (const s of result.skipped) {
      process.stderr.write(`pick.mjs: skipping unreachable host ${s.host} (${s.error})\n`);
    }
    process.stderr.write(`pick.mjs: chosen host ${result.host} (load=${result.load})\n`);
    process.stdout.write(`${result.host}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`pick.mjs: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
