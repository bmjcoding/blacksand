// Property tests (fast tier, a fixed seed: tools/fuzz.ts) of what discovery
// reads: dscl's records, sshd -G's dump, and the machine config. Each
// reader must read back what was written, and refuse anything else with its
// own error, never another exception.

import assert from "node:assert/strict";
import { test } from "node:test";

import fc from "fast-check";

import { check } from "../../tools/fuzz.ts";
import { ConfigError, SSHD_KEYWORDS, parseMachineConfig } from "../core/machine.ts";
import { ParseError, parseDscl, parseLaunchd, parseSshdDump } from "./parse.ts";

const anyText = fc.string({ maxLength: 80, unit: "binary" });
const refusesCleanly = (read: () => unknown, kind: new (...args: never[]) => Error) => {
  try {
    read();
  } catch (error) {
    if (!(error instanceof kind)) throw error;
  }
};

// dscl prints an attribute's values on its line when none has a space, else one per indented line.
const attribute = fc.oneof(fc.stringMatching(/^[A-Z][A-Za-z]{0,10}$/), fc.stringMatching(/^dsAttrTypeNative:[A-Za-z]{1,8}$/));
const value = fc.string({ minLength: 1, maxLength: 10, unit: "binary" }).filter((v) => !v.includes("\n"));
const dsclRecord = fc.uniqueArray(fc.tuple(attribute, fc.array(value, { minLength: 1, maxLength: 3 })), { minLength: 1, maxLength: 4, selector: ([name]) => name });
const dsclText = (records: Array<Array<[string, string[]]>>) =>
  records.map((r) => r.map(([name, values]) => (values.some((v) => v.includes(" ")) ? `${name}:\n${values.map((v) => ` ${v}`).join("\n")}` : `${name}: ${values.join(" ")}`)).join("\n")).join("\n-\n") + "\n";

// sshd -G prints one `Keyword value` line per entry; a value may hold spaces (a quoted pattern) but no line break.
const dumpEntry = fc.tuple(fc.stringMatching(/^[A-Za-z][A-Za-z0-9]{0,15}$/), fc.string({ maxLength: 12, unit: "binary" }).filter((v) => !/[\n\r]/.test(v)));

test("dscl: records read back as written, and any other text is read or refused with a ParseError", (t) =>
  check(
    t,
    "fast",
    fc.property(fc.array(dsclRecord, { minLength: 1, maxLength: 3 }), anyText, (records, junk) => {
      assert.deepEqual(parseDscl(dsclText(records)).map((r) => [...r]), records);
      refusesCleanly(() => parseDscl(junk), ParseError);
      refusesCleanly(() => parseLaunchd(junk), ParseError);
    }),
    { fast: 500, deep: 50_000 },
  ));

test("sshd -G's dump: every printed line is one entry of its keyword, in order, whatever its value holds", (t) =>
  check(
    t,
    "fast",
    fc.property(fc.array(dumpEntry, { minLength: 1, maxLength: 12 }), anyText, (entries, junk) => {
      const text = entries.map(([k, v]) => (v ? `${k} ${v}` : k)).join("\n");
      const want = new Map<string, string[]>();
      for (const [k, v] of entries) want.set(k.toLowerCase(), [...(want.get(k.toLowerCase()) ?? []), v]);
      assert.deepEqual(parseSshdDump(text), want);
      refusesCleanly(() => parseSshdDump(junk), ParseError);
    }),
    { fast: 1000, deep: 100_000 },
  ));

test("machine config: any JSON is a config or a ConfigError; an accepted one keeps exactly the sshd values asked for, each one sshd takes", (t) =>
  check(
    t,
    "fast",
    fc.property(
      fc.oneof(
        fc.jsonValue(),
        fc.record({
          schema: fc.constantFrom("blacksand.machine/1", "blacksand.machine/2"),
          machine: fc.record({ id: fc.constantFrom("m", "Agent", "agent-host"), role: fc.constantFrom("host", "desktop", "root") }),
          sshd: fc.record({ enabled: fc.oneof(fc.boolean(), fc.jsonValue()), settings: fc.dictionary(fc.constantFrom("PasswordAuthentication", "passwordauthentication", "Banner", "PermitRootLogin", "Port", "MaxAuthTries", "AllowUsers"), fc.oneof(fc.constantFrom("no", "yes", "YES", "without-password", "prohibit-password", " no", "0", "3", "101", ["22"], ["70000"], ["owner", "owner"], ["owner"], ["a b"]), fc.jsonValue())) }, { requiredKeys: [] }),
          tools: fc.dictionary(fc.constantFrom("git", "node", "pnpm", "python"), fc.oneof(fc.constantFrom(">=2.55.0", "24.x", "latest", "^1 || 2"), fc.jsonValue())),
        }, { requiredKeys: ["schema", "machine"] }),
      ),
      (value) => {
        let parsed;
        try {
          parsed = parseMachineConfig(value);
        } catch (error) {
          if (error instanceof ConfigError) return;
          throw error;
        }
        assert.deepEqual(parseMachineConfig(JSON.parse(JSON.stringify(parsed))), parsed);
        // Nothing is rewritten on the way in: each value is the one given, and one sshd -G could print.
        const given = Object.entries((value as { sshd?: { settings?: object } }).sshd?.settings ?? {});
        for (const [keyword, v] of Object.entries(parsed.sshd.settings)) {
          const kind = SSHD_KEYWORDS[keyword];
          assert.ok(kind && (Array.isArray(v) ? v : [v]).every((one) => kind.valid(one)), `${keyword}: ${JSON.stringify(v)}`);
          assert.deepEqual(v, given.find(([k]) => k.toLowerCase() === keyword)?.[1]);
        }
      },
    ),
    { fast: 1000, deep: 100_000 },
  ));
