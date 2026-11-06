// The alert job's issues (.github/workflows/evaluate.yml; the logic is in
// reconcile.mjs):
//   node tooling/blacksand-t3/ci/security-issues.mjs advisories <advisories.json>
//       (written by bin/t3 advisories, against the pin on main)
//   node tooling/blacksand-t3/ci/security-issues.mjs held --channel C --exit N --published REF --pinned REF --newer FILE --report FILE
//       (--published: the ref the commit job pushed, if any; --newer: bin/t3 releases --out)
//   node tooling/blacksand-t3/ci/security-issues.mjs metrics --channel C --run FILE
//       (--run: bin/t3 evaluate --metrics, if the evaluation left it; metrics.mjs). Its
//       problems are warnings and exit 1, which the workflow step doesn't fail the job on.
// GH_TOKEN and GH_REPO set; DRY_RUN=1 reads issues but only prints what it would change.

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import { readOverrides } from "../lib/overrides.mjs";
import { githubClient } from "./github.mjs";
import { metricsStep } from "./metrics.mjs";
import { reconcileAdvisories, reconcileHeld } from "./reconcile.mjs";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string" },
    exit: { type: "string" },
    published: { type: "string" },
    pinned: { type: "string" },
    report: { type: "string" },
    newer: { type: "string" },
    run: { type: "string" },
  },
});

const gh = githubClient({ token: process.env.GH_TOKEN, repo: process.env.GH_REPO, dryRun: process.env.DRY_RUN === "1" });
const readIfThere = (file) => (file && fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** The newer upstream releases bin/t3 releases found for `channel`, or null when it didn't say. */
function readNewer(file, channel) {
  try {
    const found = JSON.parse(readIfThere(file));
    return found?.channel === channel && Array.isArray(found.newer) && found.newer.every((tag) => typeof tag === "string") ? found.newer : null;
  } catch {
    return null;
  }
}

/** This run's page (GitHub Actions sets these), where its log lists every advisory a cut issue list leaves out. */
const run = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;

if (positionals[0] === "advisories" && positionals[1]) {
  await reconcileAdvisories(JSON.parse(fs.readFileSync(positionals[1], "utf8")), gh, { run });
} else if (positionals[0] === "held") {
  const report = readIfThere(values.report);
  // A failed evaluation fails this step too (reconcileHeld throws); its report goes to the log first.
  if (values.exit !== "0" && values.exit !== "3") console.log(report);
  const newer = readNewer(values.newer, values.channel);
  await reconcileHeld({ channel: values.channel, exit: values.exit, published: values.published ?? "", pinned: values.pinned ?? "", newer, report }, gh);
} else if (positionals[0] === "metrics") {
  // Main's own overrides (this checkout), never the evaluate job's word: a held fix they cover was taken by the owner.
  const { problems } = await metricsStep({ channel: values.channel, runFile: values.run ?? null, summaryFile: process.env.GITHUB_STEP_SUMMARY || null, overrides: readOverrides }, gh);
  // A workflow command's data, escaped, so no text in a problem can end the line and start another command.
  const escaped = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const problem of problems) console.log(`::warning title=Age gate metrics::${escaped(problem)}`);
  if (problems.length) process.exitCode = 1;
} else {
  console.error("usage: security-issues.mjs advisories <advisories.json> | held --channel C --exit N --published REF --pinned REF --newer FILE --report FILE | metrics --channel C --run FILE");
  process.exit(2);
}
