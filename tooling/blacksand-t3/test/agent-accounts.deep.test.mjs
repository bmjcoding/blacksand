// node --test test/: scripts/add-agent-account.sh, sourced for its functions (it
// runs its main only when run). Agent accounts log in over SSH with keys only,
// root's keys file and only loopback forwards; by default every login whose
// source address is outside Tailscale's ranges and this Mac's loopback is refused,
// for agent accounts, you and root, IPv4 and IPv6 (--allow-from narrows that to
// the desktop Mac's addresses, --allow-lan widens it): checked with Apple's sshd
// (-t, -T -C) on a copy of macOS's own layout with scratch host keys, before the
// drop-in is left in place. The standby lane's sshd listens on loopback only, and
// an agent's home is closed to everyone else, ACLs included. Nothing here needs
// root or touches the system's sshd.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = fs.realpathSync(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
const ADD_ACCOUNT = path.join(ROOT, "scripts", "add-agent-account.sh");
const SSHD = "/usr/sbin/sshd";
const macSshd = !(process.platform === "darwin" && fs.existsSync(SSHD) && fs.existsSync("/etc/ssh/sshd_config")) && "macOS sshd";
const isMac = process.platform === "darwin";
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-agent-accounts-")));
const me = os.userInfo().username;
const myGroup = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();

/** Runs `script` in bash after sourcing add-agent-account.sh. */
const bash = (script, ...rest) => {
  assert.equal(rest.length, 0, "bash(script): the script is sourced already");
  return spawnSync("bash", ["-c", `source ${JSON.stringify(ADD_ACCOUNT)}\n${script}`], { encoding: "utf8" });
};
const render = ({ group = myGroup, allowLan = false, allowFrom = "" } = {}) =>
  bash(`AGENT_GROUP=${group}\nALLOW_LAN=${allowLan ? 1 : 0}\nALLOW_FROM=${JSON.stringify(allowFrom)}\nrender_dropin`).stdout;

const probes = (name) => bash(`printf '%s\\n' "\${${name}[@]}"`).stdout.trim().split("\n");

/**
 * macOS's sshd layout in a scratch folder: its own sshd_config, Include pointed
 * here, its 100-macos.conf, scratch host keys, and `dropin` as 010-blacksand.conf.
 */
function appleLayout(content) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "sshd_config.d"));
  for (const type of ["ed25519", "ecdsa"]) spawnSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-f", path.join(dir, `ssh_host_${type}_key`)]);
  const main = fs.readFileSync("/etc/ssh/sshd_config", "utf8").replace(/^Include \/etc\/ssh\/sshd_config\.d\/\*$/m, `Include ${dir}/sshd_config.d/*`);
  assert.match(main, new RegExp(`^Include ${dir}/sshd_config\\.d/\\*$`, "m"), "macOS's sshd_config includes sshd_config.d first");
  fs.writeFileSync(path.join(dir, "sshd_config"), `${main}\nHostKey ${dir}/ssh_host_ed25519_key\nHostKey ${dir}/ssh_host_ecdsa_key\nPidFile ${dir}/sshd.pid\n`);
  for (const file of fs.readdirSync("/etc/ssh/sshd_config.d")) fs.copyFileSync(path.join("/etc/ssh/sshd_config.d", file), path.join(dir, "sshd_config.d", file));
  const dropin = path.join(dir, "sshd_config.d", "010-blacksand.conf");
  fs.writeFileSync(dropin, content);
  return { dir, config: path.join(dir, "sshd_config"), dropin };
}

