// The credential runner must never execute App-writable repository code.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { parseYaml } from "../lib/yaml.mjs";

const text = fs.readFileSync(new URL("../../../.github/workflows/evaluate.yml", import.meta.url), "utf8");
const workflow = parseYaml(text, { blockScalars: true })[0];
const { evaluate, check, commit, alerts } = workflow.jobs;

test("evaluation and independent checking work without publisher configuration", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["evaluate", "check", "commit", "alerts"]);
  for (const job of [evaluate, check]) {
    assert.equal(job.environment, undefined);
    assert.equal(job.permissions.contents, "read");
    assert.ok(!JSON.stringify(job).includes("secrets."));
    assert.ok(!JSON.stringify(job).includes("BLACKSAND_EVALUATOR_PUBLISH"));
  }
  assert.equal(check.needs, "evaluate");
  assert.equal(check.steps.find(step => step.run)?.env?.BLACKSAND_T3_GITHUB_TOKEN, "${{ github.token }}");
  assert.ok(evaluate.steps.some(step => step.run?.includes("--build --write")));
  assert.ok(check.steps.some(step => step.run?.includes("pin-check --channel")));
  assert.equal(commit.if, "needs.check.outputs.verdict == 'changed' && vars.BLACKSAND_EVALUATOR_PUBLISH == 'true' && github.ref == 'refs/heads/main'");
  assert.equal(commit.environment, "evaluator");
  assert.deepEqual(commit.permissions, { contents: "read" });
  assert.deepEqual(alerts.permissions, { contents: "read", issues: "write" });
});

test("both handoffs select immutable artifact IDs and the credential job uses only pinned GitHub actions and inline shell", () => {
  assert.equal(check.steps.find(step => step.uses?.startsWith("actions/download-artifact@"))?.with["artifact-ids"], "${{ needs.evaluate.outputs.artifact }}");
  assert.equal(commit.steps.find(step => step.uses?.startsWith("actions/download-artifact@"))?.with["artifact-ids"], "${{ needs.check.outputs.pin }}");
  assert.equal(commit.defaults.run["working-directory"], ".");
  for (const step of commit.steps) {
    if (step.uses) assert.match(step.uses, /^actions\/(?:checkout|download-artifact|create-github-app-token)@[0-9a-f]{40}$/);
    if (!step.run) continue;
    assert.ok(!step.run.includes("${{"), "no expression-to-shell interpolation");
    assert.doesNotMatch(step.run, /\b(?:node|npm|pnpm|npx|source|eval)\b|uses:\s*\.\//);
  }
  const proposalStep = commit.steps.find(step => step.id === "proposal");
  assert.equal(proposalStep.env.PUBLISH, "${{ vars.BLACKSAND_EVALUATOR_PUBLISH }}");
  const proposal = proposalStep.run;
  assert.match(proposal, /cmp -s - "\$sha"/);
  assert.match(proposal, /hash-object -w --no-filters/);
  assert.match(proposal, /\[ "\$changed" = tooling\/blacksand-t3\/pin.json \]/);
  const app = commit.steps.find(step => step.id === "app-token");
  assert.equal(app.with["permission-contents"], "write");
  assert.equal(app.with.owner, undefined);
  assert.equal(app.with.repositories, undefined); // action defaults to this repository alone
  const push = commit.steps.find(step => step.id === "push").run;
  assert.match(push, /commit-tree -S -p HEAD/);
  assert.match(push, /push origin "\$commit:refs\/heads\/main"/);
  assert.doesNotMatch(push, /--force|--delete|\brebase\b|\bmerge\b/);
  assert.ok(commit.steps.indexOf(app) > commit.steps.findIndex(step => step.id === "proposal"));
});

test("the age gate's metrics run last in the alerts job and never fail it; the evaluate job hands them over in its artifact", () => {
  assert.ok(evaluate.steps.find(step => step.id === "evaluate").run.includes('--metrics "$RUNNER_TEMP/out/metrics.json"'));
  const metrics = alerts.steps.at(-1);
  assert.equal(metrics.name, "Age gate metrics");
  assert.equal(metrics.if, "always()");
  assert.equal(metrics["continue-on-error"], true, "a metrics failure is a warning, never the job's");
  assert.ok(metrics["timeout-minutes"] > 0 && metrics["timeout-minutes"] < alerts["timeout-minutes"], "and it can't use up the job's time");
  assert.match(metrics.run, /^node ci\/security-issues\.mjs metrics --channel "\$CHANNEL" --run "\$RUNNER_TEMP\/evaluation\/metrics\.json"$/);
  assert.ok(!metrics.run.includes("${{"), "no expression-to-shell interpolation");
  // The security work comes first, and doesn't depend on it.
  const names = alerts.steps.map(step => step.name).filter(Boolean);
  assert.deepEqual(names.slice(-3), ["Security advisories", "Held releases", "Age gate metrics"]);
});
