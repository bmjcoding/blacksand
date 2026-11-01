// node --test test/: the decisions the commit-trust verifier rests on, made by
// the old verifier (lib/selfupdate.mjs, lib/pin.mjs) and by the new one
// (src/trust), over a few hundred generated inputs each: signature kinds,
// pin.json's shape and forward moves, an evaluator commit's bounds and what a
// tip's pin rests on. No git: the signed histories both verifiers walk, and who
// signed as ssh-keygen reads the list, are in test/trust-port.deep.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

import { NIGHTLY, pin } from "./trust-fixtures.mjs";

const old = { ...(await import("../lib/selfupdate.mjs")), ...(await import("../lib/pin.mjs")) };
const fresh = {
  ...(await import("../../../src/trust/signers.ts")),
  ...(await import("../../../src/trust/pin.ts")),
  ...(await import("../../../src/trust/evaluator.ts")),
  ...(await import("../../../src/trust/history.ts")),
};

function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = prng(20261031);
const pick = (items) => items[Math.floor(random() * items.length)];
const some = (items, most = 4) => Array.from({ length: Math.floor(random() * (most + 1)) }, () => pick(items));

/** What calling `fn` came to: { value } or { threw: its message }. */
const outcome = (fn) => {
  try {
    return { value: fn() };
  } catch (error) {
    return { threw: error.message };
  }
};

const SHA = (n) => String(n).repeat(40).slice(0, 40);
const RELEASES = [NIGHTLY(3904), NIGHTLY(3917), NIGHTLY(3940), "v0.1.6", "v00.1.6", "v0.1.6-nightly.20261332.1", "v0.1.6-preview.20261030.1"];
const TOOLS = ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0", "@scope/tool@2.0.0", "tool@v1.0.0", "tool@latest", "constructor@1.0.0"];

/** A pin.json, mostly valid, sometimes bent out of shape in one of the ways a hand or a stolen key might. */
function pinText() {
  const value = JSON.parse(pin(pick(RELEASES.slice(0, 3)), SHA(pick([1, 2, 3])), some(TOOLS.slice(0, 3), 2).filter((t, i, all) => all.indexOf(t) === i)));
  switch (pick(["valid", "valid", "valid", "bend"])) {
    case "valid":
      return JSON.stringify(value);
    default: {
      const bend = pick([
        () => (value.extra = 1),
        () => delete value.version,
        () => (value.version = "1"),
        () => (value.channels = []),
        () => (value.channels.nightly = null),
        () => (value.channels.nightly = "x"),
        () => (value.channels.stable = value.channels.nightly),
        () => (value.channels.preview = { ...value.channels.nightly, ref: pick(RELEASES) }),
        () => (value.channels.nightly.ref = pick(RELEASES)),
        () => (value.channels.nightly.sha = "abc"),
        () => (value.channels.nightly.evaluatedAt = pick([0, null, "not a date", {}])),
        () => (value.channels.nightly.leftOut = pick([[null], ["Upper"], "x", [["ab"]]])),
        () => (value.deviceTools = some(TOOLS, 3)),
        () => (value.deviceTools = [1]),
        () => (value.deviceToolLocks = pick([[], null, { "tool@1.0.0": { sha256: "0".repeat(64), lock: "x" } }, { "trust-su-tool@1.1.0": { lock: "x" } }])),
        () => (value.channels = {}),
        () => (value.__proto__x = 1),
      ]);
      bend();
      return JSON.stringify(value);
    }
  }
}

