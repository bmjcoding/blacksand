// Injected by blacksand as @t3tools/provider-core/server/blacksandReleaseAge.
// Provider updates and ACP Registry installs take only releases at least
// MIN_RELEASE_AGE_DAYS old, the age the build pipeline requires of every
// dependency (lib/gates.mjs), so a hijacked release has time to be caught and
// pulled before anything here installs it.
//
// The automatic provider version checks (npm's registry) are kept on purpose:
// an accepted exception to stripping outbound calls, because the owner updates
// providers with Update all. They report only a release at least
// MIN_RELEASE_AGE_DAYS old by npm's publish time, picked the way npm picks it
// (newestSettledVersion), so the app never offers a release an install would
// refuse. A native Claude Code install also asks its own release channel
// (downloads.claude.ai). Its version is only a ceiling: the install is offered
// the newest npm release at or below it that npm's own publish time shows is
// MIN_RELEASE_AGE_DAYS old (newestSettledVersion's ceiling). Native and npm
// releases share version numbers. Muse's channel publishes no release dates, so
// Muse's check asks nothing (rule provider/muse-version-check-off).
//
// A native Grok install asks Grok's own release channel (x.ai/cli/stable), which
// names one version and no date. Its age counts from when this server first saw
// that version there (firstSeenChannelVersion): a version this server saw 3 days
// ago is at least 3 days old. That holds only because Grok's updater installs
// the exact version it's given; it's never paired with an updater that takes
// whatever the channel names when it runs.
//
// Every one-click update installs exactly the version the check offered
// (exactUpdateAction, and maintenanceResolver.ts for npm and pnpm), or nothing;
// an updater that can't is left to the user, with its command and why
// (onlyExactUpdates).

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { ProviderMaintenanceCapabilities, ProviderMaintenanceCommandAction } from "./maintenance.ts";

export const MIN_RELEASE_AGE_DAYS = 3;
/** For pnpm's minimum-release-age, which is in minutes. */
export const MIN_RELEASE_AGE_MINUTES = MIN_RELEASE_AGE_DAYS * 24 * 60;

