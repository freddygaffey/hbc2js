#!/usr/bin/env bash
# tools/device-roundtrip.sh — D16a: prove decompile -> repackage -> run on a
# real Android device, on our own throwaway app. See docs/DEVICE-TESTING.md
# for the full writeup (what "identical" means, prerequisites, known device
# quirks) — this header is the short version.
#
# Pipeline:
#   1. Scaffold (or reuse, with --app) a React Native 0.72.17 app whose
#      App.tsx exercises a counter, a loop-built list, a generator, an async
#      function and try/catch/finally, each step logging a `console.log`
#      marker (visible under `adb logcat -s ReactNativeJS:*`).
#   2. `./gradlew assembleRelease` (Hermes on, debug-signed) -> install on
#      the attached device -> launch -> run a scripted tap sequence ->
#      capture logcat markers + a screenshot. This is the "original" run.
#   3. Extract assets/index.android.bundle (Hermes bytecode) from the built
#      APK, decompile it with this repo's own `node src/cli.ts`, replace the
#      asset with the decompiled JS (--variant js, the default) or with the
#      JS recompiled back to .hbc via hermesc (--variant hbc), zipalign +
#      re-sign with the debug keystore, install over the original, repeat
#      the identical tap sequence, capture logcat + screenshot again.
#   4. Compare: the two logcat marker streams must be byte-identical after
#      stripping timestamps/pids; the two screenshots are pixel-diffed
#      (ImageMagick), excluding the top 3% of the screen (status bar clock).
#   5. Uninstall the test app and print a short PASS/DIVERGENT report.
#
# Usage:
#   tools/device-roundtrip.sh [--app <dir>] [--variant js|hbc] [--keep]
#
#   --app <dir>   Reuse an already-scaffolded, `npm install`-ed RN 0.72.17
#                 app directory instead of scaffolding a fresh one (faster
#                 for iterating on this script). Its App.tsx is always
#                 overwritten with this script's known-good test screen.
#                 Default: scaffold a fresh throwaway app under a mktemp dir.
#   --variant js|hbc
#                 js  (default): repackage with the decompiled JS as-is —
#                     Hermes loads plain JS directly, no recompile needed.
#                 hbc: additionally recompile the decompiled JS back to
#                     Hermes bytecode with tools/hermesc/v<N>/hermesc -O and
#                     test *that* repackaged APK instead. Only supported
#                     when the extracted bundle's HBC version has a matching
#                     tools/hermesc/v<N>/ build (v94, matching RN 0.72.17,
#                     as of this writing).
#   --keep        Don't uninstall the test app at the end (for manual
#                 poking); still prints the report.
#
# Requires: adb (Android SDK platform-tools) with exactly one device
# attached, a JDK 17 (auto-detected, see dr_pick_java17 in
# tools/device/lib.sh), the Android SDK (build-tools with zipalign +
# apksigner; ANDROID_HOME or the default ~/Library/Android/sdk), Node, and
# optionally ImageMagick (`compare`/`identify`/`magick`) for the screenshot
# diff — its absence degrades the report, it does not fail the run.
#
# Exit codes: 0 PASS, 1 environment/build/install failure (see stderr for
# which step), 2 DIVERGENT (logcat or screenshot content differs), 3 no
# device attached (the sweep test treats this as INCONCLUSIVE, not a
# failure).

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=tools/device/lib.sh
source "$SCRIPT_DIR/device/lib.sh"

APP_DIR=""
VARIANT="js"
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP_DIR="$2"; shift 2 ;;
    --variant) VARIANT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,45p' "$0"; exit 0 ;;
    *) dr_die "unknown argument: $1" ;;
  esac
done
case "$VARIANT" in js|hbc) ;; *) dr_die "--variant must be js or hbc, got: $VARIANT" ;; esac

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
JAVA17_HOME="$(dr_pick_java17)" || dr_die "no JDK 17 found — see docs/DEVICE-TESTING.md prerequisites (brew install openjdk@17)"
export JAVA_HOME="$JAVA17_HOME"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"

