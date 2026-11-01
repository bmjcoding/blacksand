// node --test test/*.test.mjs: CI's own checks (.github/scripts/): action pins
// read from parsed YAML, the runner fragment, stripped tests' destinations,
// entry points found through symlinked paths, which channels a pin change
// builds, newer upstream releases, and which channels a machine builds
// (lib/channels.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { channelsToBuild } from "../.github/scripts/build-channels.mjs";
import { checkFiles, unpinned, usesValues } from "../.github/scripts/check-action-pins.mjs";
import { isMain } from "../.github/scripts/is-main.mjs";
import { decodeTemplate, runnerFromTunnel } from "../.github/scripts/render-runner.mjs";
import { destinationOf } from "../.github/scripts/stripped-tests.mjs";
import { channelPolicy, unpinnedProblem } from "../lib/channels.mjs";
import { newerReleases } from "../lib/evaluate.mjs";
import { parseYaml } from "../lib/yaml.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const PINNED = "v0.1.6-nightly.20261030.3917";

test("action pins are read the way YAML reads them: quoted or not, comments stripped", () => {
  const workflow = [
    "jobs:",
    "  a:",
    "    steps:",
    `      - uses: actions/checkout@${SHA} # v7.0.1`,
    `      - uses: "actions/setup-node@${SHA}"`,
    `      - uses: 'actions/cache@${SHA}' # quoted, then a comment`,
    "      - uses: actions/upload-artifact@v4",
    "      - uses: ./local-action",
    "      - uses: docker://alpine:3.20",
    "      - run: |",
    "          echo uses: nothing",
  ].join("\n");
  const values = usesValues(workflow);
  assert.deepEqual(values.map((v) => v.value), [`actions/checkout@${SHA}`, `actions/setup-node@${SHA}`, `actions/cache@${SHA}`, "actions/upload-artifact@v4", "./local-action", "docker://alpine:3.20"]);
  assert.deepEqual(values.map((v) => unpinned(v.value)), [null, null, null, "not pinned to a full commit SHA", null, "docker image without a sha256 digest"]);
  assert.equal(unpinned(`actions/checkout@${SHA.slice(0, 39)}`), "not pinned to a full commit SHA");
});

