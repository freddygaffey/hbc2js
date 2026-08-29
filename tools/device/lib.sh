#!/usr/bin/env bash
# tools/device/lib.sh — shared shell helpers for tools/device-roundtrip.sh and
# tests/sweep/device/*. Not a standalone script: `source` it.
#
# Covers the device-specific fiddliness discovered while building the D16a
# round-trip proof (see docs/DEVICE-TESTING.md): the tablet used for that
# proof intermittently rejects the first `adb install` of a given APK with
# `INSTALL_FAILED_VERIFICATION_FAILURE` (Android's install-time verifier /
# Play Protect) and succeeds on a bare retry with `--no-streaming`; there is
# no reliable way to detect from the host side whether a retry will need a
# one-off human tap on the device, so callers just get clear log lines and a
# bounded retry loop, never a silent hang.

dr_log() { echo "[device-roundtrip] $*" >&2; }
dr_die() { echo "[device-roundtrip] ERROR: $*" >&2; exit 1; }

# dr_require_device — populates $DR_ADB_SERIAL with the sole attached
# device's serial, or returns 1 (never exits) if adb is missing, no device
# is attached, or more than one is (ambiguous — pass one explicitly by
# exporting ANDROID_SERIAL yourself and re-running).
dr_require_device() {
  command -v adb >/dev/null 2>&1 || { dr_log "adb not on PATH"; return 1; }
  local lines
  lines="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
  local n
  n="$(echo -n "$lines" | grep -c . || true)"
  if [ -z "$lines" ] || [ "$n" -eq 0 ]; then
    dr_log "no device attached (\`adb devices\` shows none in \"device\" state)"
    return 1
  fi
  if [ "$n" -gt 1 ] && [ -z "${ANDROID_SERIAL:-}" ]; then
    dr_log "multiple devices attached; export ANDROID_SERIAL to pick one:"
    dr_log "$lines"
    return 1
  fi
  DR_ADB_SERIAL="${ANDROID_SERIAL:-$lines}"
  export ANDROID_SERIAL="$DR_ADB_SERIAL"
  return 0
}

# dr_pick_java17 — echoes a JDK 17 java home on stdout, or returns 1.
# Prefers Homebrew's user-space openjdk@17 keg (no sudo needed) since the
# RN 0.72 template's Gradle 8.0.1 wrapper cannot run under JDK 21+, then
# falls back to /usr/libexec/java_home -v 17 (macOS) if present.
dr_pick_java17() {
  local candidate
  for candidate in \
    "/opt/homebrew/opt/openjdk@17" \
    "/usr/local/opt/openjdk@17"
  do
    if [ -x "$candidate/bin/java" ]; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v /usr/libexec/java_home >/dev/null 2>&1; then
    local h
    h="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
    if [ -n "$h" ]; then
      echo "$h"
      return 0
    fi
  fi
  return 1
}

# dr_install_retry <apk> <max-tries> — `adb install --no-streaming -r`, with
# retries. The tablet used to validate this script needs a bare retry after
# an INSTALL_FAILED_VERIFICATION_FAILURE about half the time (the device's
# install-verifier races the push); occasionally it also shows an on-device
# "Play Protect: unsafe app blocked" dialog that only a human can dismiss —
# this function cannot click that, so after exhausting retries it fails with
# a message telling the operator what to look for on the device screen.
dr_install_retry() {
  local apk="$1" tries="${2:-5}"
  local i out
  for i in $(seq 1 "$tries"); do
    out="$(adb install --no-streaming -r "$apk" 2>&1)" && { echo "$out" | tail -1; return 0; }
    dr_log "install attempt $i/$tries failed: $(echo "$out" | tail -1)"
    sleep 2
  done
  dr_die "install failed after $tries attempts — check the device screen for a Play Protect \"unsafe app blocked\" dialog that needs a manual tap+password (see docs/DEVICE-TESTING.md), then re-run"
}

