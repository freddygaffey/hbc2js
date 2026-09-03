// Type declaration for `manifest.mjs` — see generate.d.mts's header comment.
export interface ManifestStoreEntry {
  readonly id?: string;
  readonly fingerprint: string;
  readonly [k: string]: unknown;
}

export function fingerprint(manifest: {
  readonly routerShape: string;
  readonly depStyle: string;
  readonly screens: readonly string[];
}): string;

export function isDuplicate(store: readonly ManifestStoreEntry[], fp: string): boolean;

export function loadStore(
  path: string,
  fs: { readonly existsSync: (p: string) => boolean; readonly readFileSync: (p: string, enc?: string) => string },
): ManifestStoreEntry[];

export function saveStore(
  path: string,
  fs: { readonly writeFileSync: (p: string, content: string) => void },
  store: readonly ManifestStoreEntry[],
): void;
