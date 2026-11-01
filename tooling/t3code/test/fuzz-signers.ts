// Properties of the commit-signature readers in lib/selfupdate.mjs:
// signatureKind (which kind of signature a raw commit carries) and
// principalsOf (who an allowed-signers file names). Neither verifies a
// signature: ssh-keygen does, through git. What they must do is not be fooled
// by a commit message or a header's continuation lines, and never leave out a
// principal ssh-keygen would accept, which would refuse the owner's own
// commits. The deep tier checks principalsOf against ssh-keygen itself.

import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { check, type Tier } from "../../../scripts/fuzz.ts";

const { principalsOf, signatureKind } = await import("../lib/selfupdate.mjs");

const ARMOR = { ssh: "-----BEGIN SSH SIGNATURE-----", openpgp: "-----BEGIN PGP SIGNATURE-----", x509: "-----BEGIN SIGNED MESSAGE-----" } as const;
type Kind = keyof typeof ARMOR | "unknown";

/** A free-text line: anything but a line break, with the words that matter mixed in. */
const textLine = fc.oneof(fc.string({ maxLength: 30 }).map((s) => s.replace(/\n/g, " ")), fc.constantFrom("gpgsig -----BEGIN SSH SIGNATURE-----", "gpgsig-sha256 x", "", " gpgsig y"));

/** A header that carries a signature: its armour line, then continuation lines (each starting with a space). */
const signature = fc.record({ name: fc.constantFrom("gpgsig", "gpgsig-sha256"), kind: fc.constantFrom<Kind>("ssh", "openpgp", "x509", "unknown"), body: fc.array(textLine, { maxLength: 3 }) });

/** A raw commit object: ordinary headers (some with continuations that mention gpgsig), any number of signature headers, then the message. */
const commit = fc.record({
  before: fc.array(fc.constantFrom("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904", "parent 0000000000000000000000000000000000000000", "author A <a@x> 0 +0000", "committer A <a@x> 0 +0000", "mergetag object 1\n type commit\n gpgsig -----BEGIN SSH SIGNATURE-----", "encoding UTF-8"), { maxLength: 4 }),
  signatures: fc.array(signature, { maxLength: 3 }),
  after: fc.array(fc.constantFrom("committer A <a@x> 0 +0000", "x-extra value\n gpgsig continued"), { maxLength: 2 }),
  message: fc.array(textLine, { maxLength: 4 }),
});

function raw(c: { before: string[]; signatures: Array<{ name: string; kind: Kind; body: string[] }>; after: string[]; message: string[] }): string {
  const sig = (s: { name: string; kind: Kind; body: string[] }) => [`${s.name} ${s.kind === "unknown" ? "-----BEGIN SOMETHING-----" : ARMOR[s.kind]}`, ...s.body.map((line) => ` ${line}`)].join("\n");
  return `${[...c.before, ...c.signatures.map(sig), ...c.after].join("\n")}\n\n${c.message.join("\n")}`;
}

// ------------------------------------------------------ allowed signers --

/** A principal as written: plain (no space, comma or quote), or one that needs quotes. */
const plainPrincipal = fc.stringMatching(/^[A-Za-z0-9@._+*?!-]{1,12}$/).filter((p) => !p.startsWith("#"));
const spacedPrincipal = fc.stringMatching(/^[A-Za-z0-9@._-]{1,5}(?: [A-Za-z0-9@._-]{1,5}){1,2}$/);
const OPTIONS = ["", 'namespaces="git"', 'namespaces="git,file"', "cert-authority", 'valid-after="20200101"'];
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHf7l0gZQ0xYw1oT0b8bXqVwz1H1r0d8VqvJm9wCjX1y";

export interface SignerLine {
  principals: string[];
  quoted: boolean;
  options: string;
}

