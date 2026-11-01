// node --test test/: hourly self-update (lib/selfupdate.mjs), end to end, in
// throwaway repositories signed with throwaway SSH keys: what it takes from
// origin's main, and the gates this machine works out again for an evaluator
// pin, however its key was used. Upstream is a local repository with release
// tags; npm and the advisory sources are mocked. Nothing here touches this clone
// or ~/.ssh. (test/commit-trust.deep.test.mjs: the history walk shared with a fresh
// clone's check; test/git-isolation.deep.test.mjs: where main is fetched from.)
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { DAY, NIGHTLY, OLD_DEPS, ago, fixture, forgeSigned, mockFetch, npm, npmRoutes, pin, run } from "./trust-fixtures.mjs";

const { principalsOf, signatureKind } = await import("../lib/selfupdate.mjs");

const noAdvisories = async () => [];
const quiet = { "index.js": "connect('ws://localhost:1')" };

// ------------------------------------------------------------ signatures --

test("signature kinds and allowed-signers principals are read exactly", () => {
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN SSH SIGNATURE-----\n a\n -----END SSH SIGNATURE-----\n\nmsg"), "ssh");
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN PGP SIGNATURE-----\n a\n\nmsg"), "openpgp");
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN SIGNED MESSAGE-----\n a\n\nmsg"), "x509");
  assert.equal(signatureKind("tree x\n\ngpgsig -----BEGIN SSH SIGNATURE----- in the message"), null);
  assert.equal(signatureKind("tree x\ngpgsig -----BEGIN SSH SIGNATURE-----\ngpgsig-sha256 -----BEGIN SSH SIGNATURE-----\n\n"), "unknown");
  assert.deepEqual([...principalsOf('# c\na@x,b@y namespaces="git" ssh-ed25519 AAAA\n"c d" ssh-ed25519 BBBB\n')], ["a@x", "b@y", "c d"]);
});

test("an owner-signed commit fast-forwards to exactly the verified commit", async () => {
  const f = fixture();
  const tip = f.commit(f.owner, { "lib/rules.mjs": "// a rule fix\n" }, "rule fix");
  assert.equal(await f.update(), "updated");
  assert.equal(f.head(), tip);
  assert.match(f.logs.at(-1), /self-updated t3blackout to/);
  assert.equal(await f.update(), "skipped", "nothing new");
});

test("unsigned, unknown-key, OpenPGP and X.509 commits are refused", async () => {
  for (const make of [
    (f) => f.commit(null, { "lib/x.mjs": "evil\n" }, "unsigned"),
    (f) => f.commit(f.stranger, { "lib/x.mjs": "evil\n" }, "stranger"),
    (f) => forgeSigned(f, "PGP SIGNATURE"),
    (f) => forgeSigned(f, "SIGNED MESSAGE"),
  ]) {
    const f = fixture();
    const before = f.head();
    make(f);
    assert.equal(await f.update(), "refused");
    assert.equal(f.head(), before);
    assert.match(f.logs.at(-1), /isn't signed|not an SSH key|isn't signed by a key/);
  }
});

