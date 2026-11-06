// The security fast lane: which young dependency versions may skip the minimum
// age because they fix something the pinned release is exposed to.
//
// A version qualifies when it fixes an open advisory against the pinned release
// (an advisory source, lib/advisories.mjs, lists a fix in the compatibility line
// of both the vulnerable version and the candidate, the candidate is at or past
// it, and no source flags it under any of the advisory's names; a 0.x line is
// one minor, as npm's caret treats it) or, for Electron, when its
// embedded Node crosses a Node.js security release or its Chromium moves. It
// must also look like the usual publisher shipped it, judged only against
// versions of the package the pinned release already uses that are at least the
// minimum age old (deprecated or not; none, no fast lane):
//   - the npm account that published it published one of those;
//   - it declares the repository they declare;
//   - if any of those carried npm provenance, it does too, for this exact tarball,
//     built from that repository at a tag, the default branch or a vN.x
//     maintenance branch.
// Provenance here is only read, never verified (its Sigstore signatures aren't
// checked), so it can only take a version out of the fast lane, never put one
// in: a new publisher, a switch to npm trusted publishing included, waits out the
// minimum age like any other version. Verified provenance wouldn't be enough
// either: SubQuery's Oct 2026 malware carried valid provenance from a modified
// workflow. Every other gate still applies.

import { findAdvisories } from "./advisories.mjs";
import { MIN_AGE_DAYS, ageSetting, npmMeta, publishedTime, repoOf } from "./gates.mjs";
import { request } from "./http.mjs";
import { compareVersions, lineOf, parseVersion } from "./semver.mjs";

export { repoOf };

const REGISTRY = "https://registry.npmjs.org";
const ELECTRON_RELEASES = "https://releases.electronjs.org/releases.json";
const NODE_RELEASES = "https://nodejs.org/dist/index.json";
const cache = new Map();

/** A release index every caller needs: an array, or this throws (a 404 included), never an empty answer. */
function releaseIndex(url) {
  if (!cache.has(url)) {
    cache.set(
      url,
      request(url, { headers: { accept: "application/json" } }).then((list) => {
        if (!Array.isArray(list) || !list.length) throw new Error(`${url} sent no release list`);
        return list;
      }),
    );
  }
  return cache.get(url);
}

const split = (pkg) => {
  const at = pkg.lastIndexOf("@");
  return { name: pkg.slice(0, at), version: pkg.slice(at + 1) };
};

/**
 * What the SLSA provenance npm holds for `name@version` says: { repository, ref }
 * or { problem }. Read, not verified: only ever a reason to refuse.
 */