/** The newest publish time an install accepts (npm --before, uv --exclude-newer): RFC 3339, whole seconds. */
export function releaseAgeCutoff(now: number = Date.now()): string {
  return new Date(now - MIN_RELEASE_AGE_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// SemVer as npm's semver package reads it (strict mode, https://semver.org):
// hyphens inside prerelease identifiers, build metadata (ignored in
// precedence), an optional leading "v", 256 characters at most. Its patterns
// are node-semver's own, with the same repetition bounds.

const bounded = (source: string) =>
  source
    .replaceAll("\\s*", "\\s{0,1}")
    .replaceAll("\\s+", "\\s{1,1}")
    .replaceAll("\\d*", "\\d{0,256}")
    .replaceAll("\\d+", "\\d{1,256}")
    .replaceAll("[a-zA-Z0-9-]*", "[a-zA-Z0-9-]{0,250}")
    .replaceAll("[a-zA-Z0-9-]+", "[a-zA-Z0-9-]{1,250}");
const pattern = (source: string, flags?: string) => new RegExp(bounded(source), flags);

const NUM = "0|[1-9]\\d*";
const NUM_LOOSE = "\\d+";
const WORD = "\\d*[a-zA-Z-][a-zA-Z0-9-]*";
const PRE_ID = `(?:${WORD}|${NUM})`;
const PRE_ID_LOOSE = `(?:${WORD}|${NUM_LOOSE})`;
const PRERELEASE = `(?:-(${PRE_ID}(?:\\.${PRE_ID})*))`;
const PRERELEASE_LOOSE = `(?:-?(${PRE_ID_LOOSE}(?:\\.${PRE_ID_LOOSE})*))`;
const BUILD = "(?:\\+([a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*))";
const FULL_PLAIN = `v?(${NUM})\\.(${NUM})\\.(${NUM})${PRERELEASE}?${BUILD}?`;
const LOOSE_PLAIN = `[v=\\s]*(${NUM_LOOSE})\\.(${NUM_LOOSE})\\.(${NUM_LOOSE})${PRERELEASE_LOOSE}?${BUILD}?`;
const GTLT = "((?:<|>)?=?)";
const X_ID = `${NUM}|x|X|\\*`;
const X_PLAIN = `[v=\\s]*(${X_ID})(?:\\.(${X_ID})(?:\\.(${X_ID})(?:${PRERELEASE})?${BUILD}?)?)?`;

const FULL = pattern(`^${FULL_PLAIN}$`);
const COMPARATOR = pattern(`^${GTLT}\\s*(${FULL_PLAIN})$|^$`);
const BUILD_ALL = pattern(BUILD, "g");
const BUILD_FIRST = pattern(BUILD);
const HYPHEN_RANGE = pattern(`^\\s*(${X_PLAIN})\\s+-\\s+(${X_PLAIN})\\s*$`);
const COMPARATOR_TRIM = pattern(`(\\s*)${GTLT}\\s*(${LOOSE_PLAIN}|${X_PLAIN})`, "g");
const TILDE_TRIM = pattern("(\\s*)(?:~>?)\\s+", "g");
const CARET_TRIM = pattern("(\\s*)(?:\\^)\\s+", "g");
const TILDE = pattern(`^(?:~>?)${X_PLAIN}$`);
const CARET = pattern(`^(?:\\^)${X_PLAIN}$`);
const X_RANGE = pattern(`^${GTLT}\\s*${X_PLAIN}$`);
const STAR = pattern("(<|>)?=?\\s*\\*");
const GTE0_PRE = pattern("^\\s*>=\\s*0\\.0\\.0-0\\s*$");

export type SemVer = {
  readonly main: readonly [number, number, number];
  readonly prerelease: ReadonlyArray<string>;
};

/** A version npm's semver accepts (build metadata dropped), or null. */
export function parseVersion(text: unknown): SemVer | null {
  if (typeof text !== "string" || text.length > 256) return null;
  const match = FULL.exec(text.trim());
  if (!match) return null;
  const main = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  if (main.some((part) => part > Number.MAX_SAFE_INTEGER)) return null;
  return { main, prerelease: match[4] ? match[4].split(".") : [] };
}

/** A version to put in an install spec: one npm accepts, written plainly (no "v", no spaces). */
export const isExactVersion = (version: string): boolean =>
  /^\d/.test(version) && version.trim() === version && parseVersion(version) !== null;

const isNumeric = (id: string) => /^\d+$/.test(id);
// Strict identifiers have no leading zeros, so a longer number is a bigger one.
const compareIdentifiers = (a: string, b: string): number =>
  isNumeric(a) && isNumeric(b)
    ? a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
    : isNumeric(a) !== isNumeric(b)
      ? isNumeric(a)
        ? -1
        : 1
      : a < b
        ? -1
        : a > b
          ? 1
          : 0;

/** SemVer precedence: negative, zero or positive. */
export function compareVersions(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) if (a.main[i] !== b.main[i]) return a.main[i]! < b.main[i]! ? -1 : 1;
  if (!a.prerelease.length || !b.prerelease.length) return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let i = 0; ; i++) {
    const [x, y] = [a.prerelease[i], b.prerelease[i]];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return order;
  }
}

const format = (v: SemVer) => `${v.main.join(".")}${v.prerelease.length ? `-${v.prerelease.join(".")}` : ""}`;
const isX = (id: string | undefined) => !id || id.toLowerCase() === "x" || id === "*";

type Comparator = { readonly operator: "" | "<" | "<=" | ">" | ">="; readonly version: SemVer | null; readonly value: string };