/** What Apple's sshd would apply to `user` from `addr`, keywords lowercased. */
function effective(config, user, addr) {
  const result = spawnSync(SSHD, ["-T", "-f", config, "-C", `user=${user},host=t3b-test,addr=${addr}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter(Boolean).map((line) => [line.split(" ")[0].toLowerCase(), line.slice(line.indexOf(" ") + 1)]);
  return { all: lines, get: (key) => lines.find(([k]) => k === key)?.[1], denied: lines.some(([k, v]) => k === "denyusers" && v === "*") };
}

// ---------------------------------------------------- who logs in, how --

test("agent accounts get root's keys file and loopback-only forwarding; everyone else keeps theirs", { skip: macSshd }, () => {
  const agent = appleLayout(render()).config;
  assert.equal(spawnSync(SSHD, ["-t", "-f", agent]).status, 0);
  const asAgent = Object.fromEntries(effective(agent, me, "127.0.0.1").all);
  assert.equal(asAgent.authorizedkeysfile, "/etc/ssh/blacksand/authorized_keys/%u");
  assert.equal(asAgent.allowtcpforwarding, "local");
  assert.equal(asAgent.permitopen, "127.0.0.1:* localhost:* [::1]:*");
  assert.equal(asAgent.authenticationmethods, "publickey");
  assert.equal(asAgent.passwordauthentication, "no");
  assert.equal(asAgent.kbdinteractiveauthentication, "no");
  assert.equal(asAgent.usepam, "yes");
  const other = Object.fromEntries(effective(appleLayout(render({ group: "t3b-no-such-group" })).config, me, "127.0.0.1").all);
  assert.equal(other.authorizedkeysfile, ".ssh/authorized_keys");
  assert.equal(other.passwordauthentication, "no");
  assert.equal(other.permitrootlogin, "no");
});

test("the tailnet-only block comes after the agent group's, and --allow-lan leaves it out", () => {
  const dropin = render();
  const lines = dropin.split("\n");
  const group = lines.indexOf(`Match Group ${myGroup}`);
  const address = lines.indexOf("Match Address !100.64.0.0/10,!fd7a:115c:a1e0::/48,!127.0.0.0/8,!::1/128,0.0.0.0/0,::/0,*%*");
  assert.ok(group >= 0 && address > group, dropin);
  assert.equal(lines[address + 1], "  DenyUsers *");
  assert.equal(lines.slice(address + 2).filter((line) => line && !line.startsWith("#")).length, 0, "nothing after it: the block ends with the file");
  assert.doesNotMatch(render({ allowLan: true }), /Match Address|DenyUsers/);
});

test("Apple's sshd refuses agent accounts, you and root from outside Tailscale and this Mac, every address family", { skip: macSshd }, () => {
  const refused = probes("REFUSED_PROBES");
  const allowed = probes("ALLOWED_PROBES");
  assert.ok(refused.includes("fe80::1%en0") && refused.includes("2001:db8::5") && refused.includes("192.168.1.50"));
  const agent = appleLayout(render());
  const owner = appleLayout(render({ group: "t3b-no-such-group" }));
  for (const layout of [agent, owner]) assert.equal(spawnSync(SSHD, ["-t", "-f", layout.config]).status, 0);
  for (const [config, user] of [[agent.config, me], [owner.config, me], [owner.config, "root"]]) {
    for (const addr of refused) assert.equal(effective(config, user, addr).denied, true, `${user} from ${addr} must be refused`);
    for (const addr of allowed) assert.equal(effective(config, user, addr).denied, false, `${user} from ${addr} must be allowed`);
  }
  // From the tailnet, the agent group's settings still apply; macOS's own stay global.
  const fromTailnet = effective(agent.config, me, "100.101.1.1");
  assert.equal(fromTailnet.get("authorizedkeysfile"), "/etc/ssh/blacksand/authorized_keys/%u");
  assert.equal(fromTailnet.get("permitopen"), "127.0.0.1:* localhost:* [::1]:*");
  assert.equal(fromTailnet.get("usepam"), "yes");
  assert.equal(fromTailnet.get("passwordauthentication"), "no");
  assert.equal(effective(owner.config, me, "100.101.1.1").get("authorizedkeysfile"), ".ssh/authorized_keys", "your own keys file stays");
  // --allow-lan: no address is refused.
  const lan = appleLayout(render({ allowLan: true }));
  for (const addr of [...refused, ...allowed]) assert.equal(effective(lan.config, me, addr).denied, false, addr);
});

test("without the *%* entry, Apple's sshd lets a scoped link-local (LAN) address through; with it, not", { skip: macSshd }, () => {
  // OpenSSH 10.5p1 compares the zone too, so ::/0 doesn't match fe80::...%en0.
  const b1 = appleLayout(render().replace(",*%*\n", "\n"));
  assert.equal(effective(b1.config, me, "fe80::1%en0").denied, false, "positive control: the block as first proposed");
  assert.equal(effective(b1.config, me, "192.168.1.50").denied, true);
  const fixed = appleLayout(render());
  for (const addr of ["fe80::1%en0", "fe80::aede:48ff:fe00:1122%en1", "fe80::1%lo0"]) assert.equal(effective(fixed.config, me, addr).denied, true, addr);
});

/** install_dropin and sources_problem on a scratch layout: its sshd -t and -T, this account as the agent, root as you. */
function installIn(layout, { allowLan = false, allowFrom = "", renderer = null } = {}) {
  return bash(`
DROPIN=${JSON.stringify(layout.dropin)}
AGENT_GROUP=${myGroup}
ALLOW_LAN=${allowLan ? 1 : 0}
ALLOW_FROM=${JSON.stringify(allowFrom)}
NAME=${me}
SUDO_USER=root
validate_config() { ${SSHD} -t -f ${JSON.stringify(layout.config)}; }
effective_config() { ${SSHD} -T -f ${JSON.stringify(layout.config)} -C "$1"; }
${renderer ? `render_dropin() { cat <<'DROPIN_EOF'\n${renderer}DROPIN_EOF\n}` : ""}
install_dropin
echo INSTALLED`);
}

test("the drop-in is installed only if Apple's sshd would refuse and allow as it should; otherwise the previous one is put back", { skip: macSshd }, () => {
  const previous = "# the previous drop-in\nPasswordAuthentication no\n";
  const layout = appleLayout(previous);
  const ok = installIn(layout);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /INSTALLED/);
  assert.equal(fs.readFileSync(layout.dropin, "utf8"), render());
  assert.deepEqual(fs.readdirSync(layout.dir).filter((f) => f.startsWith(".blacksand-dropin")), [], "no temporary left");
  for (const [label, renderer, why] of [
    ["the block as first proposed", render().replace(",*%*\n", "\n"), /would allow .* from fe80::/],
    ["no block (as --allow-lan renders it) without --allow-lan", render({ allowLan: true }), /would allow .* from 192\.168\.1\.50/],
    ["everyone refused", `${render()}Match All\n  DenyUsers *\n`, /would refuse .* from 100\.64\.0\.1/],
  ]) {
    fs.writeFileSync(layout.dropin, previous);
    const refused = installIn(layout, { renderer });
    assert.equal(refused.status, 1, label);
    assert.doesNotMatch(refused.stdout, /INSTALLED/, label);
    assert.match(refused.stderr, /wouldn't refuse and allow logins as it should, so the previous one is back in place/, label);
    assert.match(refused.stderr, why, label);
    assert.equal(fs.readFileSync(layout.dropin, "utf8"), previous, label);
  }
  // --allow-lan with its own drop-in installs.
  fs.writeFileSync(layout.dropin, previous);
  assert.match(installIn(layout, { allowLan: true }).stdout, /INSTALLED/);
  assert.doesNotMatch(fs.readFileSync(layout.dropin, "utf8"), /DenyUsers/);
});

/** A local port nothing listens on yet. */
async function freePort() {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a real login from a scoped link-local address is refused; from loopback it isn't (scratch sshd, loopback only)", { skip: macSshd }, async () => {
  // Unprivileged: Apple's sshd as this account, on this Mac's loopback (127.0.0.1,
  // ::1 and lo0's fe80::1, a scoped source like a LAN peer's), the drop-in
  // rendered with this account as the agent and a scratch client key.
  const dir = tmp();
  const keys = path.join(dir, "keys");
  fs.mkdirSync(keys);
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "hostkey")]);
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "client")]);
  fs.copyFileSync(path.join(dir, "client.pub"), path.join(keys, me));
  fs.mkdirSync(path.join(dir, "d"));
  fs.writeFileSync(path.join(dir, "d", "010-blacksand.conf"), bash(`AGENT_GROUP=${myGroup}\nKEYS_DIR=${keys}\nrender_dropin`).stdout);
  const port = await freePort();
  const config = path.join(dir, "sshd_config");
  fs.writeFileSync(config, [
    `Include ${dir}/d/*`, `Port ${port}`, "ListenAddress 127.0.0.1", "ListenAddress ::1", "ListenAddress fe80::1%lo0",
    `HostKey ${dir}/hostkey`, `PidFile ${dir}/sshd.pid`, "UsePAM no", "StrictModes no", "LogLevel VERBOSE", "",
  ].join("\n"));
  assert.equal(spawnSync(SSHD, ["-t", "-f", config]).status, 0);
  const log = path.join(dir, "sshd.log");
  const logFd = fs.openSync(log, "w");
  const sshd = spawn(SSHD, ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", logFd] });
  try {
    for (let i = 0; i < 50 && spawnSync("nc", ["-z", "127.0.0.1", String(port)]).status !== 0; i++) await new Promise((r) => setTimeout(r, 100));
    const env = { ...process.env };
    delete env.SSH_AUTH_SOCK;
    // No ~/.ssh/config, no agent (1Password's included): only the scratch key.
    const login = (host) =>
      spawnSync("ssh", [
        "-F", "/dev/null", "-i", path.join(dir, "client"), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "BatchMode=yes",
        "-o", `UserKnownHostsFile=${dir}/known_hosts`, "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5",
        "-p", String(port), `${me}@${host}`, "echo in",
      ], { encoding: "utf8", env, timeout: 20_000 });
    for (const host of ["127.0.0.1", "::1"]) {
      const ok = login(host);
      assert.equal(ok.status, 0, `${host}: ${ok.stderr}`);
      assert.equal(ok.stdout.trim(), "in");
    }
    const lan = login("fe80::1%lo0");
    assert.notEqual(lan.status, 0);
    assert.match(lan.stderr, /Permission denied/);
    await new Promise((r) => setTimeout(r, 300));
    assert.match(fs.readFileSync(log, "utf8"), new RegExp(`User ${me} from fe80::1%lo0 not allowed because listed in DenyUsers`));
  } finally {
    sshd.kill();
    fs.closeSync(logFd);
  }
});

const DESKTOP = "100.101.2.3,fd7a:115c:a1e0::9f01:2a3b";

test("the drop-in, the help and the summary call it an address check: key auth still required, a forged tailnet address with a stolen key not stopped", () => {
  for (const dropin of [render(), render({ allowFrom: DESKTOP })]) {
    assert.match(dropin, /# Source addresses: .* and this Mac only\. Key auth is still required; a LAN\n# peer forging one of these addresses with a stolen key is not stopped\.\nMatch Address /);
  }
  assert.match(render(), /tailnet address ranges and this Mac only/);
  assert.match(render({ allowFrom: DESKTOP }), /--allow-from's addresses and this Mac only/);
  const script = fs.readFileSync(ADD_ACCOUNT, "utf8");
  assert.match(script, /#   --tailnet-only    the default: tailnet address ranges only\./);
  assert.match(script, /a LAN peer forging\n#\s+a tailnet address with a stolen key is not stopped/);
  assert.match(script, /logins only from tailnet address ranges \(100\.64\.0\.0\/10, fd7a:115c:a1e0::\/48\) and this Mac \(--tailnet-only\); key auth still required; a LAN peer forging a tailnet address with a stolen key is not stopped/);
  assert.doesNotMatch(script, /logins only from Tailscale/, "it doesn't claim the connection came through Tailscale");
});

test("--allow-from pins logins to the desktop Mac's exact tailnet addresses (and loopback) in Apple's sshd", { skip: macSshd }, () => {
  const agent = appleLayout(render({ allowFrom: DESKTOP }));
  const owner = appleLayout(render({ group: "t3b-no-such-group", allowFrom: DESKTOP }));
  for (const layout of [agent, owner]) assert.equal(spawnSync(SSHD, ["-t", "-f", layout.config]).status, 0);
  const allowed = ["100.101.2.3", "fd7a:115c:a1e0::9f01:2a3b", "127.0.0.1", "::1"];
  const refused = ["100.101.2.4", "100.64.0.1", "100.100.100.100", "fd7a:115c:a1e0::9f01:2a3c", "fd7a:115c:a1e0::1", "192.168.1.50", "fe80::1%en0", "2001:db8::5"];
  for (const [config, user] of [[agent.config, me], [owner.config, me], [owner.config, "root"]]) {
    for (const addr of allowed) assert.equal(effective(config, user, addr).denied, false, `${user} from ${addr}`);
    for (const addr of refused) assert.equal(effective(config, user, addr).denied, true, `${user} from ${addr}`);
  }
  // install_dropin's own check passes for it, and refuses the plain ranges block when --allow-from was asked for.
  const layout = appleLayout("# previous\n");
  assert.match(installIn(layout, { allowFrom: DESKTOP }).stdout, /INSTALLED/);
  fs.writeFileSync(layout.dropin, "# previous\n");
  const wide = installIn(layout, { allowFrom: DESKTOP, renderer: render() });
  assert.equal(wide.status, 1);
  assert.match(wide.stderr, /would allow .* from 100\.64\.0\.1/);
  assert.equal(fs.readFileSync(layout.dropin, "utf8"), "# previous\n");
});

// ---------------------------------------------------------- the options --

/** main's option loop, lifted out of the script so it runs without root. */
function extractOptionParser() {
  const source = fs.readFileSync(ADD_ACCOUNT, "utf8");
  const start = source.indexOf('  NAME="${1:-}"');
  const end = source.indexOf("  [[ -x \"$APP/Contents/MacOS/T3 Code (blacksand)\" ]]");
  assert.ok(start > 0 && end > start, "main's option parsing is where this test expects it");
  return `parse_options() {\n${source.slice(start, end)}\n  echo "ALLOW_LAN=$ALLOW_LAN LOOPBACK=$LOOPBACK ALLOW_FROM=$ALLOW_FROM"\n}\nSUDO_USER=admin-test`;
}

test("--tailnet-only (the default) and --allow-lan are main's options, and contradict each other", () => {
  const parse = (args) => bash(`${extractOptionParser()}\nparse_options ${args}`);
  assert.match(parse("agent-x --tailnet-only").stdout, /ALLOW_LAN=0/);
  assert.match(parse("agent-x").stdout, /ALLOW_LAN=0/);
  assert.match(parse("agent-x --allow-lan").stdout, /ALLOW_LAN=1/);
  const both = parse("agent-x --tailnet-only --allow-lan");
  assert.equal(both.status, 1);
  assert.match(both.stderr, /--tailnet-only and --allow-lan contradict each other/);
});

test("--allow-from takes tailnet addresses only, each written one way, and never an empty value", () => {
  const parse = (args) => bash(`${extractOptionParser()}\nALLOW_FROM_FILE=${JSON.stringify(path.join(tmp(), "allow-from"))}\nparse_options ${args}`);
  assert.match(parse(`agent-x --allow-from ${DESKTOP}`).stdout, new RegExp(`ALLOW_FROM=${DESKTOP}$`, "m"));
  for (const bad of ["192.168.1.5", "100.64.0.256", "100.064.0.1", "100.101.2.3,", "fd7a:115c:a1e1::1", "::ffff:100.64.0.1", "100.101.2.3,fe80::1", "tailnet", "'100.101.2.3 100.64.0.1'"]) {
    const refused = parse(`agent-x --allow-from ${bad}`);
    assert.equal(refused.status, 1, bad);
    assert.match(refused.stderr, /isn't a tailnet address|takes tailnet addresses/, bad);
  }
  // No value, or an empty one (a failed `tailscale ip`), is refused, never widened to the ranges.
  assert.match(parse("agent-x --allow-from").stderr, /--allow-from needs addresses/);
  const empty = parse("agent-x --allow-from ''");
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /--allow-from needs addresses/);
  // One spelling per address, as sshd compares them.
  assert.match(parse("agent-x --allow-from fd7a:115c:a1e0:0:0:0:0:1,100.101.2.3").stdout, /ALLOW_FROM=fd7a:115c:a1e0::1,100\.101\.2\.3$/m);
  for (const contradiction of [`--allow-from ${DESKTOP} --allow-lan`, `--tailnet-only --allow-from ${DESKTOP}`]) {
    const both = parse(`agent-x ${contradiction}`);
    assert.equal(both.status, 1, contradiction);
    assert.match(both.stderr, /contradict each other/, contradiction);
  }
});

test("a saved --allow-from is kept by a run with no option, and dropped, saying so, by --tailnet-only or --allow-lan", () => {
  const dir = tmp();
  const saved = path.join(dir, "allow-from");
  const parse = (args) => bash(`${extractOptionParser()}\nALLOW_FROM_FILE=${JSON.stringify(saved)}\nparse_options ${args}`);
  fs.writeFileSync(saved, `${DESKTOP}\n`);
  const kept = parse("agent-x");
  assert.match(kept.stdout, new RegExp(`Keeping --allow-from ${DESKTOP} \\(saved in .*; --tailnet-only drops it\\)`));
  assert.match(kept.stdout, new RegExp(`ALLOW_FROM=${DESKTOP}$`, "m"));
  const ranges = parse("agent-x --tailnet-only");
  assert.equal(ranges.status, 0, ranges.stderr);
  assert.match(ranges.stdout, /ALLOW_FROM=$/m, "the whole ranges for this run");
  assert.match(ranges.stdout, new RegExp(`Dropping the saved --allow-from ${DESKTOP}: the whole tailnet address ranges again \\(--tailnet-only\\)`));
  const lan = parse("agent-x --allow-lan");
  assert.match(lan.stdout, new RegExp(`Dropping the saved --allow-from ${DESKTOP} \\(--allow-lan\\)`));
  assert.match(lan.stdout, /ALLOW_LAN=1 LOOPBACK=0 ALLOW_FROM=$/m);
  // Nothing saved: --tailnet-only says nothing about dropping.
  fs.rmSync(saved);
  assert.doesNotMatch(parse("agent-x --tailnet-only").stdout, /Dropping/);
  // save_allow_from writes the run's list (root's file, 0644) once its drop-in is in place, or removes it.
  const write = (list) => bash(`SSH_DIR=${JSON.stringify(dir)}\nALLOW_FROM_FILE=${JSON.stringify(saved)}\nchown() { :; }\nALLOW_FROM=${JSON.stringify(list)}\nsave_allow_from`);
  assert.equal(write("100.101.9.9").status, 0);
  assert.equal(fs.readFileSync(saved, "utf8"), "100.101.9.9\n");
  assert.equal(fs.statSync(saved).mode & 0o777, 0o644);
  assert.equal(write("").status, 0);
  assert.equal(fs.existsSync(saved), false);
});

// ------------------------------------------------------ the standby lane --

test("the standby sshd listens on loopback only, for agent accounts, keys only", { skip: macSshd }, () => {
  const dir = tmp();
  spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(dir, "hostkey")]);
  const config = path.join(dir, "sshd_config");
  fs.writeFileSync(config, bash(`LOOPBACK_HOSTKEY=${dir}/hostkey\nrender_loopback_config`).stdout);
  const check = spawnSync(SSHD, ["-t", "-f", config], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  const settings = spawnSync(SSHD, ["-T", "-f", config, "-C", "user=nobody,host=x,addr=127.0.0.1"], { encoding: "utf8" }).stdout.toLowerCase();
  assert.deepEqual(settings.match(/^listenaddress .*$/gm).sort(), ["listenaddress 127.0.0.1:2222", "listenaddress [::1]:2222"]);
  assert.match(settings, /^allowgroups blacksand-agents$/m);
  assert.match(settings, /^authenticationmethods publickey$/m);
  assert.match(settings, /^passwordauthentication no$/m);
  const plist = path.join(dir, "sshd.plist");
  fs.writeFileSync(plist, bash("render_loopback_plist").stdout);
  assert.equal(spawnSync("plutil", ["-lint", plist]).status, 0);
  const job = JSON.parse(spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" }).stdout);
  assert.deepEqual(job.ProgramArguments, ["/usr/sbin/sshd", "-D", "-f", "/etc/ssh/blacksand/sshd_config"]);
});

test("a missing host key is reported as such, not as a config error", { skip: macSshd }, () => {
  const dir = tmp();
  const config = path.join(dir, "sshd_config");
  fs.writeFileSync(config, bash(`LOOPBACK_HOSTKEY=${dir}/missing\nrender_loopback_config`).stdout);
  const check = spawnSync(SSHD, ["-t", "-f", config], { encoding: "utf8" });
  assert.notEqual(check.status, 0);
  // install_dropin keys its message off this text.
  assert.match(check.stderr, /no hostkeys available/);
  assert.match(fs.readFileSync(ADD_ACCOUNT, "utf8"), /grep -q 'no hostkeys available'/);
});

// -------------------------------------------------------- an agent's home --

const acl = (dir) => spawnSync("/bin/ls", ["-led", dir], { encoding: "utf8" }).stdout;

/**
 * prepare_agent_home on a fresh scratch home carrying `everyone allow
 * list,search`. `otherCanOpen`: what the check from your account sees;
 * `skipStrip`: chmod -N does nothing (an ACL that won't go).
 */
function prepare({ otherCanOpen = false, skipStrip = false } = {}) {
  const home = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-agent-home-"))), "agent");
  fs.mkdirSync(home, { mode: 0o750 });
  assert.equal(spawnSync("/bin/chmod", ["+a", "everyone allow list,search", home]).status, 0);
  const script = `
source ${JSON.stringify(ADD_ACCOUNT)}
NAME=agent-test SUDO_USER=admin-test HOME_DIR=${JSON.stringify(home)}
seed_pricing() { :; }
as_user() {
  local user="$1"; shift
  if [[ "$user" == "$SUDO_USER" && "$1" == /bin/test ]]; then ${otherCanOpen ? "return 0" : "return 1"}; fi
  if [[ "$1" == /bin/chmod && "$2" == -N && -n "${skipStrip ? "skip" : ""}" ]]; then return 0; fi
  "$@"
}
prepare_agent_home
echo PREPARED`;
  return { home, result: spawnSync("bash", ["-c", script], { encoding: "utf8" }) };
}

test("an agent home's ACL entries are removed, keeping only macOS's deny delete", { skip: !isMac && "macOS ACLs" }, () => {
  const { home, result } = prepare();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PREPARED/);
  const listed = acl(home);
  assert.doesNotMatch(listed, /allow/);
  assert.match(listed, /group:everyone deny delete/);
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, ".blacksand")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(home, ".blacksand/t3")).mode & 0o777, 0o700);
});

test("an ACL that survives, or a home your account can still open, stops provisioning", { skip: !isMac && "macOS ACLs" }, () => {
  const stuck = prepare({ skipStrip: true });
  assert.equal(stuck.result.status, 1);
  assert.match(stuck.result.stderr, /still has ACL entries that allow access/);
  assert.doesNotMatch(stuck.result.stdout, /PREPARED/);
  const open = prepare({ otherCanOpen: true });
  assert.equal(open.result.status, 1);
  assert.match(open.result.stderr, /admin-test can still open/);
});