test("a rewritten origin and a dirty clone are left alone", async () => {
  const f = fixture();
  const before = f.head();
  run(f.origin, ["commit", "-q", "--amend", "--no-gpg-sign", "-m", "rewritten"]);
  assert.equal(await f.update(), "refused");
  assert.match(f.logs.at(-1), /isn't a fast-forward/);
  fs.writeFileSync(path.join(f.clone, "README.md"), "local edit\n");
  assert.equal(await f.update(), "skipped");
  assert.equal(f.head(), before);
});

// ------------------------------------------------- the evaluator's bounds --

test("an evaluator commit is taken only when it moves pin.json forward and changes nothing else", async () => {
  const f = fixture();
  const base = run(f.origin, ["rev-parse", "HEAD"]);
  const nightly = (edit) => {
    const value = JSON.parse(pin(NIGHTLY(3917), f.shas[1]));
    edit(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  };
  const cases = [
    ["pin and more", () => f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]), "lib/rules.mjs": "evil\n" }, "pin and more"), /not just pin\.json/],
    ["approve only", () => f.commit(f.bot, { "pin.json": pin(NIGHTLY(3904), f.shas[0], ["trust-su-tool@1.0.0", "trust-su-tool@9.9.9"]) }, "approve"), /approves device tools trust-su-tool@9\.9\.9 without moving a channel forward/],
    ["lock only", () => f.commit(f.bot, { "pin.json": pin(NIGHTLY(3904), f.shas[0], ["trust-su-tool@1.0.0"], ["trust-su-tool@1.0.0"]) }, "lock"), /approves device tools trust-su-tool@1\.0\.0 without moving a channel forward/],
    ["an invalid pin", () => f.commit(f.bot, { "pin.json": nightly((value) => (value.channels.nightly.ref = "main")) }, "bad pin"), /^self-update refused: evaluator commit \w+ leaves .*isn't a release tag/],
    ["a channel's first pin", () => f.commit(f.bot, { "pin.json": nightly((value) => (value.channels.preview = { ref: "v0.1.6-preview.20261030.1", sha: f.shas[2], evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] })) }, "add preview"), /adds a preview pin; a channel's first pin needs a commit you sign/],
    ["a dropped tool", () => f.commit(f.bot, { "pin.json": nightly((value) => (value.deviceTools = [])) }, "drop tools"), /removes reviewed device tools/],
    [
      "a rollback",
      () => {
        f.commit(f.owner, { "pin.json": pin(NIGHTLY(3940), f.shas[2]) }, "owner pins 3940");
        return f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "back to 3917");
      },
      /moves nightly back/,
    ],
    [
      "the first pin",
      () => {
        run(f.origin, ["rm", "-q", "pin.json"]);
        f.commit(f.owner, {}, "no pin");
        return f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "first pin");
      },
      /creates pin\.json; its first version needs a commit you sign/,
    ],
  ];
  globalThis.fetch = async () => assert.fail("refused on the commit alone, before any network");
  for (const [what, make, why] of cases) {
    run(f.origin, ["reset", "-q", "--hard", base]);
    make();
    assert.equal(await f.update(), "refused", what);
    assert.equal(f.head(), base, what);
    assert.match(f.logs.at(-1), why, what);
  }
});

// ------------------------------------------------------- tags and commits --

test("an evaluator pin of a real, newer upstream tag is taken", async () => {
  const f = fixture();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  assert.equal(await f.update(), "updated");
  assert.equal(f.head(), tip);
});

test("an evaluator pin of a tag upstream doesn't have, or of another commit, is refused", async () => {
  for (const [ref, sha, why] of [
    [NIGHTLY(3999), 2, /upstream's v0\.1\.6-nightly\.20261030\.3999 is missing/],
    ["v99.0.0-nightly.20991231.1", 2, /is missing/],
    [NIGHTLY(3940), 0, /but upstream's .*3940 is /],
  ]) {
    const f = fixture();
    const before = f.head();
    f.commit(f.bot, { "pin.json": pin(ref, f.shas[sha]) }, "Pin nightly");
    assert.equal(await f.update(), "refused");
    assert.equal(f.head(), before);
    assert.match(f.logs.at(-1), why);
  }
});

test("the release this clone's pin names is trusted by its commit: its tag moving or going upstream holds nothing; the release moved to is checked by its tag", async () => {
  for (const [what, change, result] of [
    ["the old tag moved", (f) => run(f.upstream, ["tag", "-f", NIGHTLY(3904), f.shas[2]]), "updated"],
    ["the old tag deleted", (f) => run(f.upstream, ["tag", "-d", NIGHTLY(3904)]), "updated"],
    ["the new tag moved", (f) => run(f.upstream, ["tag", "-f", "-a", "-m", "moved", NIGHTLY(3917), f.shas[2]]), "refused"],
  ]) {
    const f = fixture();
    const before = f.head();
    const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
    change(f);
    assert.equal(await f.update({ advisories: noAdvisories }), result, `${what}: ${f.logs.join("\n")}`);
    assert.equal(f.head(), result === "updated" ? tip : before, what);
    if (result === "refused") assert.match(f.logs.at(-1), /upstream's v0\.1\.6-nightly\.20261030\.3917 is /);
  }
});

test("an owner-signed pin.json after an evaluator commit vouches for it, so a bad evaluator pin doesn't wedge the update; one that leaves pin.json alone vouches for nothing", async () => {
  const f = fixture();
  // Alone, this is refused: upstream's 3940 is another commit.
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3940), f.shas[0]) }, "stolen-key pin");
  assert.equal(await f.update(), "refused");
  const tip = f.commit(f.owner, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "owner repins");
  globalThis.fetch = async () => assert.fail("the owner's pin needs no npm check");
  assert.equal(await f.update(), "updated");
  assert.equal(f.head(), tip);
  const g = fixture();
  g.commit(g.bot, { "pin.json": pin(NIGHTLY(3940), g.shas[0]) }, "stolen-key pin");
  g.commit(g.owner, { "lib/rules.mjs": "// a rule fix\n" }, "rule fix");
  assert.equal(await g.update(), "refused");
});

