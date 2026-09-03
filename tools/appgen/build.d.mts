// Type declaration for `build.mjs` — see generate.d.mts's header comment.
export interface BuildResultSkipped {
  readonly skipped: true;
  readonly reason: string;
  readonly fingerprint: string;
}

export interface BuildResultOk {
  readonly skipped: false;
  readonly id: string;
  readonly destDir: string;
  readonly config: {
    readonly id: string;
    readonly seed: string;
    readonly fingerprint: string;
    readonly rnVersion: string;
    readonly hbcVersion: number;
    readonly bundler: string;
    readonly compiler: string;
    readonly router: string;
    readonly depStyle: string;
    readonly screens: readonly string[];
    readonly createdAt: string;
  };
  readonly entry: Record<string, unknown>;
}

export function buildOne(
  seed: string | number,
  opts?: { readonly keepWorkspace?: boolean; readonly manifestPath?: string },
): BuildResultOk | BuildResultSkipped;

export function appgenDir(): string;
