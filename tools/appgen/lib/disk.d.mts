// Type declaration for `disk.mjs` — see generate.d.mts's header comment.
export const MIN_FREE_BYTES: number;
export function freeBytes(path: string): number;
export function preflightDiskCheck(path: string, opts?: { readonly minFreeBytes?: number }): number;
