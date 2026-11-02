// T3 pin gates, shared by the current TS verifier and the frozen differential oracle.
import { makeFastLane } from "./fastlane.mjs";
import { releaseSnapshot } from "./git.mjs";
import { MIN_AGE_DAYS, dependencyAgeGate, heldDependencies, lockIdentities, reviewAddedDeviceTools } from "./gates.mjs";
import { DEVICE_TOOL_PINS, deviceToolsInUse, toolNames, trustedInventory } from "./inventory.mjs";
import { parseOverrides, parseToolOverrides } from "./overrides.mjs";
import { unreleasedPin } from "./pin.mjs";
const CLOCK_SLACK = 10 * 60_000;
const KNOWN_DEVICE_TOOLS = "lib/known-device-tools.txt";
const KNOWN_HOSTS = "lib/known-hosts.txt";
const OVERRIDES = "lib/overrides.json";
const outOf = (git) => (args) => { const result = git(args); return result.status === 0 ? result.stdout.trim() : null; };
/** Device tools `next` approves, or locks, that `previous` didn't. */
export const addedApprovals = (previous, next) =>
  new Set([
    ...next.deviceTools.filter((tool) => !previous.deviceTools.includes(tool)),
    ...Object.keys(next.deviceToolLocks ?? {}).filter((tool) => !Object.hasOwn(previous.deviceToolLocks ?? {}, tool)),
  ]);

/** A list file's entries at a commit (comments and blank lines dropped); empty when the file isn't there. */
const listAt = (out, rev, file) =>
  (out(["show", `${rev}:${file}`]) ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);

/**
 * The fast lane (lib/fastlane.mjs) for dependencies new since the release with
 * lockfile `baseLock`, from what only upstream (that release's lockfile and
 * device tool pins, `toolsText`) and the owner (`overrides`, `toolOverrides`)
 * wrote. Made once, on the first young version; when it can't be (an advisory
 * source unreachable, say), nothing is waived, which only ever holds more back.
 * Whether a fix is still flagged is asked of the same `advisories`.
 */
function lazyFastLane({ baseLock, toolsText, overrides, toolOverrides, advisories, now }) {
  let lane = null;
  const make = async () => {
    try {
      const tools = deviceToolsInUse(toolsText(), toolOverrides());
      const packages = trustedInventory({ upstreamLock: baseLock, deviceTools: tools, overrides: overrides() });
      const watch = toolNames(tools);
      return makeFastLane({ basePackages: packages, openAdvisories: await advisories(packages, { watch }), now, watch, advisories });
    } catch {
      return null;
    }
  };
  return async (pkg) => {
    lane ??= make();
    const waive = await lane;
    return waive ? waive(pkg) : null;
  };
}

/** The owner's device tool overrides as committed at `at` (the evaluator can't change them: botShape). */
const toolOverridesAt = (out, at) => {
  const text = out(["show", `${at}:${OVERRIDES}`]);
  return text === null ? [] : parseToolOverrides(text);
};

/**
 * The device tools an evaluator commit approves (or locks) in `after` over
 * `before`, checked against the releases it moves to (`moved`, read from
 * `snapshot`): each must be one a build of them installs, raised by the owner's
 * device tool overrides as `at` has them, and pass review with its dependency
 * closure (a young version only through the tool's fast lane). Returns {
 * result, message } or null.
 */
export async function reviewApprovals({ short, before, after, moved, snapshot, out, at, isKnownHost, reviewClosure, advisories, now, report }) {
  const approved = [...addedApprovals(before, after)];
  const raise = toolOverridesAt(out, at);
  const pinned = new Set(moved.flatMap(([, entry]) => deviceToolsInUse(snapshot.show(entry.sha, DEVICE_TOOL_PINS), raise)));
  const stray = approved.filter((tool) => !pinned.has(tool));
  if (stray.length) return { result: "refused", message: `evaluator commit ${short} approves ${stray.join(", ")}, which ${moved.map(([, entry]) => entry.ref).join(", ")} doesn't pin` };
  const known = new Set(listAt(out, at, KNOWN_HOSTS));
  const { isReservedHost } = isKnownHost ? {} : await import("./build.mjs");
  let reviews;
  try {
    reviews = await reviewAddedDeviceTools(before.deviceTools, after.deviceTools, {
      knownDeviceTools: listAt(out, at, KNOWN_DEVICE_TOOLS),
      isKnownHost: isKnownHost ?? ((host) => known.has(host) || isReservedHost(host)),
      closure: reviewClosure,
      locks: after.deviceToolLocks ?? {},
      previousLocks: before.deviceToolLocks ?? {},
      advisories,
      toolOverrides: raise,
      now,
    });
  } catch (error) {
    return { result: "skipped", message: `couldn't review the device tools evaluator commit ${short} approves (${error.message})` };
  }
  const failed = reviews.find((review) => !review.ok);
  if (failed) return { result: "refused", message: `evaluator commit ${short} approves device tool ${failed.tool}, which fails review here: ${failed.reasons.join("; ")}` };
  for (const note of reviews.flatMap((review) => review.notes ?? [])) if (note.startsWith("fast lane: ")) report(`evaluator commit ${short}: ${note}`);
  return null;
}

