// Deep tier: the properties in fuzz-signers.ts with a fresh seed and many
// more cases, and principalsOf checked against ssh-keygen itself: for generated
// allowed-signers files holding a throwaway key, every principal ssh-keygen
// finds for a signature must be one principalsOf lists (one it left out would
// refuse a commit ssh-keygen accepts). Each run of ssh-keygen takes ~10 ms, so
// that property runs hundreds of cases, not thousands.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

import fc from "fast-check";

import { check } from "../../../tools/fuzz.ts";
import { define, signerLine, writeLine } from "./fuzz-signers.ts";

const { principalsOf } = await import("../lib/selfupdate.mjs");

define("deep");

const SSH_KEYGEN = "/usr/bin/ssh-keygen";
const ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzz-signers-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const keygen = (args: string[], input?: string) => spawnSync(SSH_KEYGEN, args, { env: ENV, encoding: "utf8", ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }) });

test("principalsOf lists every principal ssh-keygen finds for a signature, whatever else the file holds", { skip: !fs.existsSync(SSH_KEYGEN) && "no ssh-keygen" }, async (t) => {
  const key = path.join(dir, "key");
  assert.equal(keygen(["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", key]).status, 0);
  const message = path.join(dir, "message");
  fs.writeFileSync(message, "a commit\n");
  assert.equal(keygen(["-q", "-Y", "sign", "-f", key, "-n", "git", message]).status, 0);
  const ours = fs.readFileSync(`${key}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" ");
  const other = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHf7l0gZQ0xYw1oT0b8bXqVwz1H1r0d8VqvJm9wCjX1y";
  const noise = fc.oneof(signerLine.map((l) => writeLine(l, other)), fc.constantFrom("", "# comment", '"unterminated a@x ' + other, "a,,b " + other, "   "));
  const file = path.join(dir, "allowed_signers");
  let compared = 0;
  await check(
    t,
    "deep",
    fc.property(fc.array(noise, { maxLength: 4 }), signerLine, fc.nat(4), (lines, mine, at) => {
      const all = [...lines];
      all.splice(at % (lines.length + 1), 0, writeLine(mine, ours));
      const text = all.join("\n");
      fs.writeFileSync(file, `${text}\n`, { mode: 0o600 });
      const found = keygen(["-Y", "find-principals", "-s", `${message}.sig`, "-f", file]);
      if (found.status !== 0) return;
      compared++;
      const listed = principalsOf(text);
      for (const principal of found.stdout.split("\n").filter(Boolean)) assert.ok(listed.has(principal), `ssh-keygen found ${JSON.stringify(principal)}; principalsOf has ${JSON.stringify([...listed])}`);
    }),
    { fast: 50, deep: 400, deepSeconds: 10 },
  );
  assert.ok(compared > 0, "ssh-keygen matched no generated file");
});