async function provenanceOf(name, version, info) {
  const attestations = await request(`${REGISTRY}/-/npm/v1/attestations/${name.replace("/", "%2f")}@${version}`, { notFound: "null", label: `npm attestations (${name}@${version})` });
  const slsa = attestations?.attestations?.find((a) => /^https:\/\/slsa\.dev\/provenance\//.test(a?.predicateType ?? ""));
  if (!slsa) return { problem: "provenance listed but not retrievable" };
  let statement;
  try {
    statement = JSON.parse(Buffer.from(slsa.bundle.dsseEnvelope.payload, "base64").toString("utf8"));
  } catch {
    return { problem: "provenance unreadable" };
  }
  // The statement must be about this tarball: its purl and the registry's sha512.
  const purl = `pkg:npm/${name.replace(/^@/, "%40")}@${version}`;
  const [algorithm, digest] = String(info.dist?.integrity ?? "").split("-");
  const sha512 = algorithm === "sha512" ? Buffer.from(digest ?? "", "base64").toString("hex") : null;
  if (!sha512 || !(statement.subject ?? []).some((s) => s?.name === purl && s?.digest?.sha512 === sha512)) {
    return { problem: "provenance doesn't name this tarball" };
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow ?? {};
  return { repository: String(workflow.repository ?? ""), ref: String(workflow.ref ?? "") };
}

/**
 * { ok, summary } on whether `name@version` looks like its usual publisher shipped
 * it, against `accepted`: versions of `name` the pinned release already uses. Only
 * those at least `minDays` old count, so a run of fresh releases can't vouch for
 * the next one. A refusal also has a `code` (REFUSALS), which only reports why.
 */
export async function publisherContinuity(name, version, { accepted = [], now = Date.now(), minDays = MIN_AGE_DAYS } = {}) {
  ageSetting(minDays);
  const no = (code, summary) => ({ ok: false, code, summary });
  const meta = await npmMeta(name);
  const info = meta?.versions?.[version];
  if (!info) return no("not-on-npm", "not on npm");
  const cutoff = now - minDays * 86_400_000;
  const baseline = [...new Set(accepted)].filter((v) => v !== version && meta.versions[v] && (publishedTime(meta.time?.[v]) ?? Infinity) <= cutoff);
  if (!baseline.length) return no("no-aged-baseline", `no version of ${name} the pinned release uses is ${minDays} days old to compare with`);
  const publisher = info._npmUser?.name ?? null;
  const usual = new Set(baseline.map((v) => meta.versions[v]._npmUser?.name).filter(Boolean));
  const repos = new Set(baseline.map((v) => repoOf(meta.versions[v].repository)).filter(Boolean));
  const declared = repoOf(info.repository);
  if (repos.size && !repos.has(declared)) return no("repository-changed", `declares repository ${declared ?? "none"}, not ${[...repos].join(", ")}`);
  if (!usual.has(publisher)) return no("publisher-changed", `published by ${publisher ?? "an unknown account"}, not by ${[...usual].join(", ") || "a known account"}`);
  const hadProvenance = baseline.some((v) => meta.versions[v].dist?.attestations);
  if (!info.dist?.attestations) {
    return hadProvenance ? no("provenance-dropped", "no npm provenance, though earlier versions had it") : { ok: true, summary: `publisher ${publisher}, no provenance (none before either)` };
  }
  if (!repos.size) return no("provenance-unchecked", "has provenance, but no earlier version names a repository to check it against");
  const provenance = await provenanceOf(name, version, info);
  if (provenance.problem) return no("provenance-mismatch", provenance.problem);
  if (!repos.has(repoOf(provenance.repository))) return no("provenance-mismatch", `provenance from ${provenance.repository || "no repository"}, not ${[...repos].join(", ")}`);
  // A tag, the default branch, or a maintenance branch for an older line (v7.x).
  if (!/^refs\/(tags\/|heads\/(main|master|v\d+(\.\d+)?\.x)$)/.test(provenance.ref)) {
    return no("provenance-ref", `provenance built from ${provenance.ref || "no ref"}, not a tag, the default branch or a vN.x branch`);
  }
  return { ok: true, summary: `publisher ${publisher}, provenance (unverified) names ${provenance.repository} ${provenance.ref}` };
}

/**
 * Why a newer Electron (same major) is a security update for the runtime, or null.
 * A version Electron's release list doesn't have yet gives no reason; a release
 * list that can't be fetched throws.
 */
export async function electronSecurityReason(from, to) {
  if (compareVersions(to, from) <= 0 || lineOf(to) !== lineOf(from)) return null;
  const releases = await releaseIndex(ELECTRON_RELEASES);
  const find = (v) => releases.find((release) => release?.version === v.replace(/^v/, ""));
  const [a, b] = [find(from), find(to)];
  if (!a || !b) return null;
  const reasons = [];
  if (a.node !== b.node) {
    const index = await releaseIndex(NODE_RELEASES);
    const crossed = index.filter(
      (release) => release?.security && lineOf(release.version) === lineOf(b.node) && compareVersions(release.version, a.node) > 0 && compareVersions(release.version, b.node) <= 0,
    );
    if (crossed.length) reasons.push(`embedded Node ${a.node} -> ${b.node} includes the Node.js security release ${crossed.map((r) => r.version).join(", ")}`);
  }
  if (a.chrome !== b.chrome) reasons.push(`Chromium ${a.chrome} -> ${b.chrome}`);
  return reasons.length ? reasons.join("; ") : null;
}

/**
 * Node.js and Chromium security releases the pinned Electron hasn't taken, as
 * advisories (OSV covers Electron's own advisories, not what it embeds). Fails
 * rather than answering "none" when the release lists can't be read.
 */
export async function runtimeAdvisories(packages) {
  const electron = [...packages].find((pkg) => pkg.startsWith("electron@"));
  if (!electron) return [];
  const version = electron.slice("electron@".length);
  const releases = await releaseIndex(ELECTRON_RELEASES);
  if (!releases.some((r) => r?.version === version)) throw new Error(`Electron ${version} isn't in Electron's release list; can't tell which runtime security updates it lacks`);
  const newest = releases
    .filter((r) => /^\d+\.\d+\.\d+$/.test(r?.version ?? "") && lineOf(r.version) === lineOf(version))
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!newest || compareVersions(newest.version, version) <= 0) return [];
  const reason = await electronSecurityReason(version, newest.version);
  if (!reason) return [];
  return [
    {
      id: `ELECTRON-RUNTIME-${newest.version}`,
      aliases: [],
      summary: `Electron ${version} lacks runtime security updates in ${newest.version}: ${reason}`,
      severity: /Node\.js security release/.test(reason) ? "HIGH" : "MODERATE",
      url: `https://github.com/electron/electron/releases/tag/v${newest.version}`,
      packages: [{ pkg: electron, fixed: [newest.version] }],
    },
  ];
}

/**
 * The fast lane for one evaluation: given the packages of the pinned release and
 * its open advisories, returns `waive(pkg)` -> Promise<reason | null>. Whether
 * a candidate is still flagged is asked of the same sources (`advisories`,
 * lib/advisories.mjs findAdvisories), its own repository's advisories too when
 * its name is in `watch`; `continuity` is publisherContinuity (both for tests).
 *
 * A fix counts when a curated source states it for that very package
 * (`curatedFixed`, lib/advisories.mjs mergeAdvisories; a repository's claim
 * merged in by a shared alias doesn't). One only a package's own repository
 * claims opens the lane for one version alone: the one an owner-signed
 * override (lib/overrides.json deviceTools) names as its fix, for an advisory
 * it names. `vouched` lists
 * those as [{ pkg: name@version, advisories: [ids] }]. Nobody curates a
 * repository's advisories, and the maintainer account that could publish a
 * hijacked release could also publish, or edit, one that "fixes" it; what the
 * owner signed is the version, not the advisory's word. Such an advisory still
 * counts against a candidate (still flagged), and for alerts.
 *
 * `waive.decisions()`, for the evaluator's metrics only (ci/metrics.mjs), read
 * after the age gate is done: a copy of each decision so far on a version that
 * would fix an advisory open against the one it replaces, admitted or not, as
 * plain data: { pkg, publishedAt (as `waive`'s caller gave it, or null),
 * admitted, code ("admitted" or a REFUSALS key), reason, advisories, replaces }.
 */
export function makeFastLane({ basePackages, openAdvisories, now = Date.now(), minDays = MIN_AGE_DAYS, watch = [], vouched = [], advisories = findAdvisories, continuity = publisherContinuity }) {
  const accepted = new Map();
  for (const pkg of basePackages) {
    const { name, version } = split(pkg);
    if (parseVersion(version)) accepted.set(name, [...(accepted.get(name) ?? []), version]);
  }
  // Whether the owner signed `pkg` as the fix for an advisory named any of `names`.
  const vouchedFor = (pkg, names) => vouched.some((v) => v.pkg === pkg && v.advisories.some((id) => names.includes(id)));
  const advisoriesByName = new Map();
  for (const advisory of openAdvisories) {
    for (const claim of advisory.packages) {
      const { name, version } = split(claim.pkg);
      const names = [advisory.id, ...(advisory.aliases ?? [])];
      // The fixes a curated source itself states for this package (lib/advisories.mjs
      // mergeAdvisories): never those of a repository's record merged in by alias. An
      // advisory without per-claim attribution counts as curated only when no
      // repository took part in it (Electron's runtime ones, OSV-only callers).
      const curatedFixed = Array.isArray(claim.curatedFixed)
        ? claim.curatedFixed
        : !Array.isArray(advisory.sources) || !advisory.sources.includes("github-repository")
          ? claim.fixed
          : [];
      advisoriesByName.set(name, [...(advisoriesByName.get(name) ?? []), { id: advisory.id, names, curatedFixed, from: version, fixed: claim.fixed }]);
    }
  }
  const baseElectron = (accepted.get("electron") ?? []).sort(compareVersions).at(-1) ?? null;
  // Each decision on a version that would fix something open, as data, for the evaluator's metrics.
  const decisions = [];
  const waive = async (pkg, { publishedAt = null } = {}) => {
    const { name, version } = split(pkg);
    if (!parseVersion(version)) return null;
    let why = null;
    // What it would fix, for the record: { advisories, replaces }, null while it's unknown or nothing.
    let fixing = null;
    let refusal = "no-curated-fix";
    if (name === "electron" && baseElectron) {
      why = await electronSecurityReason(baseElectron, version);
      if (why) fixing = { advisories: (advisoriesByName.get(name) ?? []).filter(({ from }) => from === baseElectron).map(({ id }) => id), replaces: [`electron@${baseElectron}`] };
    } else {
      const line = lineOf(version);
      const sameLine = (v) => parseVersion(v) !== null && lineOf(v) === line;
      const reaches = (advisoriesByName.get(name) ?? []).filter(({ from, fixed }) => sameLine(from) && fixed.some((f) => sameLine(f) && compareVersions(version, f) >= 0));
      if (reaches.length) fixing = { advisories: [...new Set(reaches.map(({ id }) => id))], replaces: [...new Set(reaches.map(({ from }) => `${name}@${from}`))] };
      const fixes = (advisoriesByName.get(name) ?? []).filter(
        ({ names, curatedFixed, from, fixed }) =>
          sameLine(from) && fixed.some((f) => sameLine(f) && compareVersions(version, f) >= 0 && (curatedFixed.includes(f) || vouchedFor(pkg, names))),
      );
      if (fixes.length) {
        // Still flagged under any of its names (sources merge them under one id, not always the same one).
        const still = new Set((await advisories([pkg], { watch })).flatMap((a) => [a.id, ...(a.aliases ?? [])]));
        const resolved = fixes.filter((fix) => !fix.names.some((id) => still.has(id)));
        if (resolved.length) why = `fixes ${[...new Set(resolved.map((fix) => fix.id))].join(", ")}`;
        else refusal = "still-flagged";
      }
    }
    const record = (code, reason) => fixing && decisions.push({ pkg, publishedAt, admitted: code === "admitted", code, reason, ...fixing });
    if (!why) {
      record(refusal, refusal === "still-flagged" ? "a source still flags it" : "no curated source states this fix");
      return null;
    }
    const trust = await continuity(name, version, { accepted: accepted.get(name) ?? [], now, minDays });
    record(trust.ok ? "admitted" : (trust.code ?? "continuity"), trust.ok ? `${why} (${trust.summary})` : trust.summary);
    return trust.ok ? `${why} (${trust.summary})` : null;
  };
  waive.decisions = () => structuredClone(decisions);
  return waive;
}

/** The codes a fast-lane refusal is recorded with (`waive.decisions()`), besides "admitted". */
export const REFUSALS = Object.freeze({
  "no-curated-fix": "no curated source states the fix",
  "still-flagged": "a source still flags it",
  "not-on-npm": "not on npm",
  "no-aged-baseline": "no aged version to compare with",
  "repository-changed": "declares another repository",
  "publisher-changed": "another npm publisher",
  "provenance-dropped": "provenance dropped",
  "provenance-unchecked": "provenance with no repository to check",
  "provenance-mismatch": "provenance mismatch",
  "provenance-ref": "provenance from another branch",
  continuity: "publisher continuity",
});