/**
 * The dependency versions each release in `moved` adds over the one `before`
 * names (which this clone already trusts): each at least MIN_AGE_DAYS old, with
 * its bytes kept and the registry's, unless the fast lane waives it. Returns {
 * result, message } or null; `aged` hears whether any version was added (an
 * admission resting on this machine's clock).
 */
export async function checkDependencies({ short, before, moved, snapshot, out, at, advisories, now, report, aged }) {
  for (const [channel, entry] of moved) {
    const previous = before.channels[channel];
    const [baseLock, lock] = [snapshot.show(previous.sha, "pnpm-lock.yaml"), snapshot.show(entry.sha, "pnpm-lock.yaml")];
    if (!baseLock || !lock) return { result: "refused", message: `evaluator commit ${short}: no pnpm-lock.yaml at ${baseLock ? entry.ref : previous.ref}` };
    try {
      lockIdentities(baseLock);
      lockIdentities(lock);
    } catch (error) {
      return { result: "refused", message: `evaluator commit ${short} pins ${entry.ref}, whose dependencies can't be checked: ${error.message}` };
    }
    const waive = lazyFastLane({
      baseLock,
      toolsText: () => snapshot.show(previous.sha, DEVICE_TOOL_PINS),
      overrides: () => {
        const text = out(["show", `${at}:${OVERRIDES}`]);
        return text === null ? [] : parseOverrides(text);
      },
      toolOverrides: () => toolOverridesAt(out, at),
      advisories,
      now,
    });
    let gate;
    try {
      gate = await dependencyAgeGate(baseLock, lock, { waive, now });
    } catch (error) {
      return { result: "skipped", message: `couldn't check the dependencies ${entry.ref} adds (${error.message})` };
    }
    if (gate.substituted.length) {
      return { result: "refused", message: `evaluator commit ${short} pins ${entry.ref}, which changes or misstates dependencies' bytes: ${heldDependencies({ young: [], unknown: [], substituted: gate.substituted }).join(", ")}` };
    }
    const held = heldDependencies(gate);
    if (held.length) {
      return { result: "held", message: `evaluator commit ${short} pins ${entry.ref}, which adds dependencies under ${MIN_AGE_DAYS} days old over ${previous.ref}; waiting until they're old enough: ${held.join(", ")}` };
    }
    for (const { pkg, reason } of gate.waived) report(`evaluator commit ${short}: fast lane: ${pkg}: ${reason}`);
    if (gate.added) aged.taken = true;
  }
  return null;
}

/**
 * `check` (reviewApprovals or checkDependencies) on a move from pin `before` to
 * `after` (both valid, `after` only forward of `before`: botShape), told as
 * evaluator commit `short`'s, once each channel it moves names the commit its
 * tag points at upstream; the owner's overrides and lists as `at` has them.
 * { result: "refused" | "held" | "skipped", message } or null.
 */
export async function pinGates(git, { short, before, after, upstream, check, ...rest }) {
  const moved = Object.entries(after.channels).filter(([channel, entry]) => before.channels[channel].ref !== entry.ref || before.channels[channel].sha !== entry.sha);
  if (!moved.length) return null;
  try {
    const why = unreleasedPin(before, after, upstream);
    if (why) return { result: "refused", message: `evaluator commit ${short} ${why}` };
  } catch (error) {
    return { result: "skipped", message: `couldn't check the tags evaluator commit ${short} pins upstream (${error.message})` };
  }
  let snapshot;
  try {
    // The releases it moves to by tag (just checked upstream); the ones it moves
    // from by commit: they're trusted already, whatever their tags say now.
    snapshot = releaseSnapshot(
      moved.map(([, entry]) => ({ ref: entry.ref, sha: entry.sha })),
      { url: upstream, trusted: moved.map(([channel]) => before.channels[channel].sha) },
    );
  } catch (error) {
    return { result: error.transient ? "skipped" : "refused", message: `evaluator commit ${short}: ${error.message}` };
  }
  try {
    return await check({ short, before, after, moved, snapshot, out: outOf(git), ...rest });
  } catch (error) {
    return { result: error.transient ? "skipped" : "refused", message: `evaluator commit ${short}: ${error.message}` };
  } finally {
    snapshot.close();
  }
}

/**
 * Whether ages measured at `now`, by this machine's clock, can be taken: null
 * when it's no more than CLOCK_SLACK ahead of `clock`'s time (the registry's,
 * lib/gates.mjs registryTime), else "held" (a clock behind only holds more
 * back), or "skipped" when the registry can't be asked.
 */
export async function clockProblem(clock, now) {
  let at;
  try {
    at = await clock();
    if (!Number.isFinite(at)) throw new Error("it sent no time");
  } catch (error) {
    return { result: "skipped", message: `couldn't check this machine's clock against the npm registry's (${error.message})` };
  }
  if (now - at <= CLOCK_SLACK) return null;
  const minutes = Math.round((now - at) / 60_000);
  const by = minutes < 120 ? `${minutes} minutes` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} hours` : `${Math.round(minutes / 1440)} days`;
  const fix = process.platform === "darwin" ? "this Mac's clock is ahead; turn on Set time automatically (System Settings > General > Date & Time)" : "this machine's clock is ahead; turn on network time (timedatectl set-ntp true)";
  return { result: "held", message: `${fix}: it's ${by} ahead of the npm registry's, and dependency ages are measured by it` };
}