// ------------------------------------------------------------ dependencies --

test("an evaluator pin whose release adds a dependency an hour old is held, and taken once it's old enough", async () => {
  const young = "sha512-eW91bmc=";
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, "trust-young@1.0.0": young }, OLD_DEPS] });
  const before = f.head();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch(npmRoutes({ "trust-young": { "1.0.0": { publishedAt: ago(1 / 24), integrity: young } } }));
  assert.equal(await f.update({ advisories: noAdvisories }), "held");
  assert.equal(f.head(), before, "nothing of the update is taken");
  assert.match(f.logs.at(-1), /self-update held: .*adds dependencies under 3 days old over v0\.1\.6-nightly\.20261030\.3904.*trust-young@1\.0\.0/);
  // Three days on, the same pin passes the same gate.
  assert.equal(await f.update({ advisories: noAdvisories, now: Date.now() + 3 * DAY }), "updated");
  assert.equal(f.head(), tip);
});

test("the fast lane comes from the trusted release's own lockfile: a fix for an advisory against it is taken", async () => {
  const [old, fixed] = ["sha512-b2xk", "sha512-Zml4"];
  const f = fixture({ locks: [{ ...OLD_DEPS, "trust-vuln@1.0.0": old }, { ...OLD_DEPS, "trust-vuln@1.0.1": fixed }, OLD_DEPS] });
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch({
    ...npmRoutes({ "trust-vuln": { "1.0.0": { publishedAt: ago(30), integrity: old }, "1.0.1": { publishedAt: ago(1 / 24), integrity: fixed } } }),
    // The fix itself has no advisory open against it.
    "https://api.osv.dev/v1/querybatch": () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
  });
  const seen = [];
  const advisories = async (packages) => {
    seen.push(packages);
    return packages.includes("trust-vuln@1.0.0") ? [{ id: "GHSA-r2r2-r2r2-r2r2", severity: "HIGH", packages: [{ pkg: "trust-vuln@1.0.0", fixed: ["1.0.1"] }] }] : [];
  };
  assert.equal(await f.update({ advisories }), "updated");
  assert.equal(f.head(), tip);
  // Asked about upstream's previous release as its lockfile and device tool pins have it, then
  // (the same sources) whether the fix itself is still flagged.
  assert.deepEqual(seen, [["trust-su-dep@1.0.0", "trust-su-tool@1.0.0", "trust-vuln@1.0.0"], ["trust-vuln@1.0.1"]]);
  assert.ok(f.logs.some((line) => /fast lane: trust-vuln@1\.0\.1: fixes GHSA-r2r2-r2r2-r2r2 \(publisher maintainer/.test(line)));
});

test("a predecessor the trusted release doesn't have can't open the fast lane", async () => {
  // Upstream's previous release never had trust-new; nothing the evaluator
  // writes can make this machine believe it did.
  const fresh = "sha512-bmV3";
  const f = fixture({ locks: [OLD_DEPS, { ...OLD_DEPS, "trust-new@1.0.1": fresh }, OLD_DEPS] });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  mockFetch({
    ...npmRoutes({ "trust-new": { "1.0.0": { publishedAt: ago(4), integrity: "sha512-b2xk" }, "1.0.1": { publishedAt: ago(1 / 24), integrity: fresh } } }),
    "https://api.osv.dev/v1/querybatch": () => new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
  });
  const seen = [];
  // Even told of an advisory against 1.0.0, nothing vouches for 1.0.1's publisher:
  // the usual publishers are those of versions the trusted release itself uses.
  const advisories = async (packages) => {
    seen.push(...packages);
    return [{ id: "GHSA-fake-fake-fake", severity: "HIGH", packages: [{ pkg: "trust-new@1.0.0", fixed: ["1.0.1"] }] }];
  };
  assert.equal(await f.update({ advisories }), "held");
  assert.equal(f.head(), before);
  assert.ok(!seen.includes("trust-new@1.0.0"));
});

test("a version whose bytes changed, that comes from outside the registry, or whose locked integrity isn't the registry's is refused", async () => {
  for (const [what, lock, routes, why] of [
    ["bytes changed", { "trust-su-dep@1.0.0": "sha512-ZXZpbA==" }, null, /changes or misstates dependencies' bytes: trust-su-dep@1\.0\.0 \(resolved to sha512-ZXZpbA==, not sha512-b2xk as before\)/],
    ["a tarball URL", { "trust-su-dep@1.0.0": { integrity: "sha512-b2xk", tarball: "http://127.0.0.1:9/is-number.tgz" } }, null, /trust-su-dep@1\.0\.0 is resolved from http:\/\/127\.0\.0\.1:9\/is-number\.tgz, not the npm registry/],
    [
      "not the registry's",
      { ...OLD_DEPS, "trust-swap@2.0.0": "sha512-bm90IHRoZSByZWdpc3RyeQ==" },
      npmRoutes({ "trust-swap": { "2.0.0": { publishedAt: ago(30), integrity: "sha512-cmVnaXN0cnk=" } } }),
      /trust-swap@2\.0\.0 \(locked as sha512-bm90IHRoZSByZWdpc3RyeQ==, but the registry's tarball is sha512-cmVnaXN0cnk=\)/,
    ],
  ]) {
    const f = fixture({ locks: [OLD_DEPS, lock, OLD_DEPS] });
    const before = f.head();
    f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
    if (routes) mockFetch(routes);
    else globalThis.fetch = async () => assert.fail("nothing was added, so nothing needs npm");
    assert.equal(await f.update({ advisories: noAdvisories }), "refused", what);
    assert.equal(f.head(), before, what);
    assert.match(f.logs.at(-1), why, what);
  }
});

test("unreachable npm or upstream postpones the update; a tool with no reviewed predecessor is refused", async () => {
  let f = fixture();
  let before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1]) }, "Pin nightly");
  assert.equal(await f.update({ upstream: path.join(f.dir, "no-such-upstream") }), "skipped");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /couldn't check the tags evaluator commit \w+ pins upstream/);

  f = fixture({ knownTools: "trust-su-net@1.0.0" });
  before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-net@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  globalThis.fetch = async () => new Response("bad request", { status: 400 });
  assert.equal(await f.update({ isKnownHost: () => false }), "skipped");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /couldn't review the device tools/);

  f = fixture();
  before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-new@2.0.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  assert.equal(await f.update({ isKnownHost: () => false }), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /no reviewed version to compare against/);
});

