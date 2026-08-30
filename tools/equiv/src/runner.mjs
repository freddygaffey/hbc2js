// Spawns one sandboxed child per program and collects its NDJSON trace under a
// hard wall-clock budget.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHILD = path.join(HERE, 'child.mjs');

export function runProgram(file, opts = {}) {
  const timeout = opts.timeout ?? 5000;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD, path.resolve(file), JSON.stringify(opts)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);

    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const records = [];
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          records.push(JSON.parse(line));
        } catch {
          // A partial final line is expected when we SIGKILL mid-write.
        }
      }
      if (timedOut) records.push({ k: 'limit', why: 'timeout' });
      else if (code !== 0 || signal) records.push({ k: 'limit', why: `exit:${signal || code}` });
      resolve({ file, records, timedOut, stderr, code, signal });
    });
  });
}
