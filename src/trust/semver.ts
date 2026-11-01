// SemVer 2.0.0 parsing and precedence (https://semver.org/#spec-item-11), as much
// of it as pin.json's rules need. Strict: a version this can't parse throws, so a
// rule never compares a malformed version as if it were older or equal.

const IDENT = "(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)";
const VERSION = new RegExp(`^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-(${IDENT}(?:\\.${IDENT})*))?(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$`);

export interface Version {
  major: string;
  minor: string;
  patch: string;
  prerelease: string[];
  build: string;
}

/** `version`'s parts as strings, or null when it isn't SemVer (a leading "v" is allowed). */
export function parseVersion(version: unknown): Version | null {
  const match = VERSION.exec(String(version ?? ""));
  if (!match) return null;
  const [, major = "", minor = "", patch = "", pre, build = ""] = match;
  return { major, minor, patch, prerelease: pre ? pre.split(".") : [], build };
}

function mustParse(version: string): Version {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`${version} isn't a SemVer version`);
  return parsed;
}

const isNumeric = (id: string) => /^\d+$/.test(id);

/** Numeric strings without leading zeros, compared at any length. */
const compareNumbers = (a: string, b: string) => (a.length !== b.length ? (a.length < b.length ? -1 : 1) : a < b ? -1 : a > b ? 1 : 0);

function compareIdentifiers(a: string, b: string): number {
  const [x, y] = [isNumeric(a), isNumeric(b)];
  if (x && y) return compareNumbers(a, b);
  if (x !== y) return x ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Negative, zero or positive as `a` has lower, equal or higher precedence than `b`; build metadata is ignored. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [mustParse(a), mustParse(b)];
  for (const part of ["major", "minor", "patch"] as const) {
    const order = compareNumbers(x[part], y[part]);
    if (order) return order;
  }
  if (!x.prerelease.length || !y.prerelease.length) return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const [p, q] = [x.prerelease[i], y.prerelease[i]];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const order = compareIdentifiers(p, q);
    if (order) return order;
  }
  return 0;
}
