// Type declaration for lib/versions.mjs.
export interface RnPin {
  readonly rnVersion: string;
  readonly hbcVersion: number;
  readonly compiler: string;
  readonly note: string;
  readonly directHermescFallback?: string;
}

export function hermescPathForRn(rnVersion: string): (workspace: string, osdir: string) => string;

export const RN_PINS: Readonly<Record<number, RnPin>>;
export const DEFAULT_RN_PIN: RnPin;
