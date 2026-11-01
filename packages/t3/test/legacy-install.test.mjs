// node --test test/: every setup script that changes the machine's shared
// services (install.sh, add-agent-account.sh, add-phone-service.sh,
// enable-screen-sharing.sh) refuses a machine with a legacy T3 Blackout install
// before it changes anything: Blacksand installs on a rebuilt machine, never
// beside one (scripts/host-common.sh's refuse_legacy_install). Each script is
// sourced for its functions, the legacy install's marker, launchd job and
// group are mocked in a scratch folder, and every step that would change keys,
// groups, helpers, jobs or known-host entries is stubbed to record that it ran.
// Nothing here needs root, or looks at this machine's own install.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const ROOT = fs.realpathSync(path.dirname(path.dirname(new URL(import.meta.url).pathname)));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-legacy-")));
const myGroup = spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim();

// Each script, how it's run, and the steps after its preflight that change the machine.
const SCRIPTS = {
  "install.sh": { args: "", steps: ["mac_setup", "linux_setup", "setup_builder", "setup_own_toolchain", "sudo"] },
  "scripts/add-agent-account.sh": {
    args: "agent-x --loopback-only --key /dev/null",
    steps: ["ensure_account", "make_admin_home_private", "join_agent_group", "write_authorized_keys", "prepare_agent_home", "install_token_helper", "reconcile_ssh_access", "ensure_host_keys", "install_dropin", "save_allow_from", "install_loopback_sshd", "trust_loopback_host_key"],
  },
  "scripts/add-phone-service.sh": { args: "agent-x", steps: ["preflight_serve", "choose_port", "install_wrapper", "install_job", "verify_listener", "configure_serve", "pair", "remove"] },
  "scripts/enable-screen-sharing.sh": { args: "", steps: ["install_all", "turn_off", "uninstall_all", "run_check"] },
};

/** A scratch machine: `legacy` is which evidence of a legacy install it has (or none). */
function machine(legacy) {
  const dir = tmp();
  const jobs = path.join(dir, "LaunchDaemons");
  fs.mkdirSync(jobs);
  fs.writeFileSync(path.join(jobs, "dev.blacksand.update.plist"), "");
  const marker = path.join(dir, "t3blackout-build", ".t3blackout-builder");
  if (legacy === "marker") {
    fs.mkdirSync(path.dirname(marker));
    fs.writeFileSync(marker, "");
  }
  if (legacy === "job") fs.writeFileSync(path.join(jobs, "dev.t3blackout.update.plist"), "");
  const group = legacy === "group" ? myGroup : "t3b-no-such-group";
  return { dir, mocks: `LEGACY_MARKERS=(${JSON.stringify(marker)})\nLEGACY_JOB_DIRS=(${JSON.stringify(jobs)} ${JSON.stringify(path.join(dir, "LaunchAgents"))})\nLEGACY_GROUP=${group}` };
}

/** Runs `script`'s main on `m` with its machine-changing steps recorded; the steps that ran. */
function run(script, m) {
  const { args, steps } = SCRIPTS[script];
  const log = path.join(m.dir, "steps.log");
  const stubs = steps.map((name) => `${name}() { echo ${name} >>${JSON.stringify(log)}; return 1; }`).join("\n");
  const result = spawnSync("bash", ["-c", `source ${JSON.stringify(path.join(ROOT, script))}\n${m.mocks}\n${stubs}\nmain ${args}`], { cwd: m.dir, encoding: "utf8" });
  return { result, ran: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [] };
}

for (const script of Object.keys(SCRIPTS)) {
  test(`${script} refuses a machine with a legacy install before it changes anything`, () => {
    for (const legacy of ["marker", "job", "group"]) {
      const { result, ran } = run(script, machine(legacy));
      assert.equal(result.status, 1, `${legacy}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /legacy T3 Blackout install \(.*(\.t3blackout-builder|dev\.t3blackout\.\*|the group ).*\)/, legacy);
      assert.match(result.stderr, /remove the legacy install first/);
      assert.deepEqual(ran, [], `${legacy}: nothing ran`);
    }
  });

  test(`${script} goes on past the check on a machine without one`, () => {
    const { result, ran } = run(script, machine("none"));
    assert.doesNotMatch(result.stderr, /legacy/, result.stderr);
    // The next thing: install.sh's first step, or the sudo check this test can't pass.
    assert.ok(ran.length > 0 || /run with sudo|macOS only/.test(result.stderr), result.stderr);
  });
}

test("--print-policy still works on a legacy machine: it changes nothing", () => {
  const m = machine("job");
  for (const [script, args] of [["scripts/add-phone-service.sh", "--print-policy"], ["scripts/enable-screen-sharing.sh", "--print-policy"]]) {
    const result = spawnSync("bash", ["-c", `source ${JSON.stringify(path.join(ROOT, script))}\n${m.mocks}\nmain ${args}`], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"grants"/);
  }
});
