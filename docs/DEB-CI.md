# `deb` job server — running heavy commands off the Mac

`deb` (Linux, x86_64, 32 cores, 31 GB RAM) runs a tiny HTTP job server
(`tools/deb/server.mjs`) so agents and the orchestrator can run `npm test`,
`npm run test:sweep`, tier-1 corpus sweeps, and bulk jobs with **one tool
call** and a short (`≤40`-line) result, instead of tying up a local shell for
minutes.

LAN-only, no auth: `deb` is on the same LAN as the Mac (`deb.local` /
`10.99.0.1`), owned by the same person, so the server binds to `0.0.0.0:8787`
with no auth. Do not expose this port outside the LAN.

## Install / redeploy

```
tools/deb/install.sh            # deploys to host "deb" (ssh alias) by default
tools/deb/install.sh deb.local  # or any other ssh-reachable host
```

This copies `server.mjs` to `~/hbc2js-ci-bin/` on the target, writes a
`systemd --user` unit (`hbc2js-ci.service`, `Restart=always`) with
`MAX_PARALLEL` set to `nproc/2` (min 1) computed on the target node itself
(deb's own unit keeps the same value it always had, since deb has 32 cores;
a second, smaller node gets its own value automatically — see
`docs/specs/24-compute-node.md` §2), enables lingering (so the service
survives logout/reboot) and (re)starts it. Also checks (warn-only, never
fails the install) that `~/hbc2js-dev/tools/{hermesc,hermes-vm}` exist on the
target — without them, oracle-dependent tests just skip on that node
(`docs/TOOLCHAIN.md`). Re-run after editing `server.mjs` to redeploy. Note:
`install.sh` is generalised to any Debian/Ubuntu host reachable over SSH, but
is only ever run by hand against a named node — never invoked by an agent or
by this repo's own tests/CI.

## Use

```
tools/deb/run.sh -- npm test                       # push current branch, run, poll, print tail
tools/deb/run.sh --sha <sha> --timeout 15 -- npm run test:sweep
tools/deb/run.sh --keep -- npm run test:all         # keep the worktree afterwards for inspection
tools/deb/run.sh --status                           # list recent jobs
tools/deb/run.sh --status <id>                      # one job's status + tail
tools/deb/run.sh --log <id>                         # full log
tools/deb/run.sh --host http://deb.local:8787 -- npm test   # pin a host, skip the pick
```

`run.sh` with no `--sha` pushes the current local branch to `origin` first
(`git push -q origin HEAD`) so the server can fetch it by name — this is the
repo owner's own remote, so this is an ordinary, allowed push. Pass `--sha
<commit>` to skip the push and run an already-pushed commit (works for any
SHA reachable on GitHub, since the repo is public).

Exit code of `run.sh` is the job's exit code (or 1 if the job errored before
running the command).

### Multi-node host picking (docs/specs/24-compute-node.md §3)

`HBC2JS_CI_HOSTS` is a space-separated list of candidate compute-node URLs
(default `http://deb.local:8787`, same as before this spec landed).
`DEB_CI_URL` still works as a one-host override, for a single-node setup.
`--host <url>` pins a host outright and skips picking.

With more than one candidate host, `run.sh` polls each host's `GET /jobs`
(2 s timeout each, via `tools/deb/pick.mjs`) before every POST, skips any
host that doesn't answer in time, and picks the reachable host with the
fewest `queued + running` jobs (ties go to list order). The chosen host —
and any skipped, unreachable host — is printed on stderr. If every
candidate is unreachable, `run.sh` exits non-zero with one clear line. With
a single candidate host (the default case today), no picking happens; the
one host is used directly, same as before this spec.

`tools/deb/pick.mjs` exports a pure `pickHost(hosts, fetchJobs)` (an
injectable fetcher takes a host URL and resolves with its `/jobs` array) so
the picking logic is unit-tested without a network in
`tests/gate/tools/deb-pick.test.ts`; the file also has a CLI entry that
`run.sh` shells out to with the real `fetch`.