// ------------------------------------------------------------ device tools --

test("a device tool the evaluator approves is reviewed here, and FETCH_HEAD swapped mid-check isn't merged", async () => {
  const f = fixture();
  const tip = f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0"]) }, "Pin nightly");
  // A second, unsigned commit on another branch: a concurrent fetch writes it to FETCH_HEAD.
  run(f.origin, ["checkout", "-q", "-b", "evil"]);
  const evil = f.commit(null, { "lib/x.mjs": "evil\n" }, "unsigned");
  let swapped = false;
  mockFetch(npm("trust-su-tool", { "1.0.0": { files: quiet, publishedAt: ago(30) }, "1.1.0": { files: quiet, publishedAt: ago(5) } }), () => {
    if (swapped) return;
    swapped = true;
    run(f.clone, ["fetch", "-q", "origin", "evil"]);
  });
  assert.equal(await f.update({ isKnownHost: () => false }), "updated");
  assert.ok(swapped);
  assert.equal(run(f.clone, ["rev-parse", "FETCH_HEAD"]), evil);
  assert.equal(f.head(), tip, "the verified commit, not FETCH_HEAD");
});

test("an approved tool whose dependency closure fails review is refused", async () => {
  const f = fixture({ knownTools: "trust-su-deps@1.0.0" });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-deps@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  mockFetch(npm("trust-su-deps", { "1.0.0": { files: quiet, publishedAt: ago(30) }, "1.1.0": { files: quiet, publishedAt: ago(5) } }));
  const seen = [];
  const reviewClosure = async (tool, previous) => {
    seen.push([tool, previous]);
    return { ok: false, pin: tool, reasons: ["dependency helper@2.0.0: new network hosts: sink.example.net"], notes: [] };
  };
  assert.equal(await f.update({ isKnownHost: () => false, reviewClosure }), "refused");
  assert.deepEqual(seen, [["trust-su-deps@1.1.0", "trust-su-deps@1.0.0"]]);
  assert.match(f.logs.at(-1), /fails review here: dependency helper@2\.0\.0: new network hosts/);
  assert.equal(f.head(), before);
});

