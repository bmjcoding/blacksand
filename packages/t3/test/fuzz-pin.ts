// Properties of the version and pin parsers every trust decision rests on
// (lib/semver.mjs, lib/pin.mjs, lib/overrides.mjs), on generated inputs:
// SemVer precedence is a total order, ranges agree with themselves, a pin is
// exactly its documented shape, an evaluator's move can only go forward, and
// an accepted security override names a real package and a newer fix in its line.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import fc from "fast-check";

import { check, type Tier } from "../../../tools/fuzz.ts";
import { parseOverrides, parseToolOverrides } from "../lib/overrides.mjs";
import { backwardMove, compareRefs, isReleaseTag, validatePin } from "../lib/pin.mjs";
import { compareVersions, inRange, lineFloor, parseVersion, satisfies } from "../lib/semver.mjs";

const num = fc.oneof(fc.constantFrom("0", "1", "2", "10"), fc.bigInt({ min: 0n, max: 10n ** 25n }).map(String));
const ident = fc.oneof(num, fc.constantFrom("alpha", "beta", "rc", "x-1", "a-", "-"), fc.stringMatching(/^[0-9A-Za-z-]{1,6}$/).filter((s) => !/^0\d/.test(s)));
const version = fc
  .record({ major: num, minor: num, patch: num, pre: fc.array(ident, { maxLength: 3 }), build: fc.array(fc.stringMatching(/^[0-9A-Za-z-]{1,4}$/), { maxLength: 2 }) })
  .map(({ major, minor, patch, pre, build }) => `${major}.${minor}.${patch}${pre.length ? `-${pre.join(".")}` : ""}${build.length ? `+${build.join(".")}` : ""}`);
const sign = (n: number) => Math.sign(n);

/** Text near a version: the edits a typo or a hostile file makes. */
const nearVersion = fc.tuple(version, fc.constantFrom("", "v", "=", " ", "01.", "-", "+", ".0", "x")).map(([v, edit]) => (edit === "" ? v : edit === "v" || edit === "=" || edit === " " ? `${edit}${v}` : edit === "01." ? `01.${v}` : `${v}${edit}`));

const NIGHTLY = (n: number) => `v0.1.${n}-nightly.20260${(n % 9) + 1}1${n % 10}.${n}`;
const ref = fc.oneof(
  fc.tuple(fc.nat(3), fc.nat(9), fc.nat(9)).map(([a, b, c]) => ({ channel: "stable", ref: `v${a}.${b}.${c}` })),
  fc.nat(20).map((n) => ({ channel: "nightly", ref: NIGHTLY(n) })),
  fc.tuple(fc.nat(3), fc.nat(9), fc.integer({ min: 1, max: 28 }), fc.nat(5)).map(([a, b, d, n]) => ({ channel: "preview", ref: `v${a}.${b}.0-preview.202611${String(d).padStart(2, "0")}.${n}` })),
);
const sha = fc.stringMatching(/^[0-9a-f]{40}$/);
const tool = fc.tuple(fc.constantFrom("agent-device", "@s/tool", "x.y"), version.filter((v) => !v.includes("+"))).map(([n, v]) => `${n}@${v}`);

/** A pin.json validatePin must accept: each channel's release tag, commit and evaluation, device tools, and their locks with matching digests. */
const pin = fc
  .record({
    channels: fc.uniqueArray(fc.tuple(ref, sha, fc.uniqueArray(fc.stringMatching(/^[a-z][a-z0-9-]{0,8}$/), { maxLength: 2 })), { maxLength: 3, selector: ([r]) => r.channel }),
    tools: fc.uniqueArray(tool, { maxLength: 3 }),
    locks: fc.array(fc.string({ maxLength: 20 }), { maxLength: 3 }),
  })
  .map(({ channels, tools, locks }) => ({
    version: 1,
    channels: Object.fromEntries(channels.map(([r, s, leftOut]) => [r.channel, { ref: r.ref, sha: s, evaluatedAt: "2026-10-31T00:00:00.000Z", leftOut }])),
    deviceTools: tools,
    ...(locks.length && tools.length ? { deviceToolLocks: Object.fromEntries(tools.slice(0, locks.length).map((t, i) => [t, { lock: locks[i], sha256: createHash("sha256").update(locks[i] as string, "utf8").digest("hex") }])) } : {}),
  }));