// node-semver's desugaring (classes/range.js), with includePrerelease, as npm checks engines.
const caret = (comp: string) =>
  comp.replace(CARET, (_, M: string, m: string, p: string, pr: string | undefined) => {
    if (isX(M)) return "";
    if (isX(m)) return `>=${M}.0.0-0 <${+M + 1}.0.0-0`;
    if (isX(p)) return M === "0" ? `>=${M}.${m}.0-0 <${M}.${+m + 1}.0-0` : `>=${M}.${m}.0-0 <${+M + 1}.0.0-0`;
    const low = `>=${M}.${m}.${p}${pr ? `-${pr}` : ""}`;
    if (M !== "0") return `${low} <${+M + 1}.0.0-0`;
    return m === "0" ? `${low} <${M}.${m}.${+p + 1}-0` : `${low} <${M}.${+m + 1}.0-0`;
  });
const tilde = (comp: string) =>
  comp.replace(TILDE, (_, M: string, m: string, p: string, pr: string | undefined) => {
    if (isX(M)) return "";
    if (isX(m)) return `>=${M}.0.0 <${+M + 1}.0.0-0`;
    if (isX(p)) return `>=${M}.${m}.0 <${M}.${+m + 1}.0-0`;
    return `>=${M}.${m}.${p}${pr ? `-${pr}` : ""} <${M}.${+m + 1}.0-0`;
  });
const xRange = (comp: string) =>
  comp.trim().replace(X_RANGE, (whole: string, gtlt: string, M: string, m: string, p: string) => {
    if ((isX(M) && !isX(m)) || (isX(m) && p && !isX(p))) return comp.trim();
    const xm = isX(M) || isX(m);
    const anyX = xm || isX(p);
    if (gtlt === "=" && anyX) gtlt = "";
    if (isX(M)) return gtlt === ">" || gtlt === "<" ? "<0.0.0-0" : "*";
    if (gtlt && anyX) {
      let [major, minor] = [+M, xm ? 0 : +m];
      if (gtlt === ">") [gtlt, major, minor] = xm ? [">=", major + 1, 0] : [">=", major, minor + 1];
      else if (gtlt === "<=") [gtlt, major, minor] = xm ? ["<", major + 1, minor] : ["<", major, minor + 1];
      return `${gtlt}${major}.${minor}.0-0`;
    }
    if (xm) return `>=${M}.0.0-0 <${+M + 1}.0.0-0`;
    if (anyX) return `>=${M}.${m}.0-0 <${M}.${+m + 1}.0-0`;
    return whole;
  });
const hyphen = (
  _: string,
  from: string, fM: string, fm: string, fp: string, fpr: string | undefined, _fb: string | undefined,
  to: string, tM: string, tm: string, tp: string, tpr: string | undefined,
) => {
  const low = isX(fM) ? "" : isX(fm) ? `>=${fM}.0.0-0` : isX(fp) ? `>=${fM}.${fm}.0-0` : fpr ? `>=${from}` : `>=${from}-0`;
  const high = isX(tM) ? "" : isX(tm) ? `<${+tM + 1}.0.0-0` : isX(tp) ? `<${tM}.${+tm + 1}.0-0` : tpr ? `<=${tM}.${tm}.${tp}-${tpr}` : `<${tM}.${tm}.${+tp + 1}-0`;
  return `${low} ${high}`.trim();
};

function comparator(text: string): Comparator | null {
  const match = COMPARATOR.exec(text.trim().split(/\s+/).join(" "));
  if (!match) return null;
  const operator = (match[1] === "=" ? "" : (match[1] ?? "")) as Comparator["operator"];
  if (!match[2]) return { operator, version: null, value: "" };
  const version = parseVersion(match[2]);
  return version && { operator, version, value: `${operator}${format(version)}` };
}

