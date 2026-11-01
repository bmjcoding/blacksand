// Properties of advisory normalization (lib/advisories.mjs, lib/cvss.mjs,
// lib/http.mjs retryAfterMs), on generated records. An advisory's severity
// decides whether anyone is told: a merge must never make one quieter, lose a
// package or a fix a source stated, credit a repository's own claim as
// curated, or depend on the order the sources answered in.

import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { check, type Tier } from "../../../scripts/fuzz.ts";
import { RANKED, completeAdvisories, fixedVersions, mergeAdvisories, rankOf, severityOf } from "../lib/advisories.mjs";
import { cvssScore, scoreSeverity } from "../lib/cvss.mjs";
import { retryAfterMs } from "../lib/http.mjs";
import { compareVersions, parseVersion } from "../lib/semver.mjs";

const V3_METRICS = { AV: "NALP", AC: "LH", PR: "NLH", UI: "NR", S: "UC", C: "HLN", I: "HLN", A: "HLN" } as const;
const V2_METRICS = { AV: "LAN", AC: "HML", Au: "MSN", C: "NPC", I: "NPC", A: "NPC" } as const;

/** A complete CVSS vector, its metrics in any order. */
const vector = (metrics: { [name: string]: string }, prefix: string) =>
  fc
    .tuple(fc.tuple(...Object.entries(metrics).map(([name, values]) => fc.constantFrom(...values.split("")).map((v) => `${name}:${v}`))), fc.nat())
    .chain(([parts]) => fc.shuffledSubarray(parts, { minLength: parts.length, maxLength: parts.length }))
    .map((parts) => `${prefix}${parts.join("/")}`);
const v3 = vector(V3_METRICS, "CVSS:3.1/");
const v2 = vector(V2_METRICS, "");

const junk = fc.oneof(fc.string({ maxLength: 20 }), fc.constantFrom("CVSS:3.1/AV:N", "CVSS:3.1/AV:N/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", "CVSS:3.1/AV:toString/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"));
const severityEntry = fc.oneof(
  v3.map((score) => ({ type: "CVSS_V3", score })),
  v2.map((score) => ({ type: "CVSS_V2", score })),
  fc.record({ type: fc.constantFrom("CVSS_V3", "CVSS_V2", "CVSS_V4", "Ubuntu", ""), score: junk }),
);
const stated = fc.constantFrom("LOW", "moderate", "MEDIUM", "High", "CRITICAL", "", "important", "UNKNOWN");
const osvRecord = fc.record(
  {
    id: fc.constantFrom("GHSA-aaaa-bbbb-cccc", "MAL-2026-1", "CVE-2026-0001", "OSV-1"),
    database_specific: fc.record({ severity: stated }, { requiredKeys: [] }),
    severity: fc.array(severityEntry, { maxLength: 3 }),
    affected: fc.array(fc.record({ database_specific: fc.record({ severity: stated }, { requiredKeys: [] }), severity: fc.array(severityEntry, { maxLength: 2 }) }, { requiredKeys: [] }), { maxLength: 3 }),
  },
  { requiredKeys: ["id"] },
);

