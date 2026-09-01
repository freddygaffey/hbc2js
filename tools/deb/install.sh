#!/usr/bin/env bash
# tools/deb/install.sh — deploy the hbc2js-ci job server to `deb` as a
# systemd --user service (auto-restart, survives reboot via linger).
#
# Usage (from anywhere, on the Mac or deb itself): tools/deb/install.sh [host]
# Default host: deb (ssh alias). Idempotent — safe to re-run to redeploy
# server.mjs after edits.
set -euo pipefail

HOST="${1:-deb}"
REMOTE_DIR='~/hbc2js-ci-bin'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ssh "$HOST" "mkdir -p $REMOTE_DIR ~/.config/systemd/user"
scp -q "$SCRIPT_DIR/server.mjs" "$HOST:$REMOTE_DIR/server.mjs"

ssh "$HOST" 'cat > ~/.config/systemd/user/hbc2js-ci.service' <<'UNIT'
[Unit]
Description=hbc2js deb job server

[Service]
Type=simple
Environment=PATH=%h/.local/share/fnm:%h/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/bin/bash -lc 'export PATH="$HOME/.local/share/fnm:$PATH"; exec fnm exec --using 22 -- node %h/hbc2js-ci-bin/server.mjs'
Restart=always
RestartSec=5
WorkingDirectory=%h/hbc2js-ci-bin

[Install]
WantedBy=default.target
UNIT

ssh "$HOST" '
  loginctl enable-linger "$USER" 2>/dev/null || true
  systemctl --user daemon-reload
  systemctl --user enable hbc2js-ci.service
  systemctl --user restart hbc2js-ci.service
  sleep 1
  systemctl --user --no-pager status hbc2js-ci.service | head -6
'

echo "Installed. Try: curl http://deb.local:8787/jobs"
