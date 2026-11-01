// Types for semver.mjs, for the TypeScript that imports it (src/core/machine.ts: tool version ranges).

export interface Version {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  build: string;
}

export function parseVersion(version: unknown): Version | null;
export function compareVersions(a: string, b: string): number;
export function lineOf(version: string): string;
export function lineFloor(version: string): string;
/** Throws on a range npm wouldn't accept. */
export function parseRange(range: unknown): Array<Array<[string, string]>>;
export function satisfies(version: string, range: string): boolean;
export function inRange(version: string, range: string): boolean;
