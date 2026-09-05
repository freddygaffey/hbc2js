# Spec 24 — compute node (one box)

**Status:** landed (client side; §3–§5 as below). **Scope:** turn one spare laptop into a job worker the Mac
can hand `npm test` / sweep / bulk jobs to. Reuses `tools/deb/server.mjs`
unchanged; the only new code is a host picker in `tools/deb/run.sh`.
Multi-node scheduling is out of scope — a second node is this spec applied
twice plus the picker.

## 1. Shape

- The **server runs on the worker**, not the Mac. The Mac is a client.
- A job is `{ref, cmd, timeoutMin, keep, env}` → the worker fetches the
  commit into its own bare mirror, adds a detached worktree, `npm ci` (cached
  per lockfile hash), runs `cmd`, logs to its own disk, removes the worktree.
- **Nothing is transferred but commits.** No shared filesystem, no disk
  image. First fetch is the whole repo; every job after that is a delta.
- Results come back as status + log tail (polled). Files a job produces are
  fetched by the Mac with `rsync` from a `--keep` worktree, on demand.

## 2. Node requirements

| Item | Requirement |
|---|---|
| OS | Debian/Ubuntu (x86_64 or arm64). No macOS, no Windows. |
| Power | Lid-close sleep disabled (`HandleLidSwitch=ignore` in `logind.conf`). Plugged in. |
| Network | Same LAN as the Mac. Ethernet preferred. Reachable as `<name>.local` or a static IP, with an SSH alias in `~/.ssh/config`. |
| Runtime | Node 22 via `fnm` (server resolves it once at startup). |
| Toolchain | `~/hbc2js-dev/tools/{hermesc,hermes-vm}` per `docs/TOOLCHAIN.md`; jobs symlink them. Without them, oracle tests skip rather than fail. |
| Service | `systemd --user` unit `hbc2js-ci.service`, `Restart=always`, linger on. Installed by `tools/deb/install.sh <host>`. |
| Port | `0.0.0.0:8787`, LAN only, no auth. Never forward it. |
| Parallelism | `MAX_PARALLEL` = `nproc / 2`, min 1 (default 4 is for deb's 32 cores). |
| Disk | ≥ 20 GB free: mirror + `nm-cache` + up to `MAX_PARALLEL` worktrees. |

## 3. Client changes (`tools/deb/run.sh`)

1. `HBC2JS_CI_HOSTS` (space-separated URLs, default `http://deb.local:8787`)
   replaces the single `DEB_CI_URL`. `DEB_CI_URL` stays as a one-host override.
2. Before POST: `GET /load` on every host (2 s timeout). Skip unreachable
   hosts. Pick the host with the lowest load score (`loadavg[0] / nproc +
   (queued + running) / maxParallel` — docs/DEB-CI.md "Load-aware picking",
   2026-09-05); ties go to list order. Print the chosen host and every
   host's score on stderr. A host answering `GET /jobs` but not `GET /load`
   (pre-load-aware server) falls back to a `queued + running` count for
   itself only.
3. `--host <url>` pins a host and skips the pick.
4. Push step: unchanged (push branch to `origin`, worker fetches from GitHub).
   LAN-direct push to the worker's mirror is a later option, not part of this
   spec — the GitHub hop is seconds and keeps the worker's mirror identical to
   what CI sees.

## 4. Operating rules (add to `docs/AGENT-BRIEF.md`)

- Agents run `npm test`, `npm run test:sweep`, `test:all`, tier sweeps and
  bulk jobs via `tools/deb/run.sh -- <cmd>`, never locally, unless the Mac is
  the only reachable node.
- Local runs are limited to a single test file while iterating.
- On-device (adb) round-trip tests stay on the Mac; no node has a tablet.

## 5. Acceptance

1. `tools/deb/install.sh <node>` from a clean OS install finishes without
   manual steps beyond the SSH alias and the toolchain fetch.
2. `curl <node>:8787/jobs` returns `[]` after a reboot (linger works).
3. `tools/deb/run.sh --host http://<node>:8787 -- npm test` exits with the
   job's exit code and prints the log tail.
4. With deb saturated (`MAX_PARALLEL` jobs running) and the node idle,
   `run.sh` with no `--host` picks the node; with the node unreachable it
   picks deb and prints one warning.
5. `tests/gate/tools/deb-pick.test.ts`: the picker, given fake `/load`
   responses, chooses the lowest score, skips timeouts, honours `--host`
   (see §8 for the 2026-09-05 load-score revision of this item).

## 6. Non-goals

Central scheduler; splitting one `npm test` across machines; shared NFS/SMB
checkout; result push-back; auth on the port; running Claude sessions on the
node (that is `docs/RESUME-ON-DEB.md`, unchanged).

## 7. Implementation note (2026-09-05)

Landed: `tools/deb/run.sh` (`HBC2JS_CI_HOSTS`, `DEB_CI_URL` one-host
override, `--host` pin, host picking delegated to `tools/deb/pick.mjs`'s
`pickHost(hosts, fetchJobs)`), `tools/deb/install.sh` (`MAX_PARALLEL =
nproc/2, min 1` written into the systemd unit's `Environment=`, note-only
toolchain check), `tests/gate/tools/deb-pick.test.ts` (§5 item 5, plus a
`bash -n` parse check on both scripts). `server.mjs` reused unchanged, as
scoped.

Verified: a live read-only check against the real `deb` node plus a
deliberately-unreachable second host (`HBC2JS_CI_HOSTS="http://deb.local:8787
http://127.0.0.1:1" tools/deb/run.sh --status`) — the unreachable host was
skipped with a warning, `deb.local` was chosen and its job list printed.
This exercises §3 items 1–3 and part of item 4 (unreachable-host skip) end
to end, but only with one real node.

Not verified — need a real second node, which this task explicitly does not
stand up (§2's own scope: "one box" per node, install/redeploy is a by-hand
operation against Fred's hardware, never run by an agent):
- §5 item 1 (`install.sh <node>` finishes clean on a fresh OS install).
- §5 item 2 (`GET /jobs` returns `[]` after a reboot — linger works).
- §5 item 3 (`run.sh --host <node> -- npm test` end to end against a second
  node's server, not just its `/jobs` GET).
- §5 item 4's "picks the node when it's idle and deb is saturated" half
  (the "unreachable → picks deb, one warning" half is verified above).

## 8. Implementation note (2026-09-05, load-aware picking)

Landed: `tools/deb/server.mjs` now exposes `GET /load` (score formula in
§3 item 2 above, `docs/DEB-CI.md` "Load-aware picking"), and its
toolchain/state/port locations are configurable (`HBC2JS_TOOLCHAIN_DIR`,
`HBC2JS_CI_DIR`, `PORT`) so a second instance can run on a different
machine (the Mac) without colliding with `deb`'s deployment; Node
resolution now falls back to `process.execPath` when `fnm` is absent
instead of leaving `PATH` untouched. `tools/deb/pick.mjs`'s `pickHost` is
rewritten around `{score, fallback}` (was `queued+running` count alone),
with the formula factored into an exported, separately-tested
`computeLoadScore`. `tools/deb/run.sh`'s default `HBC2JS_CI_HOSTS` now
lists two hosts (`deb.local:8787`, `127.0.0.1:8788`), and `--status` with no
id lists jobs from every candidate host, prefixed by host, instead of only
the picked one. New `tools/deb/start-local.sh` starts a `server.mjs`
instance on the current (non-`deb`) machine under `nohup` (no systemd on
macOS); it never touches `tools/deb/install.sh`'s systemd path. This
supersedes §3 item 2 and §5 item 5's "fewest queued+running jobs" wording
above with load-score picking; §7's "`server.mjs` reused unchanged" note is
now historical (true only through 2026-09-05's `run.sh`-only revision).

`tests/gate/tools/deb-pick.test.ts` was rewritten for the new
`{score, fallback}`-shaped `pickHost`/`computeLoadScore` API (fewest-queue
assertions replaced with lowest-score assertions, since the picker's
underlying metric is what this task changed by design) and extended with:
lowest score wins, queue pressure can outweigh loadavg alone, `/load`-missing
host falls back to a count and is marked `fallback: true`, all-unreachable
still throws, ties still go to list order, plus unit tests for
`computeLoadScore` itself (including the zero-`nproc`/zero-`maxParallel`
guard) and a check that `run.sh`'s default host list has more than one
entry. Not independently re-verified live against a second real node
(same constraint as §7 above — no second node stood up by this task); the
single-node and unreachable-host paths were smoke-tested by hand
(`node --check` on both `.mjs` files, `bash -n` on all three scripts, the
full gate test file).