### Raw HTTP (if you need it directly)

```
curl -s -X POST http://deb.local:8787/jobs -H 'content-type: application/json' \
  -d '{"ref":"main","cmd":"npm test","timeoutMin":15}'
curl -s http://deb.local:8787/jobs/<id>
curl -s http://deb.local:8787/jobs/<id>/log
curl -s http://deb.local:8787/jobs
```

## What a job does

1. `git fetch origin +<ref>:refs/heads/<ref>` into a shared bare mirror at
   `~/hbc2js-ci/mirror.git` (created once, reused).
2. `git worktree add --detach ~/hbc2js-ci/jobs/<id> <sha>`.
3. Symlinks `tools/hermesc` and `tools/hermes-vm` from `~/hbc2js-dev/tools/`
   into the job worktree if present there (both are gitignored, so a fresh
   worktree never has them — this reuses the toolchain already fetched on
   `deb` instead of rebuilding per job; see `docs/TOOLCHAIN.md`). If absent,
   any test that needs an oracle skips (`HBC2JS_REQUIRE_ORACLES=1` would
   turn that into a failure — the current `deb` job server does not set it).
4. `npm ci`, cached by `package-lock.json` hash: the resulting
   `node_modules` is moved into `~/hbc2js-ci/nm-cache/<hash>/` once and
   symlinked back for every job sharing that lockfile, so repeat runs skip
   the install.
5. Runs `cmd` via `bash -lc` with `PATH` pointed at a Node 22 resolved once
   at server startup via `fnm exec --using 22`, under `timeoutMin` (default
   30; SIGKILL on timeout).
6. stdout+stderr go to `~/hbc2js-ci/logs/<id>.log`; job metadata (status,
   exit code, duration, ref, sha, cmd) is written to
   `~/hbc2js-ci/meta/<id>.json` after every state change, so a server
   restart doesn't lose history (an in-flight job found on startup is marked
   `done` with `exitCode: -1` — it is not resumed).
7. The worktree is removed (`git worktree remove --force`) unless the
   request set `"keep": true`.

Jobs run FIFO with `MAX_PARALLEL` (default 4, override via the `MAX_PARALLEL`
env var in the systemd unit) concurrent slots; extra jobs queue.

## Restart / logs / disk

```
ssh deb systemctl --user restart hbc2js-ci.service
ssh deb systemctl --user status hbc2js-ci.service
ssh deb journalctl --user -u hbc2js-ci.service -n 100
```

Server-side state lives under `~/hbc2js-ci/{mirror.git,jobs,logs,meta,nm-cache}`.
Logs and metadata older than `LOG_RETENTION_DAYS` (default 14) are pruned on
server startup. `nm-cache/` is not size-bounded — if disk pressure shows up
(deb was already at 92%/`~74 GB free` when this was written), clear it by
hand: `rm -rf ~/hbc2js-ci/nm-cache/*` (next job just reinstalls). Any job with
`"keep": true` leaves its worktree in `~/hbc2js-ci/jobs/<id>/` — clean those
up manually (`git worktree remove`) once you're done inspecting them.

## Limits / known gaps

- No auth — LAN-only by design (see above).
- `ref` must be a branch name (or a SHA GitHub already has, since the repo
  is public) fetchable from `origin`; the server never pushes anywhere.
- `--sha` support depends on GitHub allowing fetch-by-SHA for public repos;
  it does not work against a private fork.
- Hermes VMs on `deb` currently cover fewer versions than hermesc (see
  `docs/TOOLCHAIN.md`); jobs needing a missing oracle skip those cases, they
  don't fail, unless the job's `cmd` itself sets
  `HBC2JS_REQUIRE_ORACLES=1`.
- No `--profile` flag yet (queued as follow-up; today, wrap the job's `cmd`
  in whatever profiler you need, e.g. `node --prof ...`, and fetch results
  via `--keep` + inspecting the worktree over ssh).
- Self-hosted GitHub Actions runner and a second worker (Windows laptop) are
  future work per `docs/QUEUE.md` item 5, not part of this server.
