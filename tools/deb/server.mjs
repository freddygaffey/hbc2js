#!/usr/bin/env node
// tools/deb/server.mjs — small HTTP job runner for hbc2js CI on `deb`.
//
// LAN-only, no auth (trusted network — see docs/DEB-CI.md). Node 22, no deps
// beyond node:http/child_process/fs/crypto.
//
// POST /jobs      {ref, cmd, timeoutMin?, keep?, env?}  -> {id}
// GET  /jobs/:id                                        -> {id, status, exitCode, durationS, tail}
// GET  /jobs/:id/log                                    -> full log text
// GET  /jobs                                            -> [{id, status, ref, cmd, exitCode, durationS, createdAt}]
// GET  /load                                            -> {host, platform, nproc, loadavg, running, queued, maxParallel, score}
//   (docs/DEB-CI.md "Load-aware picking" -- consumed by tools/deb/pick.mjs)
//
// Runs on Linux (`deb`) or macOS (a Mac instance, see tools/deb/start-local.sh):
// HBC2JS_TOOLCHAIN_DIR (default ~/hbc2js-dev/tools), HBC2JS_CI_DIR (default
// ~/hbc2js-ci) and PORT (default 8787) are all configurable so more than one
// node can run this file with different state/toolchain locations.
//
// A job: fetch <ref> into a shared bare mirror, `git worktree add` the sha,
// symlink tools/hermesc + tools/hermes-vm from HBC2JS_TOOLCHAIN_DIR if present, npm ci
// (cached by lockfile hash), run `cmd` under bash -lc with a timeout, log to
// disk, remove the worktree unless `keep`. Job metadata is persisted as JSON
// so a server restart doesn't lose history (in-flight jobs are marked
// interrupted, not resumed).

import http from "node:http";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { computeLoadScore } from "./pick.mjs";

const HOME = os.homedir();
const PORT = Number(process.env.PORT || 8787);
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL || 4);
// HBC2JS_CI_DIR is the documented name (docs/DEB-CI.md); CI_HOME is kept as
// a fallback so an already-deployed unit that only sets CI_HOME keeps working.
const CI_HOME = process.env.HBC2JS_CI_DIR || process.env.CI_HOME || path.join(HOME, "hbc2js-ci");
const REPO_URL = process.env.REPO_URL || "https://github.com/freddygaffey/hbc2js.git";
// HBC2JS_TOOLCHAIN_DIR points *at* the tools dir directly (unlike the old
// DEV_CLONE, which pointed at the repo checkout containing tools/) so a
// non-`deb` node (e.g. this repo's own tools/ on the Mac) can be used as-is.
const TOOLCHAIN_DIR = process.env.HBC2JS_TOOLCHAIN_DIR
  || (process.env.DEV_CLONE ? path.join(process.env.DEV_CLONE, "tools") : path.join(HOME, "hbc2js-dev", "tools"));
const DEFAULT_TIMEOUT_MIN = Number(process.env.DEFAULT_TIMEOUT_MIN || 30);
const LOG_RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 14);

const MIRROR = path.join(CI_HOME, "mirror.git");
const JOBS_DIR = path.join(CI_HOME, "jobs");
const LOGS_DIR = path.join(CI_HOME, "logs");
const META_DIR = path.join(CI_HOME, "meta");
const NM_CACHE = path.join(CI_HOME, "nm-cache");

for (const d of [CI_HOME, JOBS_DIR, LOGS_DIR, META_DIR, NM_CACHE]) fs.mkdirSync(d, { recursive: true });

function sh(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve({ stdout, stderr });
    });
  });
}

async function ensureMirror() {
  if (!fs.existsSync(path.join(MIRROR, "HEAD"))) {
    await sh("git", ["clone", "--bare", REPO_URL, MIRROR]);
  }
}

// Resolve a node 22 binary once at startup (via fnm), and prepend its dir to
// PATH for every spawned job — avoids relying on fnm's shell hooks per job.
let NODE22_BIN_DIR = null;
async function resolveNode22() {
  const fnmDir = path.join(HOME, ".local", "share", "fnm");
  const env = { ...process.env, PATH: `${fnmDir}:${process.env.PATH}` };
  try {
    if (/^v2[2-9]\./.test(process.version)) { NODE22_BIN_DIR = path.dirname(process.execPath); return; }
    const { stdout } = await sh("fnm", ["exec", "--using", "22", "--", "node", "-e", "console.log(process.execPath)"], { env });
    NODE22_BIN_DIR = path.dirname(stdout.trim());
  } catch {
    // fnm not installed, or no node 22 pinned via fnm (e.g. a Mac instance
    // started directly with `node` -- see tools/deb/start-local.sh). Fall
    // back to this process's own binary directory so jobs still get a
    // consistent, known-good node instead of whatever happens to be on PATH.
    NODE22_BIN_DIR = path.dirname(process.execPath);
  }
}