/** One `||` alternative: its comparators, or null when node-semver would throw. */
function comparatorSet(text: string): ReadonlyArray<Comparator> | null {
  const range = text
    .replace(BUILD_ALL, "")
    .replace(HYPHEN_RANGE, hyphen as (...args: Array<string>) => string)
    .replace(COMPARATOR_TRIM, "$1$2$3")
    .replace(TILDE_TRIM, "$1~")
    .replace(CARET_TRIM, "$1^");
  const tokens = range
    .split(" ")
    .map((token) => {
      const desugared = (step: (c: string) => string, c: string) => c.trim().split(/\s+/).map(step).join(" ");
      let comp = token.replace(BUILD_FIRST, "");
      comp = desugared(caret, comp);
      comp = desugared(tilde, comp);
      comp = comp.split(/\s+/).map(xRange).join(" ");
      return comp.trim().replace(STAR, "");
    })
    .join(" ")
    .split(/\s+/)
    .map((comp) => comp.trim().replace(GTE0_PRE, ""));
  const byValue = new Map<string, Comparator>();
  for (const token of tokens) {
    const parsed = comparator(token);
    if (!parsed) return null;
    if (parsed.value === "<0.0.0-0") return [parsed];
    byValue.set(parsed.value, parsed);
  }
  if (byValue.size > 1) byValue.delete("");
  return [...byValue.values()];
}

/**
 * Whether `version` satisfies npm range `range` with prereleases included, as
 * npm checks a manifest's `engines` (npm-install-checks). Anything node-semver
 * can't read is false.
 */
export function satisfiesEngine(version: string, range: unknown): boolean {
  if (typeof range !== "string") return false;
  const sets: Array<ReadonlyArray<Comparator>> = [];
  for (const alternative of range.trim().replace(/\s+/g, " ").split("||")) {
    const set = comparatorSet(alternative.trim());
    if (!set) return false;
    sets.push(set);
  }
  const parsed = parseVersion(version);
  if (!parsed) return false;
  return sets.some((set) =>
    set.every(({ operator, version: bound }) => {
      if (!bound) return true;
      const order = compareVersions(parsed, bound);
      return { "": order === 0, "<": order < 0, "<=": order <= 0, ">": order > 0, ">=": order >= 0 }[operator];
    }),
  );
}

// ---------------------------------------------------------------------------