# dr_element_center <resource-id> — dumps the UI hierarchy and echoes
# "<x> <y>" for the center of the first node with that resource-id. Used
# instead of a hardcoded pixel coordinate so the interaction sequence isn't
# tied to one device's resolution.
dr_element_center() {
  local rid="$1" dump=/data/local/tmp/dr_dump.xml
  adb shell uiautomator dump "$dump" >/dev/null 2>&1
  local xml
  xml="$(adb shell cat "$dump" 2>/dev/null)"
  # Pull the bounds="[x1,y1][x2,y2]" attribute of the node whose
  # resource-id ends with the requested id (RN sets it from testID).
  # The first grep's [^/]* is greedy (POSIX ERE has no lazy quantifier) and
  # can span past the target node's own bounds="..." into later nodes'
  # attributes before backtracking to the last "bounds=" it can still match
  # — so the captured span can contain more than one bounds="[..][..]"
  # substring. The node's own bounds is always the *first* one in that span
  # (nothing after it can reorder earlier), so `head -1` again below picks
  # it correctly regardless of how far the greedy match overshot.
  local bounds
  bounds="$(echo "$xml" | grep -o "resource-id=\"[^\"]*$rid\"[^/]*bounds=\"\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]\"" | head -1 | grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | head -1)"
  [ -n "$bounds" ] || { dr_die "could not find UI element resource-id=$rid (is the app in the foreground and idle?)"; }
  local x1 y1 x2 y2
  x1="$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\1/')"
  y1="$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\2/')"
  x2="$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\3/')"
  y2="$(echo "$bounds" | sed -E 's/\[([0-9]+),([0-9]+)\]\[([0-9]+),([0-9]+)\]/\4/')"
  echo "$(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))"
}

# dr_normalize_logcat <file> — strips the "MM-DD HH:MM:SS.mmm PID TID I
# ReactNativeJS: " prefix (and the buffer-start banner line) so two runs on
# different processes/timestamps compare on message content alone.
dr_normalize_logcat() {
  sed -E 's/^-+ beginning of main$//; s/^[0-9-]+ [0-9:.]+ +[0-9]+ +[0-9]+ I ReactNativeJS: //' "$1" | sed '/^$/d'
}

# dr_pixel_diff <img1> <img2> <out-prefix> — requires ImageMagick's
# `compare`/`identify`. Reports the RMSE-normalized distortion (0..1, printed
# as a percentage) over (a) the full screenshot and (b) the screenshot with
# its top 3% cropped off, which on every device tested is comfortably taller
# than the status bar (clock/battery/notification icons — the one part of
# the screen this task expects to legitimately differ between runs taken a
# few seconds apart). Prints two lines: "full <pct>" and "content <pct>".
dr_pixel_diff() {
  local a="$1" b="$2"
  command -v compare >/dev/null 2>&1 || { dr_log "ImageMagick 'compare' not found — skipping pixel diff"; echo "full SKIPPED"; echo "content SKIPPED"; return 0; }
  local dims h w crop_h
  dims="$(identify -format '%w %h' "$a")"
  w="${dims% *}"; h="${dims#* }"
  crop_h=$(( h - (h * 3 / 100) ))
  local full_rmse content_rmse
  full_rmse="$(compare -metric RMSE "$a" "$b" null: 2>&1 | grep -oE '\([0-9.e-]+\)' | tr -d '()')"
  local tmp_a tmp_b
  tmp_a="$(mktemp /tmp/dr_crop_a_XXXX.png)"; tmp_b="$(mktemp /tmp/dr_crop_b_XXXX.png)"
  magick "$a" -crop "${w}x${crop_h}+0+$((h - crop_h))" +repage "$tmp_a"
  magick "$b" -crop "${w}x${crop_h}+0+$((h - crop_h))" +repage "$tmp_b"
  content_rmse="$(compare -metric RMSE "$tmp_a" "$tmp_b" null: 2>&1 | grep -oE '\([0-9.e-]+\)' | tr -d '()')"
  rm -f "$tmp_a" "$tmp_b"
  awk -v v="$full_rmse" 'BEGIN{printf "full %.4f%%\n", v*100}'
  awk -v v="$content_rmse" 'BEGIN{printf "content %.4f%%\n", v*100}'
}