/** One edit a stolen evaluator key or a careless hand might make to a valid pin; each must be refused. */
const breakPin = fc.constantFrom<[string, (p: any) => void]>(
  ["an unknown key", (p) => (p.extra = true)],
  ["version 2", (p) => (p.version = 2)],
  ["channels as a list", (p) => (p.channels = [])],
  ["an unknown channel", (p) => (p.channels.beta = { ref: "v1.0.0", sha: "0".repeat(40), evaluatedAt: "2026-10-31", leftOut: [] })],
  ["a stable ref on nightly", (p) => (p.channels.nightly = { ref: "v1.0.0", sha: "0".repeat(40), evaluatedAt: "2026-10-31", leftOut: [] })],
  ["a leading zero", (p) => (p.channels.stable = { ref: "v01.0.0", sha: "0".repeat(40), evaluatedAt: "2026-10-31", leftOut: [] })],
  ["a date that doesn't exist", (p) => (p.channels.nightly = { ref: "v0.1.0-nightly.20260230.1", sha: "0".repeat(40), evaluatedAt: "2026-10-31", leftOut: [] })],
  ["a short commit", (p) => (p.channels.stable = { ref: "v1.0.0", sha: "abc1234", evaluatedAt: "2026-10-31", leftOut: [] })],
  ["an uppercase commit", (p) => (p.channels.stable = { ref: "v1.0.0", sha: "A".repeat(40), evaluatedAt: "2026-10-31", leftOut: [] })],
  ["a bad evaluation date", (p) => (p.channels.stable = { ref: "v1.0.0", sha: "0".repeat(40), evaluatedAt: "soon", leftOut: [] })],
  ["a device tool without a version", (p) => p.deviceTools.push("agent-device")],
  ["a device tool twice", (p) => p.deviceTools.push(...p.deviceTools, ...(p.deviceTools.length ? [] : ["a@1.0.0", "a@1.0.0"]))],
  ["a lock that doesn't match its digest", (p) => (p.deviceToolLocks = { "a@1.0.0": { lock: "x", sha256: "0".repeat(64) } })],
);