type Engines = { readonly node: string | null; readonly npm: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** npm-install-checks' checkEngine: a manifest's engines.node and engines.npm, where known. */
function engineOk(manifest: Record<string, unknown>, engines: Engines): boolean {
  const required = manifest.engines;
  if (!required) return true;
  const field = (name: string) => (typeof required === "object" ? (required as Record<string, unknown>)[name] : undefined);
  const nodeFails = engines.node && field("node") && !satisfiesEngine(engines.node, field("node"));
  const npmFails = engines.npm && field("npm") && !satisfiesEngine(engines.npm, field("npm"));
  return !(nodeFails || npmFails);
}

const sameRelease = (a: SemVer, b: SemVer) => a.main.every((part, i) => part === b.main[i]);

/**
 * What `npm install <name>@latest --before=<cutoff>` installs, read from the
 * registry's full document ({ dist-tags, versions, time }), as npm-pick-manifest
 * picks it: the latest tag once it is old enough (deprecated or not); otherwise
 * the best version before the cutoff in `<=latest` (prereleases only of the
 * tag's own release), preferring live and engine-compatible, then
 * engine-compatible, then live, then the highest. Null when nothing qualifies
 * or the document is malformed.
 *
 * `engines`: the Node and npm versions npm checks engines against. The server's
 * Node stands in for the one the provider's npm runs under; npm's own version is
 * unknown here, so engines.npm isn't checked. Unlike npm, a version with no
 * valid publish time is never taken (npm treats a missing one as old enough),
 * and a version key that isn't strict SemVer is skipped (the registry only
 * publishes strict ones).
 *
 * `ceiling`: an exact x.y.z version to stay at or below, such as a native
 * install's update channel. Below the latest tag it takes the tag's place, so it
 * too must be a release npm lists with a valid publish time. Null when it isn't
 * an exact x.y.z version.
 */
export function newestSettledVersion(
  document: unknown,
  now: number = Date.now(),
  engines: Engines = { node: typeof process === "undefined" ? null : process.version, npm: null },
  ceiling: string | null = null,
): string | null {
  if (!isRecord(document)) return null;
  const { "dist-tags": tags, versions, time } = document;
  if (!isRecord(tags) || !isRecord(versions) || !isRecord(time)) return null;
  const latest = tags.latest;
  const tagged = parseVersion(latest);
  if (typeof latest !== "string" || !tagged) return null;
  const capped = ceiling === null ? null : /^\d+\.\d+\.\d+$/.test(ceiling) ? parseVersion(ceiling) : null;
  if (ceiling !== null && !capped) return null;
  // The version to stay at or below: the latest tag, or a lower ceiling in its place.
  const [top, bound] = ceiling !== null && capped && compareVersions(capped, tagged) < 0 ? [ceiling, capped] : [latest, tagged];
  const cutoff = Date.parse(releaseAgeCutoff(now));
  const settled = (version: string) => {
    const published = time[version];
    return typeof published === "string" && Date.parse(published) <= cutoff;
  };
  // npm reads a tag with no publish time as old enough. This offers nothing then, or when the time can't be read.
  const published = time[top];
  if (typeof published !== "string" || Number.isNaN(Date.parse(published))) return null;
  if (settled(top)) return isRecord(versions[top]) ? top : null;
  const candidates = Object.keys(versions).flatMap((version) => {
    const manifest = versions[version];
    const parsed = parseVersion(version);
    if (!isRecord(manifest) || !parsed || !settled(version) || compareVersions(parsed, bound) > 0) return [];
    if (parsed.prerelease.length > 0 && !(bound.prerelease.length > 0 && sameRelease(parsed, bound))) return [];
    return [{ version, parsed, live: !manifest.deprecated, fits: engineOk(manifest, engines) }];
  });
  // A stable sort, like npm's: equal precedence (build metadata) keeps the document's order.
  candidates.sort(
    (a, b) =>
      Number(b.live && b.fits) - Number(a.live && a.fits) ||
      Number(b.fits) - Number(a.fits) ||
      Number(b.live) - Number(a.live) ||
      compareVersions(b.parsed, a.parsed),
  );
  return candidates[0]?.version ?? null;
}

// ---------------------------------------------------------------------------
// First seen on a vendor's channel, for a channel that names one version and no
// date. Kept in the server's state directory, so a wait outlasts restarts.

const DAY_MS = 86_400_000;

/** When this server first saw each version on each channel: { [channel]: { [version]: epoch ms } }. */
const FirstSeenFile = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Finite)));
const decodeFirstSeen = Schema.decodeUnknownEffect(FirstSeenFile);
const encodeFirstSeen = Schema.encodeEffect(FirstSeenFile);

/**
 * The newest version this server first saw on `channel` at least
 * MIN_RELEASE_AGE_DAYS ago, and no newer than `version`, the one the channel
 * names now; null when none is. `version` must be plain x.y.z. It's recorded
 * the first time it's seen. A channel that has moved back has pulled whatever
 * was above it: nothing above is offered, and a pulled version named again
 * waits from then. One check at a time in this server reads and writes the
 * record; it's written whole to a file of its own, then renamed over the record,
 * so a reader never sees half of it. A record it can't
 * read starts every wait over, an entry dated ahead of the clock that version's
 * wait, and a record it can't write keeps every new version back.
 */
const firstSeenLock = Semaphore.makeUnsafe(1);
let firstSeenWrites = 0;

