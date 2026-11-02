import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
const installer = fs.realpathSync(new URL("../install.sh", import.meta.url));
function cutover({ role = "ui", platform = "Darwin", unisolated = false, signing = true, apps = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-cutover-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin/t3"), `#!/bin/sh\necho "$*" >> "$HOME/steps"\nif [ "$1 $2" = "signing status" ]; then echo 'signing: ${signing ? "T3 Blackout Local Signing" : "not set up (ad-hoc)"}'; fi\n`, { mode: 0o755 });
  const script = `test_platform="$3"
source "$1" --ui-cutover --role "$2" ${unisolated ? "--unisolated-build" : ""}
cd "$HOME"
uname() { echo "$test_platform"; }
refuse_legacy_install() { die 'normal legacy refusal'; }
mac_setup() { echo mac_setup >> "$HOME/steps"; }
linux_setup() { echo linux_setup >> "$HOME/steps"; }
builder_sudo() { return 0; }
setup_builder() { echo setup_builder >> "$HOME/steps"; }
main`;
  try {
    const result = spawnSync("bash", ["-c", script, "test", installer, role, platform], { encoding: "utf8", env: { ...process.env, HOME: dir, BLACKSAND_T3_HOME: path.join(dir, ".blacksand/t3"), BLACKSAND_T3_APPS: apps ? path.join(dir, "Applications") : "/Applications" } });
    return { ...result, steps: fs.existsSync(path.join(dir, "steps")) ? fs.readFileSync(path.join(dir, "steps"), "utf8").trim().split("\n") : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
test("explicit UI cutover uses an isolated build, stages only and never schedules or activates", () => {
  const result = cutover();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.steps, ["signing status", "mac_setup", "setup_builder", "configure --role ui", "update --force --stage-only"]);
  assert.match(result.stdout, /profile cutover, run: blacksand t3 launch/);
  assert.doesNotMatch(result.stdout, /apply-pending/);
});
test("cutover refuses host roles, unsupported platforms, signing gaps and isolation/location shortcuts before setup", () => {
  for (const options of [{ role: "host" }, { role: "both" }, { platform: "Linux" }, { unisolated: true }, { signing: false }, { apps: false }]) {
    const result = cutover(options);
    assert.equal(result.status, 1, JSON.stringify(options));
    assert.ok(result.steps.every((step) => step === "signing status"), result.steps.join("\n"));
  }
});