export function define(tier: Tier) {
  test("SemVer: precedence is a total order, ignores build metadata, and a prerelease sorts before its release", (t) =>
    check(
      t,
      tier,
      fc.property(version, version, version, (a, b, c) => {
        assert.equal(compareVersions(a, a), 0);
        assert.equal(sign(compareVersions(a, b)) + sign(compareVersions(b, a)), 0, "antisymmetric");
        const [x, y, z] = [a, b, c].sort(compareVersions) as [string, string, string];
        assert.ok(compareVersions(x, y) <= 0 && compareVersions(y, z) <= 0 && compareVersions(x, z) <= 0);
        const plain = a.split("+")[0] as string;
        assert.equal(compareVersions(a, `${plain}+zz`), 0);
        if (plain.includes("-")) assert.ok(compareVersions(plain, plain.split("-")[0] as string) < 0);
        assert.ok(compareVersions(lineFloor(plain), plain) <= 0 || plain.includes("-"));
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("SemVer: text near a version parses only when it is one, and then reads back exactly", (t) =>
    check(
      t,
      tier,
      fc.property(nearVersion, (text) => {
        const parsed = parseVersion(text);
        if (!parsed) return;
        const back = `${parsed.major}.${parsed.minor}.${parsed.patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}${parsed.build ? `+${parsed.build}` : ""}`;
        assert.equal(back, text.replace(/^v/, ""));
        for (const part of [parsed.major, parsed.minor, parsed.patch, ...parsed.prerelease.filter((id: string) => /^\d+$/.test(id))]) assert.ok(part === "0" || !part.startsWith("0"), text);
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("npm ranges: for a release, installing (satisfies) and being affected (inRange) agree; a caret holds its own version", (t) =>
    check(
      t,
      tier,
      fc.property(version, version, fc.constantFrom("^", "~", ">=", "<=", ">", "<", "=", ""), (v, bound, op) => {
        const release = v.split(/[-+]/)[0] as string;
        const range = `${op}${bound.split("+")[0]}`;
        assert.equal(satisfies(release, range), inRange(release, range), `${release} ${range}`);
        assert.ok(satisfies(release, `^${release}`) && satisfies(release, `~${release}`) && satisfies(release, `${release} - ${release}`));
        assert.ok(inRange(v, `>=${v}`) && !inRange(v, `<${v}`));
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("pin.json: every well-formed pin is accepted and reads back unchanged; each malformed edit is refused", (t) =>
    check(
      t,
      tier,
      fc.property(pin, breakPin, (p, [, edit]) => {
        assert.deepEqual(validatePin(JSON.parse(JSON.stringify(p))), p);
        for (const { ref: r } of Object.values(p.channels) as Array<{ ref: string }>) assert.ok(isReleaseTag(r), r);
        const broken = structuredClone(p);
        edit(broken);
        assert.throws(() => validatePin(broken), /pin\.json is invalid/);
      }),
      { fast: 500, deep: 50_000 },
    ));

  test("pin moves: staying put or moving forward passes; rolling a channel back, dropping it, swapping its commit, or dropping a reviewed tool or lock doesn't", (t) =>
    check(
      t,
      tier,
      fc.property(pin, pin, (a, b) => {
        assert.equal(backwardMove(a, a), null);
        assert.equal(backwardMove(null, a), null);
        for (const channel of Object.keys(a.channels)) {
          const next = b.channels[channel];
          const merged = { ...a, channels: { ...a.channels, [channel]: next ?? undefined } };
          if (!next) {
            delete merged.channels[channel];
            assert.match(backwardMove(a, merged) ?? "", /drops the/);
            continue;
          }
          const previous = a.channels[channel] as { ref: string; sha: string };
          const order = compareRefs(next.ref, previous.ref);
          const why = backwardMove(a, merged);
          if (order < 0) assert.match(why ?? "", /moves .* back/);
          else if (order === 0 && next.sha !== previous.sha) assert.match(why ?? "", /changes .*'s commit/);
          else assert.equal(why, null);
        }
        if (a.deviceTools.length) assert.match(backwardMove(a, { ...a, deviceTools: a.deviceTools.slice(1) }) ?? "", /removes reviewed device tools/);
        const [locked] = Object.keys(a.deviceToolLocks ?? {});
        if (locked) {
          const { [locked]: _gone, ...rest } = a.deviceToolLocks as object as { [tool: string]: unknown };
          assert.match(backwardMove(a, { ...a, deviceToolLocks: rest }) ?? "", /removes .*reviewed dependency lock/);
        }
      }),
      { fast: 500, deep: 50_000 },
    ));

  test("security overrides: an accepted entry is name@version with a newer fix in the same line, and no two device tool entries raise one line", (t) =>
    check(
      t,
      tier,
      fc.property(
        fc.array(
          fc.record({
            name: fc.constantFrom("lodash", "@s/pkg", "", "@s", "UPPER", "a b"),
            at: fc.constantFrom("@", "", "@@"),
            found: fc.oneof(version, nearVersion, fc.constantFrom("1.2.3", "0.3.1")),
            fix: fc.oneof(version, nearVersion),
            advisories: fc.oneof(fc.constant(["GHSA-2222-3333-4444"]), fc.constant([]), fc.constant(["not an id"])),
          }),
          { maxLength: 3 },
        ),
        (entries) => {
          // Half the fixes are the next patch of what was found, so entries get past the line check and reach the selector's.
          const next = (v: string, fix: string) => (fix.length % 2 && /^\d+\.\d+\.\d+$/.test(v) ? v.replace(/\d+$/, (n) => String(BigInt(n) + 1n)) : fix);
          const overrides = entries.map((e) => ({ selector: `${e.name}${e.at}${e.found}`, version: next(e.found, e.fix), advisories: e.advisories }));
          for (const parse of [parseOverrides, parseToolOverrides]) {
            let accepted;
            try {
              accepted = parse(JSON.stringify(parse === parseOverrides ? { overrides } : { overrides: [], deviceTools: overrides }));
            } catch {
              continue;
            }
            const lines = new Set<string>();
            for (const o of accepted) {
              const at = o.selector.lastIndexOf("@");
              const [name, found] = [o.selector.slice(0, at), o.selector.slice(at + 1)];
              assert.ok(at > 0 && /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name), `selector ${o.selector} names no package`);
              assert.ok(parseVersion(found) && parseVersion(o.version) && !found.startsWith("v") && !o.version.startsWith("v"), o.selector);
              assert.ok(lineFloor(found) === lineFloor(o.version) && compareVersions(o.version, found) > 0, `${o.selector} -> ${o.version}`);
              if (parse === parseToolOverrides) {
                assert.ok(o.advisories.length > 0);
                const line = `${name} ${lineFloor(o.version)}`;
                assert.ok(!lines.has(line), line);
                lines.add(line);
              }
            }
          }
        },
      ),
      { fast: 1000, deep: 100_000 },
    ));
}
