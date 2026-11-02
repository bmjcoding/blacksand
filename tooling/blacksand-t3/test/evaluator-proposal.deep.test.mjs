// Execute the workflow's actual inline proposal script against disposable Git
// indexes, hostile attributes/drivers/hooks and data. No signing or push.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYaml } from "../lib/yaml.mjs";

const workflow = parseYaml(fs.readFileSync(new URL("../../../.github/workflows/evaluate.yml", import.meta.url), "utf8"), { blockScalars: true })[0];
const script = workflow.jobs.commit.steps.find(step => step.id === "proposal").run;
const pinPath = "tooling/blacksand-t3/pin.json";
const basePin = JSON.stringify({ channels: { nightly: { ref: "v1.0.0", sha: "a".repeat(40) } } }) + "\n";
const changedPin = JSON.stringify({ channels: { nightly: { ref: "v1.0.1", sha: "b".repeat(40) } } }) + "\n";

test("actual credential-job proposal accepts only a pin tree on the exact independently checked main SHA", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacksand-proposal-"));
  const env = { PATH: process.env.PATH, HOME: root, LANG: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (repo, args) => {
    const r = spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", ...args], { env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim();
  };
  try {
    for (const name of ["valid", "extra-artifact", "wrong-sha", "sha-injection", "symlink-sha", "unchanged", "missing-pin", "symlink-pin", "extra-staged", "missing-channel", "numeric-ref", "shell-ref", "newline-ref", "trailing-newline-ref", "second-document", "upper-publish", "mixed-publish", "empty-publish", "false-publish", "unrelated-publish", "space-publish", "wrong-ref", "upper-ref"]) {
      const repo = path.join(root, name); fs.mkdirSync(repo);
      git(repo, ["init", "-q", "-b", "main"]);
      fs.mkdirSync(path.join(repo, path.dirname(pinPath)), { recursive: true });
      fs.writeFileSync(path.join(repo, pinPath), basePin);
      git(repo, ["add", pinPath]);
      git(repo, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--no-gpg-sign", "-m", "fixture"]);
      const head = git(repo, ["rev-parse", "HEAD"]);
      const temp = path.join(repo, "runner-temp"); const pinDir = path.join(temp, "pin"); fs.mkdirSync(pinDir, { recursive: true });
      const pin = path.join(pinDir, "pin.json"), sha = path.join(pinDir, "main-sha"), marker = path.join(temp, "executed");
      fs.writeFileSync(pin, changedPin); fs.writeFileSync(sha, head + "\n");
      if (name === "wrong-sha") fs.writeFileSync(sha, "0".repeat(40) + "\n");
      if (name === "sha-injection") fs.appendFileSync(sha, "BASH_ENV=/evil\ntree=evil\n");
      if (name === "symlink-sha") { fs.renameSync(sha, sha + ".target"); fs.symlinkSync(sha + ".target", sha); }
      if (name === "unchanged") fs.writeFileSync(pin, basePin);
      if (name === "missing-pin") fs.rmSync(pin);
      if (name === "symlink-pin") { fs.rmSync(pin); fs.symlinkSync(path.join(repo, pinPath), pin); }
      if (name === "extra-staged") { fs.writeFileSync(path.join(repo, "extra"), "extra"); git(repo, ["add", "extra"]); }
      if (name === "extra-artifact") fs.writeFileSync(path.join(pinDir, "BASH_ENV"), `touch '${marker}'\n`);
      const badRefs = { "numeric-ref": 123, "shell-ref": `v1$(touch '${marker}')`, "newline-ref": "v1\nref=evil", "trailing-newline-ref": "v1\n" };
      if (name in badRefs) fs.writeFileSync(pin, JSON.stringify({ channels: { nightly: { ref: badRefs[name] } } }));
      if (name === "missing-channel") fs.writeFileSync(pin, '{"channels":{}}\n');
      if (name === "second-document") fs.appendFileSync(pin, changedPin);
      const driver = path.join(temp, "driver"); fs.writeFileSync(driver, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 });
      fs.writeFileSync(path.join(repo, ".gitattributes"), `${pinPath} filter=trap diff=trap\n`);
      for (const key of ["filter.trap.clean", "filter.trap.smudge", "diff.trap.command"]) git(repo, ["config", key, driver]);
      for (const hook of ["pre-commit", "post-checkout", "pre-push"]) fs.writeFileSync(path.join(repo, ".git/hooks", hook), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
      fs.writeFileSync(path.join(repo, "tooling/blacksand-t3/bin"), `touch '${marker}'\n`);
      const output = path.join(temp, "output");
      const switches = { "upper-publish": "TRUE", "mixed-publish": "tRuE", "empty-publish": "", "false-publish": "false", "unrelated-publish": "1", "space-publish": "true " };
      const publish = switches[name] ?? "true";
      const ref = name === "wrong-ref" ? "refs/heads/feature" : name === "upper-ref" ? "refs/heads/Main" : "refs/heads/main";
      const result = spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { cwd: repo, env: { ...env, RUNNER_TEMP: temp, GITHUB_OUTPUT: output, CHANNEL: "nightly", PUBLISH: publish, GITHUB_REF: ref }, encoding: "utf8", timeout: 5000 });
      const success = ["valid", "extra-artifact"].includes(name);
      assert.equal(result.status === 0, success, `${name}: ${result.stdout} ${result.stderr}`);
      assert.ok(!fs.existsSync(marker), name);
      if (success) {
        const values = Object.fromEntries(fs.readFileSync(output, "utf8").trim().split("\n").map(line => line.split("=")));
        assert.match(values.tree, /^[0-9a-f]{40}$/);
        assert.equal(git(repo, ["diff-tree", "-r", "--name-only", "HEAD", values.tree]), pinPath);
        assert.equal(values.ref, "v1.0.1");
      }
      if (name === "valid") {
        git(repo, ["hash-object", `--path=${pinPath}`, pin]);
        assert.ok(fs.existsSync(marker), "positive control: filters really execute without --no-filters");
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