/** Every rating a record states that the reader recognises: database ratings and scorable vectors. */
function ratings(vuln: any): string[] {
  const named = [vuln.database_specific?.severity, ...(vuln.affected ?? []).map((a: any) => a.database_specific?.severity)]
    .filter(Boolean)
    .map((s: string) => s.toUpperCase().replace(/^MEDIUM$/, "MODERATE"))
    .filter((s: string) => ["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(s));
  const scored = [...(vuln.severity ?? []), ...(vuln.affected ?? []).flatMap((a: any) => a.severity ?? [])].map((e) => [cvssScore(e), e.type]).filter(([s]) => s !== null).map(([s, type]) => scoreSeverity(s, type));
  return [...named, ...scored];
}

// ------------------------------------------------------- merged records --

const IDS = ["GHSA-2222-3333-4444", "GHSA-5555-6666-7777", "CVE-2026-1", "CVE-2026-2", "OSV-2026-9", "MAL-2026-3"];
const PKGS = ["a@1.0.0", "a@1.0.1", "@s/b@2.0.0", "c@0.1.0"];
const FIXES = ["1.0.1", "1.2.0", "2.0.1", "0.1.1", "not-semver", "1.0.1+build"];
const SOURCES = ["osv", "github", "github-repository"] as const;

const record = fc.record({
  id: fc.constantFrom(...IDS),
  aliases: fc.uniqueArray(fc.constantFrom(...IDS), { maxLength: 2 }),
  source: fc.constantFrom(...SOURCES),
  severity: fc.constantFrom(...RANKED, "bogus"),
  summary: fc.constantFrom("", "s1", "s2"),
  packages: fc.uniqueArray(fc.record({ pkg: fc.constantFrom(...PKGS), fixed: fc.uniqueArray(fc.constantFrom(...FIXES), { maxLength: 2 }) }), { maxLength: 3, selector: (p) => p.pkg }),
});
/** Records as the three sources give them: one record per id per source (each source publishes an id once). */
const records = fc
  .uniqueArray(record, { maxLength: 8, selector: (r) => `${r.id} ${r.source}` })
  .map((list) => list.map(({ source, ...r }) => ({ ...r, aliases: r.aliases.filter((a) => a !== r.id), sources: [source], ...(source === "github-repository" ? { repository: "owner/repo" } : {}) })));

/** Which records belong together: connected through shared ids and aliases (a reference union, by walking). */
function groupsOf(list: Array<{ id: string; aliases: string[] }>): string[][] {
  const names = (r: { id: string; aliases: string[] }) => [r.id, ...r.aliases];
  const groups: string[][] = [];
  const done = new Set<number>();
  for (let i = 0; i < list.length; i++) {
    if (done.has(i)) continue;
    const members = new Set([i]);
    for (let grew = true; grew; ) {
      grew = false;
      const ids = new Set([...members].flatMap((m) => names(list[m] as { id: string; aliases: string[] })));
      for (let j = 0; j < list.length; j++) if (!members.has(j) && names(list[j] as { id: string; aliases: string[] }).some((n) => ids.has(n))) members.add(j), (grew = true);
    }
    for (const m of members) done.add(m);
    groups.push([...members].map((m) => (list[m] as { id: string }).id).sort());
  }
  return groups;
}

const isAtLeast = (a: string, b: string) => rankOf(a) >= rankOf(b);

export function define(tier: Tier) {
  test("CVSS: any vector scores 0 to 10 in tenths or not at all; complete ones always score, in any metric order", (t) =>
    check(
      t,
      tier,
      fc.property(fc.oneof(severityEntry, fc.record({ type: fc.anything(), score: fc.anything() })), v3, (entry, full) => {
        const score = cvssScore(entry);
        if (score !== null) assert.ok(Number.isFinite(score) && score >= 0 && score <= 10 && Math.round(score * 10) === score * 10, String(score));
        const base = cvssScore({ type: "CVSS_V3", score: full });
        assert.notEqual(base, null, full);
        const reordered = `CVSS:3.1/${full.slice(9).split("/").reverse().join("/")}`;
        assert.equal(cvssScore({ type: "CVSS_V3", score: reordered }), base);
        assert.ok(isAtLeast(scoreSeverity(base), scoreSeverity(Math.max(0, (base as number) - 0.1))));
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("severityOf: the most alarming rating the record states, MAL- with none is CRITICAL, and nothing stated is UNKNOWN", (t) =>
    check(
      t,
      tier,
      fc.property(osvRecord, (vuln) => {
        const got = severityOf(vuln);
        assert.ok(RANKED.includes(got), got);
        const all = ratings(vuln);
        for (const r of all) assert.ok(isAtLeast(got, r), `${got} is quieter than the stated ${r}`);
        if (all.length) assert.ok(all.includes(got), `${got} isn't one of ${all}`);
        else assert.equal(got, vuln.id.startsWith("MAL-") ? "CRITICAL" : "UNKNOWN");
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("fixedVersions: only the named npm package's fixes, once each, SemVer ones lowest first and the rest after", (t) =>
    check(
      t,
      tier,
      fc.property(
        fc.array(fc.record({ package: fc.record({ ecosystem: fc.constantFrom("npm", "PyPI"), name: fc.constantFrom("a", "b") }), ranges: fc.array(fc.record({ events: fc.array(fc.oneof(fc.record({ fixed: fc.constantFrom(...FIXES) }), fc.record({ introduced: fc.constant("0") }))) })) })),
        (affected) => {
          const got: string[] = fixedVersions({ affected }, "a");
          const want = new Set(affected.filter((x) => x.package.ecosystem === "npm" && x.package.name === "a").flatMap((x) => x.ranges.flatMap((r) => r.events.flatMap((e) => ("fixed" in e ? [e.fixed] : [])))));
          assert.deepEqual(new Set(got), want);
          assert.equal(got.length, want.size);
          const semver = got.filter((v) => parseVersion(v));
          assert.deepEqual(got.slice(0, semver.length), semver, "SemVer versions first");
          for (let i = 1; i < semver.length; i++) assert.ok(compareVersions(semver[i - 1] as string, semver[i] as string) <= 0);
        },
      ),
      { fast: 500, deep: 50_000 },
    ));

  test("mergeAdvisories: groups by shared ids, loses no package or fix, never quiets a rating, keeps repository claims out of curated fixes, and ignores order", (t) =>
    check(
      t,
      tier,
      fc.property(records, fc.nat(), (list, seed) => {
        const merged = mergeAdvisories(list);
        // Every record lands in exactly one advisory, together with exactly what it shares an id with.
        const groupOf = (id: string) => merged.filter((a: any) => a.id === id || a.aliases.includes(id));
        for (const r of list) assert.equal(groupOf(r.id).length, 1, r.id);
        const want = groupsOf(list).map((g) => [...new Set(g)].sort().join(" ")).sort();
        const got = merged.map((a: any) => [...new Set(list.filter((r) => r.id === a.id || a.aliases.includes(r.id)).map((r) => r.id))].sort().join(" ")).sort();
        assert.deepEqual(got, want);
        for (const advisory of merged) {
          const members = list.filter((r) => r.id === advisory.id || advisory.aliases.includes(r.id));
          assert.equal(advisory.severity, advisory.packages.length ? RANKED[Math.max(...advisory.packages.map((p: any) => rankOf(p.severity)))] : "UNKNOWN");
          for (const claim of advisory.packages) {
            const naming = members.filter((r) => r.packages.some((p) => p.pkg === claim.pkg));
            const fixes = (rs: typeof naming) => new Set(rs.flatMap((r) => r.packages.filter((p) => p.pkg === claim.pkg).flatMap((p) => p.fixed)));
            assert.deepEqual(new Set(claim.fixed), fixes(naming));
            assert.deepEqual(new Set(claim.curatedFixed), fixes(naming.filter((r) => r.sources[0] !== "github-repository")));
            for (const r of naming) assert.ok(isAtLeast(claim.severity, RANKED.includes(r.severity) ? r.severity : "UNKNOWN"), `${claim.pkg}: ${claim.severity} under ${r.severity}`);
          }
          assert.deepEqual(new Set(advisory.packages.map((p: any) => p.pkg)), new Set(members.flatMap((r) => r.packages.map((p) => p.pkg))));
        }
        const shuffled = [...list].sort((a, b) => ((a.id.length * 31 + a.sources[0]!.length + seed) % 7) - ((b.id.length * 31 + b.sources[0]!.length + seed) % 7));
        assert.deepEqual(mergeAdvisories(shuffled), merged, "the same records in another order");
        assert.deepEqual(mergeAdvisories([...list].reverse()), merged, "the same records reversed");
      }),
      { fast: 500, deep: 50_000 },
    ));

  test("completeAdvisories: decides only on a scan with no gaps", (t) =>
    check(
      t,
      tier,
      fc.property(records, fc.array(fc.string({ minLength: 1 }), { maxLength: 2 }), (list, gaps) => {
        const scan = { advisories: mergeAdvisories(list), sources: [], gaps };
        if (gaps.length) assert.throws(() => completeAdvisories(scan), /coverage is incomplete/);
        else assert.equal(completeAdvisories(scan), scan.advisories);
      }),
      { fast: 200, deep: 20_000 },
    ));

  test("Retry-After: a wait is never negative or NaN, delta-seconds are exact, anything else is null or a date", (t) =>
    check(
      t,
      tier,
      fc.property(fc.oneof(fc.string({ maxLength: 30 }), fc.nat().map(String), fc.date({ noInvalidDate: true }).map((d) => d.toUTCString()), fc.constant(`1${"0".repeat(400)}`)), fc.nat(), (value, now) => {
        const ms = retryAfterMs(value, now);
        if (ms === null) return;
        assert.ok(ms >= 0 && !Number.isNaN(ms), `${value} -> ${ms}`);
        if (/^\s*\d+\s*$/.test(value)) assert.equal(ms, Number(value.trim()) * 1000);
      }),
      { fast: 500, deep: 50_000 },
    ));
}
