import assert from "node:assert/strict";
import { test } from "node:test";

import { ConfigError, parseMachineConfig } from "./machine.ts";

export const CONFIG = {
  schema: "blacksand.machine/1",
  machine: { id: "agent-host", role: "host" },
  users: { "_blacksand-egress": { shell: "/usr/bin/false", hidden: true } },
  groups: { "com.apple.access_ssh": { members: ["owner"] } },
  jobs: { "dev.blacksand.updater": {}, "com.openssh.sshd": { running: false } },
  sshd: { enabled: true, settings: { PasswordAuthentication: "no", PermitRootLogin: "prohibit-password", AllowUsers: ["owner", "agent-*@100.64.0.0/10"], Port: ["22"] } },
  firewall: { enabled: true, stealth: true },
  disk_encryption: true,
  tailscale: true,
  tools: { git: ">=2.55.0", node: "24.x", pnpm: "12.14.0" },
};

test("a machine config reads back with sshd keywords lowercased, single values as strings and repeated ones as lists", () => {
  const c = parseMachineConfig(structuredClone(CONFIG));
  assert.deepEqual(c.sshd, { enabled: true, settings: { passwordauthentication: "no", permitrootlogin: "prohibit-password", allowusers: ["owner", "agent-*@100.64.0.0/10"], port: ["22"] } });
  assert.deepEqual(c.users, CONFIG.users);
  assert.deepEqual(c.tools, CONFIG.tools);
  assert.deepEqual(parseMachineConfig({ schema: "blacksand.machine/1", machine: { id: "m", role: "desktop" } }), {
    schema: "blacksand.machine/1",
    machine: { id: "m", role: "desktop" },
    users: {},
    groups: {},
    jobs: {},
    sshd: { settings: {} },
    firewall: {},
    tools: {},
  });
});

test("a typo, a wrong type or a value nothing could check is refused, never ignored", () => {
  const broken: Array<[string, (c: any) => void]> = [
    ["unknown field", (c) => (c.firewal = {})],
    ["schema", (c) => (c.schema = "blacksand.machine/2")],
    ["machine.role", (c) => (c.machine.role = "server")],
    ["machine.id", (c) => (c.machine.id = "Agent Host")],
    ["account name", (c) => (c.users["bad name"] = {})],
    ["unknown field", (c) => (c.users["_blacksand-egress"].shel = "/bin/sh")],
    ["users._blacksand-egress.shell", (c) => (c.users["_blacksand-egress"].shell = "bash")],
    ["users._blacksand-egress.hidden", (c) => (c.users["_blacksand-egress"].hidden = "yes")],
    ["lists a name twice", (c) => (c.groups["com.apple.access_ssh"].members = ["a", "a"])],
    ["isn't a keyword blacksand checks", (c) => (c.sshd.settings.Banner = "none")],
    ["sets passwordauthentication twice", (c) => (c.sshd.settings.passwordauthentication = "no")],
    ["isn't one of yes, no", (c) => (c.sshd.settings.PasswordAuthentication = "banana")],
    ["isn't one of yes, no", (c) => (c.sshd.settings.PasswordAuthentication = "No")],
    ["isn't one of yes, no, prohibit-password, forced-commands-only", (c) => (c.sshd.settings.PermitRootLogin = "without-password")],
    ["isn't a port from 1 to 65535", (c) => (c.sshd.settings.Port = ["70000"])],
    ["isn't a port from 1 to 65535", (c) => (c.sshd.settings.Port = ["022"])],
    ["isn't a list", (c) => (c.sshd.settings.Port = "22")],
    ["isn't a whole number from 1 to 100", (c) => (c.sshd.settings.MaxAuthTries = "0")],
    ["isn't a whole number from 1 to 100", (c) => (c.sshd.settings.MaxAuthTries = 3)],
    ["without spaces, quotes or commas", (c) => (c.sshd.settings.AllowUsers = ["root agent"])],
    ["without spaces, quotes or commas", (c) => (c.sshd.settings.AllowUsers = ["a\nMatch all"])],
    ["lists a value twice", (c) => (c.sshd.settings.AllowUsers = ["owner", "owner"])],
    ["isn't any, or space-separated lists", (c) => (c.sshd.settings.AuthenticationMethods = "PUBLICKEY")],
    ["isn't any, or space-separated lists", (c) => (c.sshd.settings.AuthenticationMethods = "publickey  password")],
    ["isn't an npm version range", (c) => (c.tools.git = "newest")],
    ["unknown field", (c) => (c.tools.python = "3.x")],
    ["disk_encryption", (c) => (c.disk_encryption = 1)],
  ];
  for (const [why, mutate] of broken) {
    const c = structuredClone(CONFIG);
    mutate(c);
    assert.throws(() => parseMachineConfig(c), (error: unknown) => error instanceof ConfigError && error.message.includes(why), why);
  }
});

test("a key named like an Object property is data, not a prototype", () => {
  const c = parseMachineConfig(JSON.parse('{"schema":"blacksand.machine/1","machine":{"id":"m","role":"host"},"users":{"__proto__":{"shell":"/bin/sh"}}}'));
  assert.deepEqual(Object.keys(c.users), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(c.users), Object.prototype);
});
