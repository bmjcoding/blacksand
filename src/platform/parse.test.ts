import assert from "node:assert/strict";
import { test } from "node:test";

import { ParseError, parseColons, parseDscl, parseLaunchd, parseShow, parseSshdDump, parseUnitFiles } from "./parse.ts";

test("dscl: values on one line or one per indented line, native names with their prefix, a repeated attribute refused", () => {
  const records = parseDscl("RecordName: a b\nUniqueID: 5\n-\nRecordName:\n x y\n z\ndsAttrTypeNative:IsHidden: 1\nRealName: A: B\n");
  assert.deepEqual(records.map((r) => Object.fromEntries(r)), [
    { RecordName: ["a", "b"], UniqueID: ["5"] },
    { RecordName: ["x y", "z"], "dsAttrTypeNative:IsHidden": ["1"], RealName: ["A:", "B"] },
  ]);
  assert.throws(() => parseDscl("UniqueID: 1\nUniqueID: 2\n"), ParseError);
  assert.throws(() => parseDscl(" orphan\n"), ParseError);
  assert.throws(() => parseDscl("not an attribute\n"), ParseError);
});

test("launchctl: loaded services with their pids, launchd's switches, and anything else refused", () => {
  const out = parseLaunchd("system = {\n\tservices = {\n\t\t  0  -  \ta.b\n\t\t 77  -9 \tc.d\n\t}\n\tdisabled services = {\n\t\t\"a.b\" => disabled\n\t}\n}\n");
  assert.deepEqual([...out.services], [["a.b", { pid: 0 }], ["c.d", { pid: 77 }]]);
  assert.deepEqual([...out.disabled], [["a.b", true]]);
  assert.throws(() => parseLaunchd("system = {\n}\n"), /no services block/);
  assert.throws(() => parseLaunchd("\tservices = {\n\t\tgarbage\n\t}\n"), ParseError);
  assert.throws(() => parseLaunchd("\tservices = {\n\t\t0 - a\n"), /isn't closed/);
});

test("getent and systemctl output is read field by field, and a short or unreadable line refused", () => {
  assert.deepEqual(parseColons("a:x:1:2::/h:/bin/sh\n", 7, "getent passwd"), [["a", "x", "1", "2", "", "/h", "/bin/sh"]]);
  assert.throws(() => parseColons("a:x:1\n", 7, "getent passwd"), /3 fields, not 7/);
  assert.deepEqual(parseUnitFiles("blacksand-egress.service enabled enabled\nt3blackout-update.timer disabled enabled\n"), ["blacksand-egress.service", "t3blackout-update.timer"]);
  const shown = parseShow("Id=ssh.service\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled\n\nId=x.service\nLoadState=not-found\nActiveState=inactive\nUnitFileState=\n");
  assert.deepEqual(shown.map((props) => Object.fromEntries(props)), [
    { Id: "ssh.service", LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled" },
    { Id: "x.service", LoadState: "not-found", ActiveState: "inactive", UnitFileState: "" },
  ]);
  assert.throws(() => parseShow("Id=a\ngarbage\n"), ParseError);
});

test("sshd -G's dump: keywords lowercased, each printed line its own entry, never joined", () => {
  const dump = parseSshdDump("Port 22\nPort 2222\nPasswordAuthentication no\nDenyUsers root agent\nDenyUsers guest\nBanner none\n");
  assert.deepEqual(Object.fromEntries(dump), { port: ["22", "2222"], passwordauthentication: ["no"], denyusers: ["root agent", "guest"], banner: ["none"] });
  assert.throws(() => parseSshdDump(""), /printed nothing/);
  assert.throws(() => parseSshdDump(" indented\n"), ParseError);
});
