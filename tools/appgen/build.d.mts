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
    readonly obfuscation: string;
    readonly router: string;
    readonly depStyle: string;
    readonly screens: readonly string[];
    readonly createdAt: string;
    readonly buildStatus: "ok" | "failed";
    readonly buildError: string | null;
  };
  readonly entry: Record<string, unknown>;
}

export interface RnPin {
  readonly rnVersion: string;
  readonly hbcVersion: number;
  readonly compiler: string;
  readonly note: string;
  readonly directHermescFallback?: string;
}

export function buildOne(
  seed: string | number,
  opts?: {
    readonly keepWorkspace?: boolean;
    readonly manifestPath?: string;
    readonly rnPin?: RnPin;
    readonly bundler?: "metro-plain" | "metro-ram";
    readonly obfuscate?: boolean;
    readonly directHermesc?: boolean;
  },
): BuildResultOk | BuildResultSkipped;

export function appgenDir(): string;