test("the runner fragment decodes as its template literal would, and refuses what would break it", () => {
  assert.equal(decodeTemplate('A="\\${HOME:-x}" printf \'%s\\\\n\' "$A"'), 'A="${HOME:-x}" printf \'%s\\n\' "$A"');
  assert.throws(() => decodeTemplate('echo "${HOME}"'), /unescaped \$\{/);
  assert.throws(() => decodeTemplate("echo `date`"), /unescaped backtick/);
  const tunnel = "const X = 1;\nconst REMOTE_RUNNER_SCRIPT = `#!/bin/sh\nset -eu\n@@T3_NODE_ENV_SCRIPT@@\nV=@@T3_ARCHIVE_VERSION@@\necho \"\\${V}\"\n`;\nconst Y = `${X}`;\n";
  assert.equal(runnerFromTunnel(tunnel), "#!/bin/sh\nset -eu\n:\nV=''\necho \"${V}\"\n");
  assert.throws(() => runnerFromTunnel("const Z = 1;"), /no REMOTE_RUNNER_SCRIPT/);
});

test("the injected SSH runner, rendered, parses as /bin/sh", () => {
  const fragment = fs.readFileSync(new URL("../lib/files/ssh-runner-blackout.sh", import.meta.url), "utf8");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-runner-"));
  try {
    const file = path.join(dir, "runner.sh");
    fs.writeFileSync(file, `#!/bin/sh\n${decodeTemplate(fragment)}`);
    const result = spawnSync("sh", ["-n", file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("every stripped test says where in upstream it goes", () => {
  const dir = new URL("../test/stripped/", import.meta.url);
  const files = fs.readdirSync(dir).filter((name) => /\.test\.tsx?$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) assert.match(destinationOf(fs.readFileSync(new URL(name, dir), "utf8"), name), /^(apps|packages)\//, name);
  assert.throws(() => destinationOf("// Copied to ../../etc/ in a stripped upstream checkout", "x.test.ts"), /doesn't start with/);
  assert.throws(() => destinationOf("// nothing here", "x.test.ts"), /doesn't start with/);
});

test("with a pin.json, a channel it doesn't pin is refused unless --unpinned", () => {
  const pin = { version: 1, channels: { nightly: { ref: "v0.1.6-nightly.20261030.3917", sha: "9".repeat(40), evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } }, deviceTools: [] };
  assert.match(unpinnedProblem(pin, "stable", { soakHours: 48 }), /stable channel has no evaluated release.*switch the update track to nightly, or pass --unpinned/);
  assert.equal(unpinnedProblem(pin, "stable", { unpinned: true, soakHours: 48 }), null);
  assert.equal(unpinnedProblem(pin, "nightly", { soakHours: 48 }), null);
  assert.equal(unpinnedProblem(null, "stable", { soakHours: 48 }), null, "no pin.json: the legacy soak");
});

test("status names the pin and the gates that chose it, not a fixed soak", () => {
  const pin = { version: 1, channels: { nightly: { ref: "v0.1.6-nightly.20261030.3917", sha: "97e35bcf23e4dcf34c2dcffadd37c08db0e01e52", evaluatedAt: "2026-10-30T17:46:51.852Z", leftOut: [] } }, deviceTools: [] };
  const pinned = channelPolicy(pin, "nightly", { soakHours: 48, minAgeDays: 3 });
  assert.match(pinned, /^nightly: pinned to v0\.1\.6-nightly\.20261030\.3917 \(97e35bcf23\), evaluated 2026-10-30T17:46:51\.852Z: new dependencies at least 3 days old/);
  assert.doesNotMatch(pinned, /48h/);
  assert.match(channelPolicy(pin, "stable", { soakHours: 48, minAgeDays: 3 }), /^stable: not pinned, so updates are refused/);
  assert.match(channelPolicy(null, "stable", { soakHours: 48, minAgeDays: 3 }), /no pin\.json, so the newest release 48h old/);
});

// ------------------------------------------------------- action pins -------

test("a `uses` in a flow mapping or under a quoted key is checked; one inside a script isn't", () => {
  const workflow = [
    "on: push",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - { uses: actions/checkout@v4 }",
    '      - "uses": actions/setup-node@v4',
    `      - 'uses': "actions/cache@${SHA}"`,
    "      - run: |",
    "          echo uses: not-an-action",
    "          uses: also-not",
    "      - name: folded",
    "        run: >-",
    "          uses: nothing",
    "  b:",
    "    uses: org/repo/.github/workflows/reusable.yml@main",
  ].join("\n");
  assert.deepEqual(usesValues(workflow), [
    { line: 6, value: "actions/checkout@v4" },
    { line: 7, value: "actions/setup-node@v4" },
    { line: 8, value: `actions/cache@${SHA}` },
    { line: 16, value: "org/repo/.github/workflows/reusable.yml@main" },
  ]);
  const problems = checkFiles(["w.yml"], () => workflow);
  assert.deepEqual(problems, [
    "w.yml:6: actions/checkout@v4: not pinned to a full commit SHA",
    "w.yml:7: actions/setup-node@v4: not pinned to a full commit SHA",
    "w.yml:16: org/repo/.github/workflows/reusable.yml@main: not pinned to a full commit SHA",
  ]);
  // A `uses` that isn't a string can't be pinned.
  assert.match(checkFiles(["w.yml"], () => "jobs:\n  a:\n    steps:\n      - uses: { x: 1 }\n")[0], /\(a mapping\): not pinned/);
});

test("YAML the checker can't read fails the check instead of hiding a `uses`", () => {
  const anchored = ["x: &step", "  uses: actions/checkout@v4", "jobs:", "  a:", "    steps:", "      - *step"].join("\n");
  assert.match(checkFiles(["w.yml"], () => anchored)[0], /^w\.yml: can't read it as YAML, so its actions can't be checked: .*anchors/);
});

test("the repo's own workflows parse, and every action in them is pinned", () => {
  const dir = path.join(ROOT, ".github", "workflows");
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => path.join(dir, f));
  assert.ok(files.length >= 3);
  assert.deepEqual(checkFiles(files), []);
  for (const file of files) assert.ok(usesValues(fs.readFileSync(file, "utf8")).length > 0, file);
});

test("block scalars read as YAML 1.2 does, and only where asked for: lockfiles stay strict", () => {
  const read = (text) => parseYaml(text, { blockScalars: true })[0];
  assert.deepEqual(read("a: |\n  x\n  y\n\nb: 1\n"), { a: "x\ny\n", b: 1 });
  assert.deepEqual(read("a: >\n  x\n  y\n\n  z\n   more\n  w\n"), { a: "x y\nz\n more\nw\n" });
  assert.deepEqual(read("a: |-\n  x\n\n"), { a: "x" });
  assert.deepEqual(read("a: |+\n  x\n\n\nb: 2\n"), { a: "x\n\n\n", b: 2 });
  assert.deepEqual(read("- |\n  one\n  # not a comment\n- two\n"), ["one\n# not a comment\n", "two"]);
  assert.deepEqual(read("a: |\nb: 1\n"), { a: "", b: 1 });
  assert.deepEqual(read("a:\n  - run: |\n      x\n      \ttabbed\n    name: n\n"), { a: [{ run: "x\n\ttabbed\n", name: "n" }] });
  assert.throws(() => read("a: |2\n  x\n"), /indentation indicators/);
  assert.throws(() => read("a: 1\n\tb: 2\n"), /tabs can't indent YAML/);
  assert.throws(() => parseYaml("a: |\n  x\n"), /block scalars aren't supported/);
  assert.throws(() => parseYaml("a: 1\n\tb: 2\n"), /tabs can't indent YAML/);
});

// ------------------------------------------------------- entry points ------

test("CI scripts run when invoked through a symlinked path, as /tmp is on macOS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-is-main-"));
  try {
    const link = path.join(dir, "scripts");
    fs.symlinkSync(path.join(ROOT, ".github", "scripts"), link);
    // Without its checkout argument it must complain, not exit 0 having done nothing.
    const stripped = spawnSync(process.execPath, [path.join(link, "stripped-tests.mjs")], { encoding: "utf8" });
    assert.equal(stripped.status, 2, stripped.stderr);
    assert.match(stripped.stderr, /usage: stripped-tests\.mjs/);
    fs.writeFileSync(path.join(dir, "bad.yml"), "jobs:\n  a:\n    steps:\n      - { uses: actions/checkout@v4 }\n");
    const pins = spawnSync(process.execPath, [path.join(link, "check-action-pins.mjs"), path.join(dir, "bad.yml")], { encoding: "utf8" });
    assert.equal(pins.status, 1);
    assert.match(pins.stderr, /actions\/checkout@v4: not pinned/);
    const runner = spawnSync(process.execPath, [path.join(link, "render-runner.mjs")], { encoding: "utf8" });
    assert.notEqual(runner.status, 0, "no arguments is an error, not a silent no-op");
    // Imported, it's not the entry point.
    assert.equal(isMain(pathToFileURL(path.join(ROOT, ".github", "scripts", "stripped-tests.mjs")).href, [process.execPath, path.join(link, "check-action-pins.mjs")]), false);
    assert.equal(isMain(pathToFileURL(path.join(ROOT, ".github", "scripts", "stripped-tests.mjs")).href, [process.execPath]), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ----------------------------------------------------------- build.yml -----

test("a pin-only change builds the channels it moved; anything else builds every pinned channel", () => {
  const entry = (ref) => ({ ref, sha: "a".repeat(40), evaluatedAt: "2026-10-30T00:00:00Z", leftOut: [] });
  const before = { version: 1, channels: { nightly: entry("v0.1.6-nightly.20261030.3917"), stable: entry("v0.1.6") }, deviceTools: [] };
  const nightlyMoved = { ...before, channels: { ...before.channels, nightly: entry("v0.1.7-nightly.20261031.4001") } };
  assert.deepEqual(channelsToBuild({ pin: nightlyMoved, basePin: before, changedFiles: ["pin.json"] }), ["nightly"]);
  assert.deepEqual(channelsToBuild({ pin: nightlyMoved, basePin: before, changedFiles: ["pin.json", "lib/rules.mjs"] }), ["nightly", "stable"]);
  assert.deepEqual(channelsToBuild({ pin: { ...before, deviceTools: ["x@1.0.0"] }, basePin: before, changedFiles: ["pin.json"] }), ["nightly", "stable"], "device tools are every channel's");
  assert.deepEqual(channelsToBuild({ pin: before, basePin: null, changedFiles: null }), ["nightly", "stable"], "no base: everything");
  const added = { ...before, channels: { ...before.channels, preview: entry("v0.1.7-preview.20261031.1") } };
  assert.deepEqual(channelsToBuild({ pin: added, basePin: before, changedFiles: ["pin.json"] }), ["preview"]);
  const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "build.yml"), "utf8");
  const on = parseYaml(workflow, { blockScalars: true })[0].on;
  for (const trigger of ["push", "pull_request"]) assert.ok(on[trigger].paths.includes("pin.json"), trigger);
});

test("newer releases are every release tag on the channel past the pin, however many", () => {
  const tags = Array.from({ length: 8 }, (_, i) => `v0.1.7-nightly.20261031.${4000 + i}`);
  assert.equal(newerReleases([...tags, PINNED, "v0.1.7", "v0.1.7-nightly.bad"], "nightly", PINNED).length, 8);
  assert.deepEqual(newerReleases([PINNED], "nightly", PINNED), []);
});