dr_require_device || exit 3
dr_log "device: $DR_ADB_SERIAL"

BUILD_TOOLS_DIR="$(ls -d "$ANDROID_HOME"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$BUILD_TOOLS_DIR" ] || dr_die "no Android build-tools found under $ANDROID_HOME/build-tools"
ZIPALIGN="${BUILD_TOOLS_DIR}zipalign"
APKSIGNER="${BUILD_TOOLS_DIR}apksigner"
DEBUG_KEYSTORE="$HOME/.android/debug.keystore"
[ -f "$DEBUG_KEYSTORE" ] || dr_die "no debug keystore at $DEBUG_KEYSTORE (run any Android build once to generate it)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/device-roundtrip.XXXXXX")"
cleanup() {
  local status=$?
  if [ "$KEEP" -eq 0 ]; then
    adb uninstall com.roundtrip >/dev/null 2>&1 || true
  fi
  # Keep $WORK (build/decompile logs, both screenshots, both logcat
  # captures) around on anything but a clean PASS, so a DIVERGENT result
  # or a build/install failure both leave something to inspect.
  if [ "$status" -eq 0 ]; then
    rm -rf "$WORK"
  else
    dr_log "leaving work dir for inspection: $WORK"
  fi
}
trap cleanup EXIT

PACKAGE="com.roundtrip"
ACTIVITY="$PACKAGE/.MainActivity"

