// docs/specs/04-structurer.md §8 T2 — a canonical text rendering of the tree,
// one node per line, for reviewable golden diffs and for `hbc2js --emit-tree`.
// Labels are normalised to L0..Ln in first-appearance order so the text is
// stable against label-allocation changes.
import type { Stmt, StructuredFunction } from "./ir.ts";

export function printTree(fn: StructuredFunction): string {
  const rename = new Map<number, number>();
  const label = (id: number): string => {
    let n = rename.get(id);
    if (n === undefined) {
      n = rename.size;
      rename.set(id, n);
    }
    return `L${n}`;
  };

  const lines: string[] = [];
  const emit = (node: Stmt, indent: number): void => {
    const pad = "  ".repeat(indent);
    switch (node.k) {
      case "block":
        lines.push(`${pad}block b${node.cfgBlock}`);
        return;
      case "seq":
        for (const c of node.body) emit(c, indent);
        return;
      case "labeled":
        lines.push(`${pad}${label(node.label)}: {`);
        emit(node.body, indent + 1);
        lines.push(`${pad}}`);
        return;
      case "loop":
        lines.push(`${pad}${label(node.label)}: loop {`);
        emit(node.body, indent + 1);
        lines.push(`${pad}}`);
        return;
      case "if":
        lines.push(`${pad}if b${node.cfgBlock} {`);
        emit(node.then, indent + 1);
        lines.push(`${pad}} else {`);
        emit(node.else, indent + 1);
        lines.push(`${pad}}`);
        return;
      case "break":
        lines.push(`${pad}break ${label(node.label)}`);
        return;
      case "continue":
        lines.push(`${pad}continue ${label(node.label)}`);
        return;
      case "return":
        lines.push(`${pad}return b${node.cfgBlock}`);
        return;
      case "throw":
        lines.push(`${pad}throw b${node.cfgBlock}`);
        return;
      case "unreachable":
        lines.push(`${pad}unreachable`);
        return;
      case "setState":
        lines.push(`${pad}state${node.variable.id} = b${node.value}`);
        return;
      case "switch":
        lines.push(`${pad}switch b${node.cfgBlock} (${node.scrutinee.t}) {`);
        for (const c of node.cases) {
          lines.push(`${pad}  case ${c.isString ? `s${c.value}` : c.value}:`);
          emit(c.body, indent + 2);
        }
        lines.push(`${pad}  default:`);
        emit(node.default, indent + 2);
        lines.push(`${pad}}`);
        return;
      case "try":
        lines.push(`${pad}try r${node.region} (head b${node.cfgBlock}) {`);
        emit(node.body, indent + 1);
        lines.push(`${pad}} catch r${node.catchRegister} {`);
        emit(node.handler, indent + 1);
        lines.push(`${pad}}`);
        return;
    }
  };
  emit(fn.root, 0);
  return lines.join("\n") + "\n";
}
