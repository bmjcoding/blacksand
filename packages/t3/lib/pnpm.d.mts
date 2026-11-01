// Types for the parts of pnpm.mjs the TypeScript reads (src/platform/shared.ts: which pnpm a machine has).

/** The pnpm version builds use. */
export const PNPM_VERSION: string;

/** SHA-256 of the pinned pnpm's binary, per platform (darwin-arm64, …). */
export const PNPM_BINARY_SHA256: { readonly [platform: string]: string };

/** Where root's build tools live on `platform` (process.platform's names). */
export function buildToolsRoot(platform?: string): string;

/** Why `at`'s access control list could let anyone but root change it, or null. `run` is how it runs Apple's /bin/ls (spawnSync's shape). */
export function aclProblem(at: string, options?: { platform?: string; run?: (file: string, args: readonly string[], options: { encoding: "utf8"; timeout: number }) => { status: number | null; stdout: string | Buffer } }): string | null;
