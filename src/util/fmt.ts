// docs/specs/00-project-skeleton.md §2 (util/fmt.ts) — hex/offset formatting for the
// CLI (and, later, the disassembler). No locale-dependent formatting (§9.9).

export function hex(n: number, width = 0): string {
  const s = (n >>> 0).toString(16);
  return width > 0 ? s.padStart(width, "0") : s;
}

export function offset(n: number): string {
  return `0x${hex(n)}`;
}

export function colorEnabled(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env["NO_COLOR"];
}