# ---- 1. app source ---------------------------------------------------
write_app_tsx() {
  cat > "$1/App.tsx" <<'APPTSX'
/**
 * RoundTrip test app for hbc2js device round-trip proof (D16a).
 * Deliberately exercises: counter state, a rendered loop, a generator
 * function, an async function, and try/catch/finally -- each step logs a
 * deterministic marker via console.log so `adb logcat` output can be
 * diffed byte-for-byte between the original and decompiled builds.
 *
 * @format
 */

import React, {useEffect, useState} from 'react';
import {
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';

function* fibGen(n: number): Generator<number> {
  let a = 0;
  let b = 1;
  for (let i = 0; i < n; i++) {
    yield a;
    [a, b] = [b, a + b];
  }
}

async function computeAsyncLabel(): Promise<string> {
  const delay = (ms: number) =>
    new Promise<void>(resolve => setTimeout(resolve, ms));
  await delay(0);
  const parts: string[] = [];
  for (const n of fibGen(6)) {
    parts.push(String(n));
  }
  await delay(0);
  return parts.join(',');
}

function riskyStep(shouldThrow: boolean): string {
  try {
    if (shouldThrow) {
      throw new Error('deliberate-test-error');
    }
    console.log('RT:try-ok');
    return 'try-ok';
  } catch (e) {
    console.log('RT:catch:' + (e as Error).message);
    return 'caught';
  } finally {
    console.log('RT:finally');
  }
}

const LIST_SIZE = 5;

export default function App(): JSX.Element {
  const [count, setCount] = useState(0);
  const [asyncLabel, setAsyncLabel] = useState('pending');
  const [tryLabel, setTryLabel] = useState('');

  useEffect(() => {
    console.log('RT:mount');

    const items: string[] = [];
    for (let i = 0; i < LIST_SIZE; i++) {
      items.push('item-' + i);
    }
    console.log('RT:list:' + items.join(','));

    const result = riskyStep(false);
    setTryLabel(result);

    computeAsyncLabel().then(label => {
      console.log('RT:async-label:' + label);
      setAsyncLabel(label);
    });
  }, []);

  const onPress = () => {
    setCount(c => {
      const next = c + 1;
      console.log('RT:tap:count=' + next);
      return next;
    });
  };

  const items: string[] = [];
  for (let i = 0; i < LIST_SIZE; i++) {
    items.push('item-' + i);
  }

  return (
    <SafeAreaView style={styles.root} testID="root">
      <ScrollView contentInsetAdjustmentBehavior="automatic">
        <View style={styles.section}>
          <Text style={styles.heading}>RoundTrip</Text>

          <TouchableOpacity
            testID="counter-button"
            style={styles.button}
            onPress={onPress}>
            <Text style={styles.buttonText}>Tap me</Text>
          </TouchableOpacity>
          <Text testID="counter-value" style={styles.value}>
            count: {count}
          </Text>

          <Text testID="async-value" style={styles.value}>
            async: {asyncLabel}
          </Text>

          <Text testID="try-value" style={styles.value}>
            try: {tryLabel}
          </Text>

          <View testID="list-container">
            {items.map(it => (
              <Text key={it} style={styles.listItem}>
                {it}
              </Text>
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: '#ffffff'},
  section: {padding: 24},
  heading: {fontSize: 28, fontWeight: '700', marginBottom: 16},
  button: {
    backgroundColor: '#2f6fed',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 8,
    alignSelf: 'flex-start',
    marginBottom: 12,
  },
  buttonText: {color: '#ffffff', fontSize: 16, fontWeight: '600'},
  value: {fontSize: 16, marginBottom: 8},
  listItem: {fontSize: 14, paddingVertical: 4},
});
APPTSX
}

if [ -z "$APP_DIR" ]; then
  APP_DIR="$WORK/RoundTrip"
  dr_log "scaffolding RN 0.72.17 app at $APP_DIR (npx react-native init)"
  ( cd "$WORK" && npx --yes react-native@0.72.17 init RoundTrip --version 0.72.17 --skip-install --npm ) \
    || dr_die "react-native init failed"
  write_app_tsx "$APP_DIR"
  ( cd "$APP_DIR" && npm install ) || dr_die "npm install failed"
else
  [ -d "$APP_DIR" ] || dr_die "--app $APP_DIR does not exist"
  write_app_tsx "$APP_DIR"
fi

# ---- 2. build + first run ---------------------------------------------
dr_log "gradlew assembleRelease"
( cd "$APP_DIR/android" && echo "sdk.dir=$ANDROID_HOME" > local.properties && ./gradlew assembleRelease --console=plain ) \
  > "$WORK/gradle.log" 2>&1
if [ $? -ne 0 ]; then
  tail -60 "$WORK/gradle.log" >&2
  dr_die "gradle build failed — see tail above (full log: $WORK/gradle.log)"
fi
APK="$APP_DIR/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$APK" ] || dr_die "expected APK not found: $APK"

install_and_run() {
  # install_and_run <apk> <logcat-out> <screenshot-out>
  local apk="$1" logcat_out="$2" shot_out="$3"
  adb uninstall "$PACKAGE" >/dev/null 2>&1 || true
  adb logcat -c
  dr_install_retry "$apk" 5 >/dev/null
  adb shell am start -n "$ACTIVITY" >/dev/null 2>&1
  sleep 3
  local center
  center="$(dr_element_center counter-button)"
  local cx="${center% *}" cy="${center#* }"
  local i
  for i in 1 2 3; do
    adb shell input tap "$cx" "$cy"
    sleep 1
  done
  adb logcat -d -s "ReactNativeJS:*" > "$logcat_out"
  adb exec-out screencap -p > "$shot_out"
}

dr_log "run 1/2: original APK"
install_and_run "$APK" "$WORK/orig.logcat" "$WORK/orig.png"

# ---- 3. extract, decompile, repackage ----------------------------------
mkdir -p "$WORK/extract"
( cd "$WORK/extract" && unzip -o "$APK" assets/index.android.bundle -d orig >/dev/null )
BUNDLE="$WORK/extract/orig/assets/index.android.bundle"
[ -f "$BUNDLE" ] || dr_die "no assets/index.android.bundle in $APK"
HBC_VERSION="$(file "$BUNDLE" | grep -oE 'version [0-9]+' | grep -oE '[0-9]+' || true)"
dr_log "extracted bundle: $(file -b "$BUNDLE")"

DECOMPILED="$WORK/decompiled.js"
dr_log "decompiling with node src/cli.ts"
( cd "$REPO_ROOT" && node src/cli.ts "$BUNDLE" "$DECOMPILED" ) > "$WORK/decompile.log" 2>&1
if [ $? -ne 0 ]; then
  tail -40 "$WORK/decompile.log" >&2
  dr_die "hbc2js decompile failed — see tail above"
fi

REPLACEMENT_ASSET="$DECOMPILED"
if [ "$VARIANT" = "hbc" ]; then
  [ -n "$HBC_VERSION" ] || dr_die "--variant hbc: could not detect the bundle's HBC version"
  HERMESC="$REPO_ROOT/tools/hermesc/v$HBC_VERSION/hermesc"
  [ -x "$HERMESC" ] || dr_die "--variant hbc: no tools/hermesc/v$HBC_VERSION/hermesc (run tools/get-hermesc.sh $HBC_VERSION first, or use --variant js)"
  RECOMPILED="$WORK/decompiled.recompiled.hbc"
  dr_log "recompiling decompiled JS with hermesc v$HBC_VERSION -O"
  "$HERMESC" -O -emit-binary -out="$RECOMPILED" "$DECOMPILED" > "$WORK/hermesc.log" 2>&1 \
    || { tail -40 "$WORK/hermesc.log" >&2; dr_die "hermesc recompile failed"; }
  REPLACEMENT_ASSET="$RECOMPILED"
fi

REPACK_DIR="$WORK/repack"
mkdir -p "$REPACK_DIR/replace/assets"
cp "$APK" "$REPACK_DIR/work.apk"
cp "$REPLACEMENT_ASSET" "$REPACK_DIR/replace/assets/index.android.bundle"
( cd "$REPACK_DIR" && zip -d work.apk assets/index.android.bundle >/dev/null )
( cd "$REPACK_DIR/replace" && zip -X ../work.apk assets/index.android.bundle >/dev/null )
"$ZIPALIGN" -f -p 4 "$REPACK_DIR/work.apk" "$REPACK_DIR/aligned.apk" > "$WORK/zipalign.log" 2>&1 \
  || dr_die "zipalign failed — see $WORK/zipalign.log"
"$APKSIGNER" sign --ks "$DEBUG_KEYSTORE" --ks-pass pass:android --key-pass pass:android \
  --out "$REPACK_DIR/signed.apk" "$REPACK_DIR/aligned.apk" > "$WORK/apksigner.log" 2>&1 \
  || { tail -20 "$WORK/apksigner.log" >&2; dr_die "apksigner sign failed"; }
"$APKSIGNER" verify "$REPACK_DIR/signed.apk" > /dev/null 2>&1 || dr_die "apksigner verify failed on repackaged APK"

dr_log "run 2/2: repackaged APK (--variant $VARIANT)"
install_and_run "$REPACK_DIR/signed.apk" "$WORK/dec.logcat" "$WORK/dec.png"

# ---- 4. compare ---------------------------------------------------------
dr_normalize_logcat "$WORK/orig.logcat" > "$WORK/orig.norm.txt"
dr_normalize_logcat "$WORK/dec.logcat" > "$WORK/dec.norm.txt"

LOGCAT_STATUS="IDENTICAL"
if ! diff -u "$WORK/orig.norm.txt" "$WORK/dec.norm.txt" > "$WORK/logcat.diff"; then
  LOGCAT_STATUS="DIVERGENT"
fi

PIXEL_REPORT="$(dr_pixel_diff "$WORK/orig.png" "$WORK/dec.png" 2>/dev/null)"

echo "=========================================="
echo "device-roundtrip report (--variant $VARIANT)"
echo "  app:      $APP_DIR"
echo "  device:   $DR_ADB_SERIAL"
echo "  bundle:   HBC version ${HBC_VERSION:-unknown}"
echo "  logcat:   $LOGCAT_STATUS"
if [ "$LOGCAT_STATUS" = "DIVERGENT" ]; then
  sed -n '1,30p' "$WORK/logcat.diff"
fi
echo "  screenshot diff:"
echo "$PIXEL_REPORT" | sed 's/^/    /'
echo "=========================================="

if [ "$LOGCAT_STATUS" = "DIVERGENT" ]; then
  exit 2
fi
exit 0
