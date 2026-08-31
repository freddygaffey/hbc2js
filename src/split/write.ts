// src/split/write.ts — write a `SplitResult` (src/split/index.ts) to disk.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SplitResult } from "./index.ts";

export function writeSplitResult(result: SplitResult, outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, content] of result.files) {
    writeFileSync(join(outDir, name), content);
  }
}
