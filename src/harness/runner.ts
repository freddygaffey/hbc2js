// docs/specs/06-harness.md §1 — port of tools/equiv/src/runner.mjs. Spawns one
// sandboxed child per program and collects its NDJSON trace under a hard
// wall-clock budget.
import { spawn } from "node:child_process";
import path from "node:path";
import type { TraceRecord } from "./trace.ts";

export interface RunOptions {
  readonly seed?: number;
  readonly timeout?: number;
  /** Bounds only the synchronous portion of the run inside the child. */
  readonly syncTimeout?: number;
  readonly fuzz?: number;
  readonly relax?: readonly string[];
  readonly maxRecords?: number;
  readonly maxDepth?: number;
  readonly generatorSteps?: number;
}

export interface ProgramResult {
  readonly file: string;
  readonly records: readonly TraceRecord[];
  readonly timedOut: boolean;
  readonly stderr: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

const CHILD = path.join(import.meta.dirname, "child.ts");

export function runProgram(file: string, opts: RunOptions = {}): Promise<ProgramResult> {
  const timeout = opts.timeout ?? 5000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, path.resolve(file), JSON.stringify(opts)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const records: TraceRecord[] = [];
      for (const line of stdout.split("\n")) {
        if (line.trim() === "") continue;
        try {
          records.push(JSON.parse(line) as TraceRecord);
        } catch {
          // A partial final line is expected when we SIGKILL mid-write.
        }
      }
      if (timedOut) records.push({ k: "limit", why: "timeout" });
      else if (code !== 0 || signal !== null) records.push({ k: "limit", why: `exit:${signal ?? code}` });
      resolve({ file, records, timedOut, stderr, code, signal });
    });
  });
}