// ---- job state -------------------------------------------------------

const jobs = new Map(); // id -> meta object (in memory, mirrors the JSON file)
const queue = []; // pending ids, FIFO
let activeCount = 0;

function metaPath(id) { return path.join(META_DIR, `${id}.json`); }
function logPath(id) { return path.join(LOGS_DIR, `${id}.log`); }

function saveMeta(m) {
  fs.writeFileSync(metaPath(m.id), JSON.stringify(m, null, 2));
}

function loadHistory() {
  for (const f of fs.readdirSync(META_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(fs.readFileSync(path.join(META_DIR, f), "utf8"));
      if (m.status === "running" || m.status === "queued") {
        m.status = "done";
        m.exitCode = -1;
        m.error = "server restarted before job finished";
        m.finishedAt = m.finishedAt || new Date().toISOString();
        saveMeta(m);
      }
      jobs.set(m.id, m);
    } catch { /* ignore corrupt meta file */ }
  }
}

function newId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  return `job-${ts}-${crypto.randomBytes(3).toString("hex")}`;
}

function tailOf(id, n = 40) {
  const p = logPath(id);
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, "utf8");
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n);
}

async function runJob(m) {
  activeCount++;
  m.status = "running";
  m.startedAt = new Date().toISOString();
  saveMeta(m);
  const log = fs.createWriteStream(logPath(m.id), { flags: "a" });
  const jobDir = path.join(JOBS_DIR, m.id);
  const t0 = Date.now();
  let exitCode = null;
  try {
    log.write(`[deb-ci] fetching ${m.ref}\n`);
    await sh("git", ["fetch", "origin", `+${m.ref}:refs/heads/${m.ref}`], { cwd: MIRROR });
    const { stdout: shaOut } = await sh("git", ["rev-parse", `refs/heads/${m.ref}`], { cwd: MIRROR });
    m.sha = shaOut.trim();
    saveMeta(m);
    log.write(`[deb-ci] sha ${m.sha}\n`);

    await sh("git", ["worktree", "add", "--detach", jobDir, m.sha], { cwd: MIRROR });

    for (const name of ["hermesc", "hermes-vm"]) {
      const src = path.join(TOOLCHAIN_DIR, name);
      const dst = path.join(jobDir, "tools", name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.symlinkSync(src, dst);
    }

    const lockFile = path.join(jobDir, "package-lock.json");
    let installed = false;
    if (fs.existsSync(lockFile)) {
      const hash = crypto.createHash("sha256").update(fs.readFileSync(lockFile)).digest("hex").slice(0, 16);
      // The cache dir MUST itself be named `node_modules`: TypeScript (and
      // Node) resolve through the symlink to the real path and then walk up
      // looking for an ancestor `node_modules/<pkg>`. A cache laid out as
      // nm-cache/<hash>/<pkg> made `@types/node`'s `undici-types` import fail
      // silently on Linux only (macOS has no symlink) → `Response.ok` errors.
      const cacheDir = path.join(NM_CACHE, hash, "node_modules");
      const nodeModules = path.join(jobDir, "node_modules");
      if (fs.existsSync(cacheDir)) {
        log.write(`[deb-ci] node_modules cache hit ${hash}\n`);
        fs.symlinkSync(cacheDir, nodeModules);
        installed = true;
      } else {
        log.write(`[deb-ci] npm ci (cache miss ${hash})\n`);
        await new Promise((resolve, reject) => {
          const env = { ...process.env, ...(m.env || {}) };
          if (NODE22_BIN_DIR) env.PATH = `${NODE22_BIN_DIR}:${env.PATH}`;
          // Absolute npm from the node-22 dir: `bash -l` profiles and a PATH-only
          // prepend both lost to fnm's default (node 18 / npm 9 → incomplete
          // node_modules, e.g. no undici-types → `Response.ok` typecheck errors).
          const npmBin = NODE22_BIN_DIR ? path.join(NODE22_BIN_DIR, "npm") : "npm";
          const p = spawn(npmBin, ["ci"], { cwd: jobDir, env });
          p.stdout.pipe(log, { end: false });
          p.stderr.pipe(log, { end: false });
          p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm ci exit ${code}`))));
          p.on("error", reject);
        });
        if (fs.existsSync(nodeModules)) {
          fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
          fs.renameSync(nodeModules, cacheDir);
          fs.symlinkSync(cacheDir, nodeModules);
        }
        installed = true;
      }
    }
    if (!installed) log.write(`[deb-ci] no package-lock.json, skipping npm ci\n`);

    log.write(`[deb-ci] running: ${m.cmd}\n`);
    exitCode = await new Promise((resolve) => {
      const env = { ...process.env, ...(m.env || {}) };
      if (NODE22_BIN_DIR) env.PATH = `${NODE22_BIN_DIR}:${env.PATH}`;
      // Re-export PATH *inside* the login shell so ~/.profile / fnm hooks cannot
      // put node 18 back in front of node 22.
      const wrapped = NODE22_BIN_DIR ? `export PATH="${NODE22_BIN_DIR}:$PATH"; ${m.cmd}` : m.cmd;
      const child = spawn("bash", ["-lc", wrapped], { cwd: jobDir, env, detached: true });
      const timer = setTimeout(() => {
        log.write(`\n[deb-ci] TIMEOUT after ${m.timeoutMin}min, killing\n`);
        try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
      }, m.timeoutMin * 60 * 1000);
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on("exit", (code) => { clearTimeout(timer); resolve(code); });
      child.on("error", (e) => { clearTimeout(timer); log.write(`[deb-ci] spawn error: ${e.message}\n`); resolve(-1); });
    });
    log.write(`[deb-ci] exit ${exitCode}\n`);
  } catch (e) {
    log.write(`[deb-ci] setup error: ${e && e.message}\n${e && e.stderr ? e.stderr : ""}\n`);
    exitCode = exitCode === null ? -1 : exitCode;
  } finally {
    log.end();
    if (!m.keep) {
      try { await sh("git", ["worktree", "remove", "--force", jobDir], { cwd: MIRROR }); } catch { /* best effort */ }
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    m.status = "done";
    m.exitCode = exitCode;
    m.durationS = Math.round((Date.now() - t0) / 100) / 10;
    m.finishedAt = new Date().toISOString();
    saveMeta(m);
    activeCount--;
    pump();
  }
}

function pump() {
  while (activeCount < MAX_PARALLEL && queue.length > 0) {
    const id = queue.shift();
    const m = jobs.get(id);
    if (m) runJob(m);
  }
}

function cleanupOldLogs() {
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const dir of [LOGS_DIR, META_DIR]) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  }
}

// ---- HTTP --------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function summarize(m) {
  return {
    id: m.id, status: m.status, ref: m.ref, sha: m.sha, cmd: m.cmd,
    exitCode: m.exitCode ?? null, durationS: m.durationS ?? null,
    createdAt: m.createdAt, startedAt: m.startedAt, finishedAt: m.finishedAt,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST" && url.pathname === "/jobs") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.ref || !body.cmd) return json(res, 400, { error: "ref and cmd are required" });
      const id = newId();
      const m = {
        id, ref: String(body.ref), cmd: String(body.cmd),
        timeoutMin: Number(body.timeoutMin || DEFAULT_TIMEOUT_MIN),
        keep: !!body.keep, env: body.env || {},
        status: "queued", createdAt: new Date().toISOString(),
        exitCode: null, durationS: null,
      };
      jobs.set(id, m);
      saveMeta(m);
      queue.push(id);
      pump();
      return json(res, 202, { id });
    }
    const jobMatch = url.pathname.match(/^\/jobs\/([^/]+)(\/log)?$/);
    if (req.method === "GET" && jobMatch) {
      const id = jobMatch[1];
      const m = jobs.get(id);
      if (!m) return json(res, 404, { error: "no such job" });
      if (jobMatch[2]) {
        const p = logPath(id);
        const text = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end(text);
      }
      return json(res, 200, { ...summarize(m), tail: tailOf(id) });
    }
    if (req.method === "GET" && url.pathname === "/jobs") {
      const list = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, 100);
      return json(res, 200, list.map(summarize));
    }
    if (req.method === "GET" && url.pathname === "/load") {
      const nproc = os.cpus().length || 1;
      const loadavg = os.loadavg();
      const queued = queue.length;
      const running = activeCount;
      const score = computeLoadScore(loadavg[0], nproc, queued, running, MAX_PARALLEL);
      return json(res, 200, {
        host: os.hostname(), platform: os.platform(), nproc, loadavg,
        running, queued, maxParallel: MAX_PARALLEL, score,
      });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

async function main() {
  loadHistory();
  await ensureMirror();
  await resolveNode22();
  cleanupOldLogs();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`hbc2js-ci listening on 0.0.0.0:${PORT} (MAX_PARALLEL=${MAX_PARALLEL}, node22=${NODE22_BIN_DIR || "PATH default"})`);
  });
}

main();