export const settledSinceFirstSeen = Effect.fn("settledSinceFirstSeen")(function* (input: {
  readonly file: string;
  readonly channel: string;
  readonly version: string;
}) {
  const current = /^\d+\.\d+\.\d+$/.test(input.version) ? parseVersion(input.version) : null;
  if (!current) return null;
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const record = yield* fs.readFileString(input.file).pipe(
    Effect.flatMap(decodeFirstSeen),
    Effect.orElseSucceed((): typeof FirstSeenFile.Type => ({})),
  );
  const seen = { ...record[input.channel] };
  const added = !(seen[input.version]! <= now);
  if (added) seen[input.version] = now;
  const settled = (version: string) => now - seen[version]! >= MIN_RELEASE_AGE_DAYS * DAY_MS;
  const newest =
    Object.keys(seen)
      .flatMap((version) => {
        const parsed = parseVersion(version);
        return parsed && settled(version) && compareVersions(parsed, current) <= 0 ? [{ version, parsed }] : [];
      })
      .sort((a, b) => compareVersions(b.parsed, a.parsed))[0]?.version ?? null;
  // Keep what may still settle, and the version offered; drop the rest, and anything
  // above the version named now: the channel has pulled it, so it waits again if named again.
  const kept = Object.fromEntries(
    Object.entries(seen).filter(([version]) => {
      const parsed = parseVersion(version);
      return parsed !== null && compareVersions(parsed, current) <= 0 && (!settled(version) || version === newest);
    }),
  );
  if (added || Object.keys(kept).length < Object.keys(seen).length) {
    const temp = `${input.file}.${process.pid}.${++firstSeenWrites}.tmp`;
    yield* encodeFirstSeen({ ...record, [input.channel]: kept }).pipe(
      Effect.flatMap((text) => fs.writeFileString(temp, text)),
      Effect.andThen(fs.rename(temp, input.file)),
      Effect.ignore,
    );
  }
  return newest;
}, (effect) => firstSeenLock.withPermit(effect));

/**
 * The version a channel pointer at `url` (a plain-text x.y.z, such as Grok's
 * https://x.ai/cli/stable) names, once this server has seen it there for
 * MIN_RELEASE_AGE_DAYS (settledSinceFirstSeen, recorded in `file`). Null when
 * the channel can't be read in 4 seconds, or names anything else.
 */
export const firstSeenChannelVersion = Effect.fn("firstSeenChannelVersion")(function* (url: string, file: string) {
  const client = yield* HttpClient.HttpClient;
  const named = yield* client.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.timeoutOption("4 seconds"),
    Effect.map((text) => Option.getOrNull(text)?.trim() ?? null),
    Effect.orElseSucceed(() => null),
  );
  return named === null ? null : yield* settledSinceFirstSeen({ file, channel: url, version: named });
});

// ---------------------------------------------------------------------------
// One-click updates (Update all). npm and pnpm install exactly the version the
// check reported, as an exact package spec, and hold the whole install to the
// minimum age as well (--before, minimum-release-age; maintenanceResolver.ts).
// Each native updater in EXACT_UPDATES installs an exact version too: the one
// the check reported. For Claude Code, Codex and OpenCode that's an npm release
// whose own publish time shows it MIN_RELEASE_AGE_DAYS old
// (newestSettledVersion), an age only because the vendor builds its native and
// npm releases from the same release, under the same version number, which each
// entry's source shows. For native Grok it's the version first seen on Grok's
// own channel MIN_RELEASE_AGE_DAYS ago (firstSeenChannelVersion), and its
// updater downloads that build from the same host. Any other updater is left to
// the user (onlyExactUpdates): one that takes no version, such as Homebrew's
// `brew upgrade`, Pi's `pi update --self` or Muse's launcher, and any upstream
// adds.

type UpdateAction = ProviderMaintenanceCommandAction;

type ExactUpdate = {
  /** Upstream's arguments for the updater. */
  readonly args: string;
  /** Its command for exactly one version. */
  readonly pin: (update: UpdateAction, version: string) => UpdateAction;
  /** The version is the one first seen on the vendor's channel, which the driver checks; never npm's. */
  readonly firstSeen?: true;
};

