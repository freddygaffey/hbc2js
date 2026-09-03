// Type declaration for campaign.mjs.
import type { RnPin } from "./lib/versions.d.mts";
import type { BuildResultOk, BuildResultSkipped } from "./build.d.mts";

export interface Cell {
  readonly hbcVersion: number;
  readonly bundler: "metro-plain" | "metro-ram";
  readonly obfuscation: boolean;
}

export const CAMPAIGN_AXES: {
  readonly hbcVersion: readonly number[];
  readonly bundler: readonly string[];
  readonly obfuscation: readonly boolean[];
};

export function allCells(): Cell[];
export function cellFingerprint(cell: Cell): string;

export interface SelectedCandidate {
  readonly seed: number;
  readonly rnPin: RnPin;
  readonly bundler: "metro-plain" | "metro-ram";
  readonly obfuscate: boolean;
  readonly cellFingerprint: string;
}

export function selectSample(
  store: readonly Record<string, unknown>[],
  opts?: { readonly sampleSize?: number; readonly rngSeed?: number },
): { readonly selection: SelectedCandidate[]; readonly quotaSaturated: boolean };

export function runCampaign(opts?: {
  readonly manifestPath?: string;
  readonly sampleSize?: number;
  readonly dryRun?: boolean;
  readonly rngSeed?: number;
}):
  | { readonly dryRun: true; readonly quotaSaturated: boolean; readonly selection: SelectedCandidate[] }
  | { readonly dryRun: false; readonly quotaSaturated: boolean; readonly results: (BuildResultOk | BuildResultSkipped)[] };