/** An allowed-signers entry: its principals, quoted or not, any options, a key, maybe a comment; indented or not. */
export const signerLine: fc.Arbitrary<SignerLine> = fc.oneof(
  fc.record({ principals: fc.array(plainPrincipal, { minLength: 1, maxLength: 3 }), quoted: fc.boolean(), options: fc.constantFrom(...OPTIONS) }),
  fc.record({ principals: fc.array(fc.oneof(plainPrincipal, spacedPrincipal), { minLength: 1, maxLength: 3 }), quoted: fc.constant(true), options: fc.constantFrom(...OPTIONS) }),
);

export const writeLine = (l: SignerLine, key = KEY, indent = "") => `${indent}${l.quoted ? `"${l.principals.join(",")}"` : l.principals.join(",")}${l.options ? ` ${l.options}` : ""} ${key}`;

/** Lines with what JavaScript, unlike git, also takes for line breaks: \r, U+2028 and U+2029 before a fake signature header. */
const trickLine = fc.tuple(textLine, fc.constantFrom("\r", "\u2028", "\u2029"), fc.constantFrom<Kind>("ssh", "openpgp", "x509", "unknown")).map(([text, br, kind]) => `${text}${br}gpgsig ${kind === "unknown" ? "x" : ARMOR[kind]}`);
const trickCommit = fc.record({
  before: fc.array(fc.oneof(fc.constantFrom("tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904"), trickLine.map((t) => `author ${t} <a@x> 0 +0000`)), { maxLength: 3 }),
  signatures: fc.array(fc.record({ name: fc.constantFrom("gpgsig", "gpgsig-sha256"), kind: fc.constantFrom<Kind>("ssh", "openpgp", "x509", "unknown"), body: fc.array(fc.oneof(textLine, trickLine), { maxLength: 2 }) }), { maxLength: 2 }),
  after: fc.constant<string[]>([]),
  message: fc.array(fc.oneof(textLine, trickLine), { maxLength: 2 }),
});

export function define(tier: Tier) {
  test("signatureKind: one signature header decides the kind, several are refused as unknown, and nothing in the message or a continuation counts", (t) =>
    check(
      t,
      tier,
      fc.property(commit, (c) => {
        const want = c.signatures.length === 0 ? null : c.signatures.length > 1 ? "unknown" : (c.signatures[0] as { kind: Kind }).kind;
        assert.equal(signatureKind(raw(c)), want);
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("signatureKind fails closed: whatever a header smuggles in, a commit git sees signed another way, or several times, never reads as SSH", (t) =>
    check(
      t,
      tier,
      fc.property(trickCommit, (c) => {
        const git = c.signatures.length === 0 ? null : c.signatures.length > 1 ? "unknown" : (c.signatures[0] as { kind: Kind }).kind;
        const got = signatureKind(raw(c));
        if (got === "ssh") assert.ok(git === "ssh" || git === null, `git sees ${git}`);
        if (git === "ssh") assert.ok(got === "ssh" || got === "unknown", `read as ${got}`);
        if (git !== null && git !== "ssh") assert.notEqual(got, null);
      }),
      { fast: 1000, deep: 100_000 },
    ));

  test("principalsOf: every principal of every entry, quoted or not, and nothing from comments, options, keys or comments after the key", (t) =>
    check(
      t,
      tier,
      fc.property(fc.array(fc.oneof(signerLine.map((l) => ({ l })), fc.constantFrom("", "# a@x ssh-ed25519 AAAA", "   ", "\t# b@y").map((comment) => ({ comment }))), { maxLength: 6 }), fc.constantFrom("", "  ", "\t"), fc.constantFrom("\n", "\r\n"), (entries, indent, eol) => {
        const text = entries.map((e) => ("l" in e ? `${writeLine(e.l, `${KEY} owner@laptop`, indent)}` : e.comment)).join(eol);
        const want = new Set(entries.flatMap((e) => ("l" in e ? e.l.principals : [])));
        assert.deepEqual(principalsOf(text), want);
      }),
      { fast: 1000, deep: 100_000 },
    ));
}