test("signature kinds: both verifiers read every generated commit header alike, but for the cases decided in the new one's favour", () => {
  const armors = ["-----BEGIN SSH SIGNATURE-----", "-----BEGIN PGP SIGNATURE-----", "-----BEGIN SIGNED MESSAGE-----", "-----BEGIN SOMETHING-----", "", " -----BEGIN SSH SIGNATURE----- ", "-----BEGIN SSH SIGNATURE-----\r", "constructor", "__proto__", "toString", "hasOwnProperty"];
  const decided = { prototype: 0, untrimmed: 0, separator: 0 };
  let agreed = 0;
  for (let i = 0; i < 400; i++) {
    const headers = some([...armors.map((a) => `gpgsig ${a}`), ...armors.map((a) => `gpgsig-sha256 ${a}`), "gpgsig", "tree abc", "parent def", `author t <t@example.com> 1 +0000${pick(["\r", "\u2028", "\u2029"])}gpgsig ${armors[0]}`], 3);
    const raw = `${["tree x", ...headers].join("\n")}${pick(["\n\nmessage\n", "\n\ngpgsig -----BEGIN SSH SIGNATURE----- in the message\n", ""])}`;
    const [a, b] = [old.signatureKind(raw), fresh.signatureKind(raw)];
    if (a === b) agreed++;
    // The old one looked the armor up in an object literal, and found Object's own members.
    else if (typeof a !== "string" && a !== null) {
      assert.equal(b, "unknown", raw);
      decided.prototype++;
    }
    // It trimmed the armor; the new one matches it exactly.
    else if (b === "unknown" && headers.some((h) => /^gpgsig(?:-sha256)? /.test(h) && h.replace(/^gpgsig(?:-sha256)? /, "") !== h.replace(/^gpgsig(?:-sha256)? /, "").trim())) decided.untrimmed++;
    // Its multiline regex took a CR, U+2028 or U+2029 for a line break; git doesn't.
    else if (/[\r\u2028\u2029]gpgsig/.test(raw)) decided.separator++;
    else assert.equal(b, a, JSON.stringify(raw));
  }
  assert.ok(agreed > 250 && Object.values(decided).every((n) => n > 0), JSON.stringify({ agreed, decided }));
});

test("pin.json: both verifiers accept, refuse and explain every generated pin alike, and judge every generated move alike", () => {
  let valid = 0;
  for (let i = 0; i < 400; i++) {
    const text = pinText();
    const [a, b] = [outcome(() => old.validatePin(JSON.parse(text))), outcome(() => fresh.validatePin(JSON.parse(text)))];
    assert.deepEqual(b, a, text);
    valid += "value" in a;
  }
  assert.ok(valid > 100, `${valid} valid pins`);
  for (let i = 0; i < 400; i++) {
    const [x, y] = [pick(RELEASES), pick(RELEASES)];
    assert.deepEqual(outcome(() => fresh.compareRefs(x, y)), outcome(() => old.compareRefs(x, y)), `${x} ${y}`);
    const channel = pick([null, "nightly", "preview", "stable"]);
    assert.equal(fresh.isReleaseTag(x, channel), old.isReleaseTag(x, channel), `${x} ${channel}`);
    const [before, after] = [outcome(() => old.validatePin(JSON.parse(pinText()))), outcome(() => old.validatePin(JSON.parse(pinText())))];
    if (!("value" in before && "value" in after)) continue;
    assert.deepEqual(outcome(() => fresh.backwardMove(before.value, after.value)), outcome(() => old.backwardMove(before.value, after.value)));
    assert.deepEqual([...fresh.addedApprovals(before.value, after.value)], [...old.addedApprovals(before.value, after.value)]);
  }
});

test("evaluator commits: both verifiers hold every generated commit shape to the same bounds, in the root layout", () => {
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const shape = {
      parents: pick([1, 1, 1, 0, 2]),
      files: pick([["pin.json"], ["pin.json"], [], ["README.md"], ["pin.json", "README.md"], [".allowed_signers", "pin.json"], ["packages/t3/pin.json"], ["tooling/t3code/pin.json"]]),
      after: pick([pinText(), pinText(), null, "{"]),
      before: pick([pinText(), pinText(), null, "{"]),
      afterMode: pick(["100644", "100644", "100644", "120000", "100755"]),
      beforeMode: pick(["100644", "100644", "100644", "120000"]),
    };
    const a = outcome(() => old.botShape(shape));
    assert.deepEqual(outcome(() => fresh.evaluatorShape({ ...shape, pinFile: "pin.json" })), a, JSON.stringify(shape));
    seen.add(a.value === null ? "in bounds" : String(a.value ?? a.threw).split(" ")[0]);
  }
  assert.ok(seen.size >= 8, [...seen].join(", "));
});

test("what a tip's pin rests on: both verifiers pick the same trusted commit and evaluator commits along every generated line", () => {
  for (let i = 0; i < 300; i++) {
    const chain = Array.from({ length: 1 + Math.floor(random() * 8) }, (_, n) => `c${n}`);
    const of = new Map(chain.map((sha) => [sha, { principal: pick([old.BOT_PRINCIPAL, "owner@example.com", "second@example.com"]), pinChanged: random() < 0.5 }]));
    assert.deepEqual(fresh.pinBasis(chain, of), old.pinBasis(chain, of), JSON.stringify([...of]));
  }
  assert.equal(fresh.EVALUATOR, old.BOT_PRINCIPAL);
});
