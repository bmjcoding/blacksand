// Adapts the existing T3 pin gates to src/trust/check.ts PinGates.
import { openAdvisories } from "./evaluate.mjs";
import { registryTime } from "./gates.mjs";
import { UPSTREAM_URL } from "./git.mjs";
import { checkDependencies, clockProblem, pinGates, reviewApprovals } from "./pin-gates.mjs";
import { log } from "./util.mjs";

/**
 * pinGates reads files at the tip with `git show <at>:<file>`; this answers that
 * from `move.read`, and refuses to stand in for any other git call.
 */
const readerOf = ({ at, read }) => (args) => {
  const [command, spec = ""] = args;
  if (command !== "show" || args.length !== 2 || !spec.startsWith(`${at}:`)) throw new Error(`the pin gates asked git for ${args.join(" ")}`);
  const text = read(spec.slice(at.length + 1));
  return text === null ? { status: 128, stdout: "", stderr: "" } : { status: 0, stdout: text, stderr: "" };
};

/** The gates, with lib/selfupdate.mjs verifyHead's options and defaults (all but `report` are for tests). */
export function t3Gates({ upstream = UPSTREAM_URL, report = log, isKnownHost = null, reviewClosure, advisories = openAdvisories, now = Date.now(), clock = registryTime } = {}) {
  const gate = (move, check, aged) =>
    pinGates(readerOf(move), { short: move.short, before: move.before, after: move.after, at: move.at, upstream, isKnownHost, reviewClosure, advisories, now, report, aged, check });
  return {
    approvals: (move) => gate(move, reviewApprovals, { taken: false }),
    async dependencies(move) {
      const aged = { taken: false };
      return (await gate(move, checkDependencies, aged)) ?? { aged: aged.taken };
    },
    clock: () => clockProblem(clock, now),
  };
}
