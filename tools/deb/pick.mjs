#!/usr/bin/env node
// tools/deb/pick.mjs — load-aware host picker for tools/deb/run.sh
// (docs/specs/24-compute-node.md §3). Given a list of candidate compute-node
// URLs, picks the one with the lowest load *score* by polling each host's
// GET /load (2 s timeout each), skipping unreachable hosts. A host that
// answers GET /jobs but not GET /load (older server, pre load-aware picking)
// falls back to a count-based score (queued+running) for that host only,
// noted on stderr. Pure `pickHost` takes an injectable fetcher so this is
// unit-testable without a network (tests/gate/tools/deb-pick.test.ts) —
// run.sh shells out to the CLI entry below, which uses the real `fetch`
// with an AbortSignal timeout.

/**
 * @typedef {{score: number, fallback?: boolean}} HostInfo
 */

/**
 * The load score formula (docs/DEB-CI.md "Load-aware picking"): combines
 * instantaneous CPU pressure (1-minute loadavg normalised by core count)
 * with queue pressure (queued+running jobs normalised by that host's own
 * MAX_PARALLEL), so an idle box with a full queue does not win over a
 * lightly-loaded box that is already busy. Lower is better.
 *
 * @param {number} loadavg1 - 1-minute load average (os.loadavg()[0]).
 * @param {number} nproc - number of logical cores on the host.
 * @param {number} queued - jobs currently queued on the host.
 * @param {number} running - jobs currently running on the host.
 * @param {number} maxParallel - the host's configured MAX_PARALLEL.
 * @returns {number}
 */
export function computeLoadScore(loadavg1, nproc, queued, running, maxParallel) {
  const n = nproc > 0 ? nproc : 1;
  const mp = maxParallel > 0 ? maxParallel : 1;
  return loadavg1 / n + (queued + running) / mp;
}

/**
 * Picks the reachable host with the lowest score. Ties go to list order
 * (first host with the minimum score wins, since later hosts only replace
 * the best on a strictly-lower score). Throws if no host is reachable.
 *
 * @param {readonly string[]} hosts - candidate host URLs, in preference order.
 * @param {(host: string) => Promise<HostInfo>} fetchLoad - resolves with
 *   that host's score info, or rejects/times out if unreachable.
 * @returns {Promise<{host: string, score: number, results: ({host: string} & HostInfo)[], skipped: {host: string, error: string}[]}>}
 */
export async function pickHost(hosts, fetchLoad) {
  const skipped = [];
  const results = [];
  let best;
  for (const host of hosts) {
    let info;
    try {
      info = await fetchLoad(host);
    } catch (e) {
      skipped.push({ host, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const entry = { host, score: info.score, fallback: !!info.fallback };
    results.push(entry);
    if (best === undefined || entry.score < best.score) {
      best = entry;
    }
  }
  if (best === undefined) {
    const detail = skipped.map((s) => `${s.host} (${s.error})`).join(", ");
    throw new Error(`no host reachable: ${detail || "no hosts given"}`);
  }
  return { host: best.host, score: best.score, results, skipped };
}

/** GET <url> with a timeout; parses JSON; throws on non-2xx or timeout. */
async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Real fetcher: GET <host>/load; if that fails (older server without the
 * route, or any other error), fall back to GET <host>/jobs and a
 * count-based score, noting the fallback on stderr. Only truly unreachable
 * hosts (both endpoints fail) propagate an error to pickHost.
 */
async function fetchLoadReal(host) {
  try {
    const data = await getJson(`${host}/load`, 2000);
    return { score: Number(data.score), fallback: false };
  } catch {
    const jobs = await getJson(`${host}/jobs`, 2000);
    process.stderr.write(`pick.mjs: ${host} has no /load (older server) -- falling back to queued+running count\n`);
    const running = jobs.filter((j) => j.status === "running").length;
    const queued = jobs.filter((j) => j.status === "queued").length;
    return { score: queued + running, fallback: true };
  }
}

async function main(argv) {
  const hosts = argv.filter((a) => a.length > 0);
  if (hosts.length === 0) {
    process.stderr.write("usage: pick.mjs <host-url> [<host-url> ...]\n");
    return 2;
  }
  try {
    const result = await pickHost(hosts, fetchLoadReal);
    for (const s of result.skipped) {
      process.stderr.write(`pick.mjs: skipping unreachable host ${s.host} (${s.error})\n`);
    }
    for (const r of result.results) {
      process.stderr.write(`pick.mjs: ${r.host} score=${r.score.toFixed(3)}${r.fallback ? " (fallback)" : ""}\n`);
    }
    process.stderr.write(`pick.mjs: chosen host ${result.host} (score=${result.score.toFixed(3)})\n`);
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