test("an approval or lock for a tool the release it moves to doesn't pin is refused before any review", async () => {
  for (const [release, sha, tools, locked, stray] of [
    [3917, 1, ["trust-su-stray@1.0.0", "trust-su-tool@1.0.0"], undefined, "trust-su-stray@1.0.0"],
    // Release 3940 pins only trust-su-tool@1.1.0; this locks trust-su-deps@1.0.0 too.
    [3940, 2, ["trust-su-tool@1.0.0"], ["trust-su-deps@1.0.0"], "trust-su-deps@1.0.0"],
  ]) {
    const f = fixture({ knownTools: "trust-su-stray@1.0.0\ntrust-su-deps@1.0.0" });
    const before = f.head();
    f.commit(f.bot, { "pin.json": pin(NIGHTLY(release), f.shas[sha], tools, locked) }, "Pin nightly");
    globalThis.fetch = async () => assert.fail("no review should run");
    assert.equal(await f.update({ isKnownHost: () => false }), "refused");
    assert.equal(f.head(), before);
    assert.match(f.logs.at(-1), new RegExp(`approves ${stray.replaceAll(".", "\\.")}, which v0\\.1\\.6-nightly\\.20261030\\.${release} doesn't pin`));
  }
});

test("an approved tool that reaches a host the repo doesn't know is refused", async () => {
  const f = fixture({ knownHosts: "api.vendor.dev", knownTools: "trust-su-host@1.0.0" });
  const before = f.head();
  f.commit(f.bot, { "pin.json": pin(NIGHTLY(3917), f.shas[1], ["trust-su-host@1.1.0", "trust-su-tool@1.0.0"]) }, "Pin nightly");
  mockFetch(
    npm("trust-su-host", {
      "1.0.0": { files: { "index.js": "fetch('https://updates.vendor.dev/check')" }, publishedAt: ago(30) },
      "1.1.0": { files: { "index.js": "fetch('https://updates.vendor.dev/check'); fetch('https://api.vendor.dev/v2'); fetch('https://telemetry.vendor.dev/t')" }, publishedAt: ago(5) },
    }),
  );
  // Hosts are judged against lib/known-hosts.txt as committed before the evaluator's commit.
  assert.equal(await f.update(), "refused");
  assert.equal(f.head(), before);
  assert.match(f.logs.at(-1), /trust-su-host@1\.1\.0, which fails review here: new network hosts: telemetry\.vendor\.dev$/);
});
