// tools/security/probe.ts — spec 13 (P2.4 reuse-validation) §9 step 0:
// tool-presence probes with actionable install hints, shared by every lane's
// tests/security/*.test.ts (guarded-import pattern: a lane test that needs a
// binary calls the matching probe*() and skips-with-reason, never crashes,
// when it is absent; HBC2JS_REQUIRE_ORACLES=1 turns that skip into a
// failure, the existing convention docs/AGENT-BRIEF.md names).
//
// No lane logic lives here — presence + a human-actionable install hint only.
import { execFileSync } from "node:child_process";

export interface ToolProbe {
  readonly name: string;
  readonly present: boolean;
  readonly version: string | null;
  readonly installHint: string;
}

function tryVersion(bin: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync(bin, args as string[], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim().split("\n")[0]?.trim() ?? "";
  } catch {
    return null;
  }
}

/** Semgrep OSS engine CLI (spec 13 §2, Lane S). */
export function probeSemgrep(): ToolProbe {
  const version = tryVersion("semgrep", ["--version"]);
  return {
    name: "semgrep",
    present: version !== null,
    version,
    installHint: "pipx install semgrep   (or: brew install semgrep)",
  };
}

/** osv-scanner CLI (spec 13 §3, Lane O). */
export function probeOsvScanner(): ToolProbe {
  const version = tryVersion("osv-scanner", ["--version"]);
  return {
    name: "osv-scanner",
    present: version !== null,
    version,
    installHint: "brew install osv-scanner   (or: go install github.com/google/osv-scanner/cmd/osv-scanner@latest)",
  };
}

/** androguard CLI (spec 13 §4, Lane M, primary manifest extractor). */
export function probeAndroguard(): ToolProbe {
  const version = tryVersion("androguard", ["--version"]);
  return {
    name: "androguard",
    present: version !== null,
    version,
    installHint: "pipx install androguard",
  };
}

/** apktool CLI (spec 13 §4, Lane M, cross-check/fallback decoder). */
export function probeApktool(): ToolProbe {
  const version = tryVersion("apktool", ["--version"]);
  return {
    name: "apktool",
    present: version !== null,
    version,
    installHint: "brew install apktool",
  };
}

/** aapt2 (spec 13 §4.3, Lane M ground truth for the validation protocol). */
export function probeAapt2(): ToolProbe {
  // aapt2 has no plain --version that reliably exits 0 across builds; treat
  // any output (including its usage banner on argument error) as "present".
  const version = tryVersion("aapt2", ["version"]);
  return {
    name: "aapt2",
    present: version !== null,
    version,
    installHint:
      "install the Android SDK build-tools (e.g. via Android Studio's SDK Manager) and add build-tools/<ver>/aapt2 to PATH",
  };
}

/** All lane tools in one call, for a combined presence report (e.g. a CLI probe command). */
export function probeAll(): readonly ToolProbe[] {
  return [probeSemgrep(), probeOsvScanner(), probeAndroguard(), probeApktool(), probeAapt2()];
}

// Allow `node tools/security/probe.ts` (or ts-node equivalent) as a quick
// human-facing presence report with install hints.
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const p of probeAll()) {
    console.log(`${p.present ? "OK  " : "MISS"} ${p.name}${p.version ? ` (${p.version})` : ""}`);
    if (!p.present) console.log(`     install: ${p.installHint}`);
  }
}
