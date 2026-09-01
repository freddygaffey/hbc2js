#!/usr/bin/env node
// tools/perf/summarize-cpuprofile.mjs — top self-time frames from a V8
// `--cpu-prof` output, without ever printing the profile itself (which can
// be huge on a real bundle). Usage:
//
//   node tools/perf/summarize-cpuprofile.mjs <file.cpuprofile> [topN=25]
//
// Prints self time (ms) and hit count per (functionName, url:line), sorted
// descending, plus total wall time covered by the profile.
import { readFileSync } from "node:fs";

const [, , path, topNArg] = process.argv;
if (!path) {
  console.error("usage: summarize-cpuprofile.mjs <file.cpuprofile> [topN]");
  process.exit(1);
}
const topN = topNArg ? Number(topNArg) : 25;

const profile = JSON.parse(readFileSync(path, "utf8"));
const nodesById = new Map(profile.nodes.map((n) => [n.id, n]));

// Self time per node id: V8's `timeDeltas[i]` is the time spent in
// `samples[i]` (the node id active during that interval).
const selfMicros = new Map();
const samples = profile.samples ?? [];
const deltas = profile.timeDeltas ?? [];
let totalMicros = 0;
for (let i = 0; i < samples.length; i++) {
  const dt = deltas[i] ?? 0;
  totalMicros += dt;
  const id = samples[i];
  selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt);
}

const rows = [];
for (const [id, micros] of selfMicros) {
  const node = nodesById.get(id);
  if (!node) continue;
  const cf = node.callFrame;
  const name = cf.functionName || "(anonymous)";
  const url = cf.url ? cf.url.replace(/^file:\/\//, "") : "(native)";
  const loc = url ? `${url}:${cf.lineNumber + 1}` : "";
  rows.push({ name, loc, ms: micros / 1000, hits: node.hitCount ?? 0 });
}
rows.sort((a, b) => b.ms - a.ms);

console.log(`total sampled wall time: ${(totalMicros / 1000).toFixed(0)} ms, ${samples.length} samples, ${rows.length} distinct frames with self time`);
console.log("");
console.log("self_ms\thits\tfunction\tlocation");
for (const r of rows.slice(0, topN)) {
  console.log(`${r.ms.toFixed(1)}\t${r.hits}\t${r.name}\t${r.loc}`);
}