/** By lock key: each native updater blacksand can make install an exact version. */
const EXACT_UPDATES = new Map<string, ExactUpdate>([
  // `claude install <version>`, never `claude update` (the newest build, however young).
  ["claudeAgent-native", { args: "update", pin: (update, version) => ({ ...update, args: ["install", version], command: `${update.command.slice(0, -"update".length)}install ${version}` }) }],
  // `codex update` reruns Codex's installer (install.sh, install.ps1), which installs CODEX_RELEASE when it's set.
  ["codex-native", { args: "update", pin: (update, version) => ({ ...update, env: { ...update.env, CODEX_RELEASE: version }, command: `CODEX_RELEASE=${version} ${update.command}` }) }],
  // `opencode upgrade <version>`, in both generations, with its background updater off
  // like every other OpenCode process T3 starts (provider/opencode-autoupdate-off).
  ["opencode-native", { args: "upgrade", pin: (update, version) => ({ ...update, args: ["upgrade", version], env: { ...update.env, OPENCODE_DISABLE_AUTOUPDATE: "1" }, command: `${update.command} ${version}` }) }],
  // `grok update --version <version>` hands the version straight to Grok's installer
  // (xai-grok-update auto_update.rs, run_update). GROK_INSTALLER=internal makes that the
  // installer that downloads Grok's own build grok-<version>-<platform> (from x.ai/cli, or
  // the same name from Grok's storage mirror), whatever installer Grok's config names (rule
  // provider/grok-native-updates). Its own updater stays off meanwhile.
  ["grok-native", { args: "update", firstSeen: true, pin: (update, version) => ({ ...update, args: ["update", "--version", version], env: { ...update.env, GROK_INSTALLER: "internal", GROK_DISABLE_AUTOUPDATER: "1" }, command: `GROK_INSTALLER=internal ${update.command} --version ${version}` }) }],
]);

const keepsMinimumAge = (lockKey: string) => /^(?:npm-global:|pnpm-global$)/.test(lockKey) || EXACT_UPDATES.has(lockKey);

/**
 * A native updater's command for exactly `version`, the version the check
 * offered. Null without one, for a version that isn't plain x.y.z, an updater
 * not in EXACT_UPDATES, or one whose arguments upstream changed.
 */
export function exactUpdateAction(update: UpdateAction, version: string | null): UpdateAction | null {
  if (version === null) return null;
  const exact = EXACT_UPDATES.get(update.lockKey);
  if (!exact || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (update.args.join(" ") !== exact.args || !update.command.endsWith(` ${exact.args}`)) return null;
  return exact.pin(update, version);
}

/**
 * `capabilities`, unless its updater can't install an exact version: then no
 * update, its command shown for the user to run, and why. Its version check is
 * dropped with it, so what it reports comes from npm, at least
 * MIN_RELEASE_AGE_DAYS old. An updater whose version is first seen on its
 * vendor's channel has no version until the driver adds that check: never npm's
 * or upstream's.
 */
export function onlyExactUpdates(capabilities: ProviderMaintenanceCapabilities): ProviderMaintenanceCapabilities {
  const update = capabilities.update;
  if (update !== null && EXACT_UPDATES.get(update.lockKey)?.firstSeen) {
    const { lookupLatestVersion: _lookup, latestVersionCacheKey: _key, ...rest } = capabilities;
    return { ...rest, latestVersion: null };
  }
  // Codex's and OpenCode's versions come from npm, dated, never from a lookup of their
  // own; native Claude Code's channel stays, as the ceiling (provider/claude-native-updates-minimum-age).
  if (update !== null && EXACT_UPDATES.has(update.lockKey) && update.lockKey !== "claudeAgent-native") {
    const { lookupLatestVersion: _lookup, latestVersionCacheKey: _key, latestVersion: _version, ...rest } = capabilities;
    return rest;
  }
  if (update === null || keepsMinimumAge(update.lockKey)) return capabilities;
  return {
    provider: capabilities.provider,
    packageName: capabilities.packageName,
    update: null,
    ...(capabilities.compareVersions ? { compareVersions: capabilities.compareVersions } : {}),
    manualCommand: update.command,
    manualReason:
      `T3 Code (blacksand) doesn't run \`${update.command}\`: it can't install a specific version, so it can't keep to releases at least ${MIN_RELEASE_AGE_DAYS} days old. Run it yourself when you choose to update.` +
      (capabilities.packageName ? " To update it in one click, install it with npm or pnpm instead." : ""),
  };
}
