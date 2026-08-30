// docs/specs/03-cfg.md §2 — public API. `analyseModule` is the M4 entry point:
// it owns the memoised per-function CFG cache and the two whole-module analyses
// (environment graph, generator classification), because both are inherently
// cross-function (§1).
import { ErrorCode, Hbc2jsError } from "../errors.ts";
import type { Diagnostic } from "../errors.ts";
import { decodeFunction } from "../disasm/decode.ts";
import type { DecodedFunction } from "../disasm/decode.ts";
import type { HbcModule } from "../parse/types.ts";
import { buildBlocks, computeLeaders, computePreds } from "./blocks.ts";
import { computeDominators } from "./dom.ts";
import { carveRegions } from "./exceptions.ts";
import { addResumeDispatch, classifyFunctions, findGeneratorOps, findSuspendPoints } from "./generators.ts";
import { assertResolved, buildEnvGraph } from "./env-graph.ts";
import { checkCfgInvariants } from "./invariants.ts";
import type { AnalysisOptions, BasicBlock, BlockId, EnvGraph, FunctionCfg, FunctionKindInfo, GeneratorShape, ModuleAnalysis } from "./types.ts";

export * from "./types.ts";
export { classifyFunctions } from "./generators.ts";
export { buildEnvGraph } from "./env-graph.ts";
export { checkCfgInvariants } from "./invariants.ts";
export { writtenRegisters } from "./reg-effects.ts";

const DEFAULT_MAX_BLOCKS = 200_000;

export interface BuildCfgContext {
  readonly kind: FunctionKindInfo;
  readonly maxBlocks: number;
  readonly checkInvariants: boolean;
  readonly disableResumeDispatch: boolean;
}

/** §4 — one function's CFG. */
export function buildCfg(fn: DecodedFunction, ctx: BuildCfgContext): FunctionCfg {
  const f = fn.index;
  const size = fn.header.bytecodeSizeInBytes;
  const diagnostics: Diagnostic[] = [...fn.diagnostics];

  const leaders = computeLeaders(fn.instructions, fn.handlers, size, fn.byOffset);
  if (leaders.length > ctx.maxBlocks) {
    throw new Hbc2jsError(ErrorCode.E_TOO_COMPLEX, `function ${f} has ${leaders.length} basic blocks, above maxBlocks=${ctx.maxBlocks}`, { functionIndex: f, section: "cfg" });
  }

  const { blocks, byOffset } = buildBlocks(fn.instructions, leaders, size, f, fn.handlers);

  const carved = carveRegions(fn.handlers, blocks, byOffset, size, f);
  diagnostics.push(...carved.diagnostics);

  // §3.4 / §4.5 — generator shape and the synthetic resume dispatcher.
  const isOpcodeGenBody = ctx.kind.era === "opcode" && fn.instructions[0]?.name === "StartGenerator";
  const suspendPoints = isOpcodeGenBody ? findSuspendPoints(fn, byOffset) : [];
  let entry: BlockId = blocks.length > 0 ? 0 : 0;
  let resumeDispatch: BlockId | null = null;
  if (isOpcodeGenBody && suspendPoints.length > 0 && !ctx.disableResumeDispatch) {
    resumeDispatch = addResumeDispatch(blocks, 0, suspendPoints);
    entry = resumeDispatch;
  }

  computePreds(blocks);

  const { rpo, dom, reducible } = computeDominators(blocks, entry, f);

  const exits: BlockId[] = blocks.filter((b) => b.terminator.kind === "return" || b.terminator.kind === "throw" || b.terminator.kind === "unreachable").map((b) => b.id);

  const generator: GeneratorShape = {
    info: ctx.kind,
    resumeDispatch,
    suspendPoints,
    generatorOps: isOpcodeGenBody || ctx.kind.era === "opcode" ? findGeneratorOps(fn) : [],
  };

  const cfg: FunctionCfg = {
    functionIndex: f,
    blocks,
    entry,
    exits,
    byOffset,
    exceptionSuccs: carved.exceptionSuccs,
    regions: carved.regions,
    switchTables: fn.switchTables,
    dom,
    rpo,
    reducible,
    generator,
    frameSize: fn.header.frameSize,
    paramCount: fn.header.paramCount,
    diagnostics,
  };

  if (ctx.checkInvariants) diagnostics.push(...checkCfgInvariants(cfg, fn));
  return cfg;
}

export function analyseModule(mod: HbcModule, opts: AnalysisOptions = {}): ModuleAnalysis {
  const strictEnv = opts.strictEnv ?? true;
  const maxBlocks = opts.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const checkInvariants = opts.checkInvariants ?? true;
  const disableResumeDispatch = opts.disableResumeDispatch ?? false;
  const diagnostics: Diagnostic[] = [];

  const decodeCache = new Map<number, DecodedFunction>();
  const decoded = (i: number): DecodedFunction => {
    const hit = decodeCache.get(i);
    if (hit !== undefined) return hit;
    const fn = decodeFunction(mod, i);
    decodeCache.set(i, fn);
    return fn;
  };

  const indices: number[] = [];
  for (let i = 0; i < mod.functions.length; i++) {
    try {
      decoded(i);
      indices.push(i);
    } catch (e) {
      if (e instanceof Hbc2jsError) throw e;
      throw e;
    }
  }

  const kinds = classifyFunctions(mod, decoded);

  const cfgCache = new Map<number, FunctionCfg>();
  const cfg = (i: number): FunctionCfg => {
    const hit = cfgCache.get(i);
    if (hit !== undefined) return hit;
    const built = buildCfg(decoded(i), { kind: kinds[i]!, maxBlocks, checkInvariants, disableResumeDispatch });
    cfgCache.set(i, built);
    return built;
  };

  let envGraph: EnvGraph | null = null;
  const graph = (): EnvGraph => {
    if (envGraph === null) {
      envGraph = buildEnvGraph({ module: mod, decode: decoded, cfg, functionIndices: indices });
      diagnostics.push(...envGraph.diagnostics);
      if (strictEnv) assertResolved(envGraph);
      // CFG-16 — every function reachable via closures has a closureEnvOf entry.
      for (const i of indices) {
        if (i === mod.header.globalCodeIndex) continue;
        if (!envGraph.closureEnvOf.has(i)) {
          diagnostics.push({ severity: "warn", code: "W_ORPHAN_FUNCTION", message: `function ${i} has no known closure creation site`, context: { functionIndex: i } });
        }
      }
    }
    return envGraph;
  };

  return {
    module: mod,
    get envGraph(): EnvGraph {
      return graph();
    },
    kinds,
    cfg,
    decoded,
    options: { strictEnv, maxBlocks, checkInvariants },
    diagnostics,
  };
}

/** All blocks of `cfg`, ordered for deterministic output. */
export function blocksInRpo(cfg: FunctionCfg): readonly BasicBlock[] {
  return cfg.rpo.map((id) => cfg.blocks[id]!);
}
