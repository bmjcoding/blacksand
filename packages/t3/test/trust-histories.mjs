// Generated signed histories, for the differential between the old verifier
// (lib/selfupdate.mjs) and the new one (src/trust): each seed makes one history
// of owner and evaluator commits, signer-list changes and key rotations, merges,
// forged and missing signatures, then a clone state to verify it in (a record of
// what was verified, a shallow or incomplete clone, this machine's and the
// registry's clocks). Every history is written in today's layout and both
// verifiers judge it; some are written again in the monorepo layout (or across
// the move between the two), where only the new verifier can judge them, and
// its verdict must match the old one's on today's layout, commit for commit.
//
// Commits are written as objects straight from JavaScript (test/trust-objects.mjs),
// so a history costs the verifiers' own git and ssh-keygen calls and little
// else. Runs in worker threads: runShards() spreads seeds over them.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { DAY, NIGHTLY, OLD_DEPS, YOUNG, fixture, mockFetch, npm, npmRoutes, pin, scratch, verifyBoth } from "./trust-fixtures.mjs";
import { objectStore, sshKey } from "./trust-objects.mjs";

const { BOT_PRINCIPAL } = await import("../lib/selfupdate.mjs");
const { verifyHead: verifyHeadTs } = await import("../../../src/trust/check.ts");
const { t3Gates } = await import("../lib/trust-gates.mjs");

/** The time histories are verified at: fixed, so a seed always makes the same case. */
export const T = Date.UTC(2026, 9, 30, 12);

function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- lists --

/** Signer lists, as [principal, key] lines (a lone string is a line as it is). */
const LISTS = {
  base: [["owner@example.com", "owner"], [BOT_PRINCIPAL, "bot"]],
  noBot: [["owner@example.com", "owner"]],
  addStranger: [["owner@example.com", "owner"], ["second@example.com", "stranger"], [BOT_PRINCIPAL, "bot"]],
  rotate: [["owner@example.com", "owner2"], [BOT_PRINCIPAL, "bot"]],
  // The evaluator's key relabelled as an owner's: only an owner commit can make it so.
  relabel: [["owner@example.com", "owner"], ["owner-alias@example.com", "bot"]],
  quoted: ["# who may sign", ['"owner@example.com"', "owner"], "", [BOT_PRINCIPAL, "bot"]],
  // Two principals on one line: git names the signer by the whole field.
  shared: [["owner@example.com,alt@example.com", "owner"], [BOT_PRINCIPAL, "bot"]],
  strangerBot: [["owner@example.com", "owner"], [BOT_PRINCIPAL, "stranger"]],
};
const LIST_NAMES = Object.keys(LISTS);

const roleOf = (principal) => (principal === BOT_PRINCIPAL ? "bot" : "owner");

// ---------------------------------------------------------------- model --

/**
 * One history, as steps a renderer turns into commits: `root` (who signs the
 * first commit) and `steps`, each { op, signer, ... }. Mostly steps the rule
 * takes (a key the parent's list has, in its role), sometimes any.
 */
export function generate(seed) {
  const random = prng(seed);
  const chance = (p) => random() < p;
  const pick = (items) => items[Math.floor(random() * items.length)];
  const weighted = (table) => {
    let at = random() * table.reduce((sum, [, w]) => sum + w, 0);
    for (const [item, w] of table) if ((at -= w) < 0) return item;
    return table.at(-1)[0];
  };
  let list = "base";
  let release = 0;
  let moved = false;
  const signerFor = (role) => {
    if (chance(0.12)) return pick(["owner", "owner2", "bot", "stranger", null]);
    const keys = LISTS[list].filter((line) => Array.isArray(line) && roleOf(line[0]) === role).map(([, key]) => key);
    return keys.length ? pick(keys) : pick(["owner", "bot", null]);
  };
  const pinStep = (role) => {
    const forward = release < 2 && chance(0.75);
    const to = forward ? release + 1 + (release === 0 && chance(0.3) ? 1 : 0) : chance(0.5) ? release : Math.floor(random() * 3);
    const step = { op: "pin", signer: signerFor(role), to, good: chance(0.85), approve: chance(0.15) };
    if (step.good) release = Math.max(release, to);
    return step;
  };
  const simple = () =>
    weighted([
      [() => ({ op: "edit", signer: signerFor("owner"), file: pick(["README.md", "lib/rules.mjs"]) }), 30],
      [() => pinStep(chance(0.6) ? "bot" : "owner"), 40],
      [() => ({ op: "multi", signer: signerFor("bot") }), 3],
      [() => ({ op: "forge", signer: "owner", kind: pick(["openpgp", "x509", "unknown", "double", "badsig", "constructor"]) }), 4],
      [() => ({ op: "pinShape", signer: signerFor(chance(0.7) ? "bot" : "owner"), shape: pick(["invalid", "extraKey", "preview", "empty", "same", "remove"]) }), 6],
    ])();
  const steps = [];
  const count = 1 + Math.floor(random() * 5);
  for (let i = 0; i < count; i++) {
    const op = weighted([
      ["simple", 70],
      ["list", 10],
      ["merge", 10],
      ["move", moved ? 0 : 7],
      ["foreign", 1.5],
    ]);
    if (op === "simple") steps.push(simple());
    else if (op === "list") {
      const signer = signerFor("owner");
      const next = pick(LIST_NAMES);
      steps.push({ op: "list", signer, list: next });
      if (signer && LISTS[list].some((line) => Array.isArray(line) && line[1] === signer && roleOf(line[0]) === "owner")) list = next;
    } else if (op === "merge") {
      const side = Array.from({ length: 1 + Math.floor(random() * 2) }, simple);
      steps.push({ op: "merge", signer: chance(0.85) ? signerFor("owner") : "bot", from: Math.floor(random() * (steps.length + 1)), side, sideFirst: chance(0.3), keepSide: chance(0.4) });
    } else if (op === "move") {
      moved = true;
      steps.push({ op: "move", signer: signerFor("owner") });
    } else steps.push({ op: "foreign", signer: "owner" });
  }
  // Where it's verified, and when.
  const state = weighted([
    ["fresh", 55],
    ["recordOnChain", 18],
    ["recordTip", 5],
    ["recordFuture", 5],
    ["recordNoTime", 4],
    ["recordOffChain", 4],
    ["shallow", 4],
    ["missing", 5],
  ]);
  const now = chance(0.3) ? T + 4 * DAY : T;
  const clock = weighted([
    ["agrees", 80],
    ["ahead", 10],
    ["behind", 5],
    ["unreachable", 5],
  ]);
  return {
    seed,
    root: weighted([
      ["owner", 96],
      ["bot", 2],
      [null, 2],
    ]),
    steps,
    state,
    pick: random(),
    now,
    clock,
    // Most histories that reach the gates find upstream unreachable: a cheap verdict, so many more run.
    // Those that cross the move reach it more often, so the gates run on both layouts.
    upstream: chance(moved ? 0.6 : 0.3),
  };
}

// ------------------------------------------------------------- rendering --

const ROOT_FILES = new Set([".allowed_signers", "README.md"]);

/**
 * Commits for `history` in `repo`'s object store: in today's layout ("root"),
 * the monorepo layout from the first commit ("monorepo"), or today's until the
 * move step and the monorepo layout after it ("across"). Returns the tip, every
 * commit made (in order, for labels), and the first-parent line.
 */
export function render(world, history, layout) {
  const { store, keys, releases } = world;
  const at = (lineState) => {
    const files = {};
    for (const [name, text] of Object.entries(lineState.files)) files[!ROOT_FILES.has(name) && lineState.mono ? `packages/t3/${name}` : name] = text;
    return store.tree(files);
  };
  const made = [];
  const listText = (name) =>
    `${LISTS[name].map((line) => (Array.isArray(line) ? `${line[0]} namespaces="git" ${keys[line[1]].pub}` : line)).join("\n")}\n`;
  const pinText = (to, good, approve) => {
    const tools = approve ? ["trust-su-tool@1.0.0", "trust-su-tool@1.1.0"] : ["trust-su-tool@1.0.0"];
    return pin(NIGHTLY(releases[to].build), good ? releases[to].sha : releases[(to + 1) % 3].sha, tools);
  };
  const commit = (line, signer, message, extra = {}) => {
    const sha = store.commit({ tree: at(line), parents: line.head ? [line.head] : [], message: `${message} (${history.seed}.${made.length})`, key: signer ? keys[signer] : null, ...extra });
    made.push(sha);
    line.head = sha;
    return sha;
  };
  const apply = (line, step, index) => {
    const files = line.files;
    switch (step.op) {
      case "edit":
        files[step.file] = `${step.file} at step ${index}\n`;
        return commit(line, step.signer, "edit");
      case "pin":
        files["pin.json"] = pinText(step.to, step.good, step.approve);
        return commit(line, step.signer, "pin");
      case "pinShape": {
        const current = files["pin.json"];
        if (step.shape === "remove") delete files["pin.json"];
        else if (step.shape === "invalid") files["pin.json"] = "{ not json\n";
        else if (step.shape === "same") files["pin.json"] = current ?? pinText(0, true, false);
        else {
          const parsed = (() => {
            try {
              return JSON.parse(current ?? "null") ?? JSON.parse(pinText(0, true, false));
            } catch {
              return JSON.parse(pinText(0, true, false));
            }
          })();
          if (step.shape === "extraKey") parsed.note = "x";
          if (step.shape === "preview") parsed.channels = { ...parsed.channels, preview: { ref: "v0.1.6-preview.20261030.1", sha: releases[0].sha, evaluatedAt: "2026-10-30T00:00:00.000Z", leftOut: [] } };
          if (step.shape === "empty") parsed.channels = {};
          files["pin.json"] = `${JSON.stringify(parsed, null, 2)}\n`;
        }
        return commit(line, step.signer, `pin ${step.shape}`);
      }
      case "multi":
        files["pin.json"] = pinText(made.length % 3, true, false);
        files["README.md"] = `and more at ${index}\n`;
        return commit(line, step.signer, "pin and more");
      case "list":
        files[".allowed_signers"] = listText(step.list);
        return commit(line, step.signer, `list ${step.list}`);
      case "move":
        if (layout === "across") line.mono = true;
        else files["README.md"] = `moved at ${index}\n`;
        return commit(line, step.signer, "move");
      case "forge": {
        files["README.md"] = `forged at ${index}\n`;
        const armor = { openpgp: "PGP SIGNATURE", x509: "SIGNED MESSAGE", unknown: "SOMETHING ELSE", double: "SSH SIGNATURE", badsig: "SSH SIGNATURE", constructor: null }[step.kind];
        const body = [" ", " AAAA", ` -----END ${armor}-----`];
        let headers;
        if (step.kind === "constructor") headers = ["gpgsig constructor"];
        else if (step.kind === "badsig") headers = [`gpgsig ${keys.owner.sign("another payload").replaceAll("\n", "\n ")}`];
        else if (step.kind === "double") headers = [`gpgsig -----BEGIN ${armor}-----`, ...body, `gpgsig-sha256 -----BEGIN ${armor}-----`, ...body];
        else headers = [`gpgsig -----BEGIN ${armor}-----`, ...body];
        return commit(line, null, `forged ${step.kind}`, { headers });
      }
      case "merge": {
        const base = line.history[Math.min(step.from, line.history.length - 1)];
        const side = { files: { ...base.files }, mono: base.mono, head: base.head, history: [] };
        step.side.forEach((sideStep, i) => apply(side, sideStep, `${index}.${i}`));
        const [first, second] = step.sideFirst ? [side, line] : [line, side];
        const kept = step.keepSide ? side : line;
        const sha = store.commit({ tree: at(kept), parents: [first.head, second.head], message: `merge (${history.seed}.${made.length})`, key: step.signer ? keys[step.signer] : null });
        made.push(sha);
        line.files = { ...kept.files };
        line.mono = kept.mono;
        line.head = sha;
        return sha;
      }
      case "foreign": {
        const other = store.commit({ tree: at(line), message: `another first commit (${history.seed})`, key: keys.owner });
        made.push(other);
        const sha = store.commit({ tree: at(line), parents: [line.head, other], message: `merge another history (${history.seed}.${made.length})`, key: keys.owner });
        made.push(sha);
        line.head = sha;
        return sha;
      }
      default:
        throw new Error(`no step ${step.op}`);
    }
  };
  const main = {
    files: {
      ".allowed_signers": listText("base"),
      "pin.json": pinText(0, true, false),
      "lib/known-device-tools.txt": "# read by hand\ntrust-su-tool@1.0.0\n",
      "lib/known-hosts.txt": "\n",
      "bin/t3blackout": "#!/bin/sh\n",
      "README.md": "generated\n",
    },
    mono: layout === "monorepo",
    head: null,
    history: [],
  };
  const snapshot = () => main.history.push({ files: { ...main.files }, mono: main.mono, head: main.head });
  commit(main, history.root, "root");
  snapshot();
  history.steps.forEach((step, i) => {
    apply(main, step, i);
    snapshot();
  });
  return { tip: main.head, made, line: main.history.map((entry) => entry.head) };
}

// ----------------------------------------------------------------- world --

/** One worker's upstream (three nightly tags, the middle one adding a dependency an hour old at T), keys, repository and mocks. */
export function makeWorld() {
  const f = fixture({ knownTools: "trust-su-tool@1.0.0", locks: [OLD_DEPS, { ...OLD_DEPS, "gen-young@1.0.0": YOUNG }, OLD_DEPS] });
  const repo = path.join(f.dir, "generated");
  const git = (args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  // The same keys every run, so a seed makes the same signatures again.
  const keys = Object.fromEntries(["owner", "owner2", "bot", "stranger"].map((name) => [name, sshKey(`trust-histories ${name}`)]));
  const routes = {
    ...npmRoutes({ "gen-young": { "1.0.0": { publishedAt: new Date(T - 3_600_000).toISOString(), integrity: YOUNG } } }),
    ...npm("trust-su-tool", Object.fromEntries(["1.0.0", "1.1.0"].map((v) => [v, { files: { "index.js": "module.exports = {};\n" }, publishedAt: new Date(T - 30 * DAY).toISOString() }]))),
  };
  mockFetch(routes);
  return {
    dir: f.dir,
    repo,
    git,
    gitDir: path.join(repo, ".git"),
    store: objectStore(path.join(repo, ".git")),
    keys,
    upstream: f.upstream,
    releases: [3904, 3917, 3940].map((build, i) => ({ build, sha: f.shas[i] })),
  };
}

// ------------------------------------------------------------ comparing --

/** `outcome` with every commit id of `made` as its label, the package folder gone and changed-file lists folded, so layouts compare. */
function normalized(outcome, made) {
  const labels = new Map(made.flatMap((sha, i) => [[sha, `#${i}`], [sha.slice(0, 10), `#${i}`]]));
  const text = (value) =>
    String(value)
      .replace(/\b[0-9a-f]{40}\b|\b[0-9a-f]{10}\b/g, (sha) => labels.get(sha) ?? sha)
      .replaceAll("packages/t3/", "")
      .replace(/changes .*, not just /, "changes …, not just ");
  return JSON.parse(JSON.stringify(outcome), (key, value) => (typeof value === "string" ? text(value) : value));
}

const PROTOTYPE = / is signed with (?:function Object\(\) \{ \[native code\] \}|\[object Object\]), not an SSH key in \.allowed_signers$/;

/**
 * Disagreements decided in the new verifier's favour. Each returns a reason when
 * `both` is exactly that case: the old outcome, with only the decided part of
 * its message changed, is the new one.
 */
const DECIDED = [
  // A gpgsig header naming "constructor" (or another Object.prototype member) found Object's own: still refused, but the message printed a function.
  (both) => {
    const message = both.old.value?.message;
    if (!message || !PROTOTYPE.test(message)) return null;
    const decided = { ...both.old, value: { ...both.old.value, message: message.replace(PROTOTYPE, " is signed with an unrecognized signature, not an SSH key in .allowed_signers") } };
    return JSON.stringify(decided) === JSON.stringify(both.new) && "signature-kind-prototype";
  },
];

/** Writes the clone state `history.state` asks for around `body`, and puts it back after. */
async function inState(world, history, rendered, body) {
  const { gitDir } = world;
  fs.writeFileSync(path.join(gitDir, "HEAD"), `${rendered.tip}\n`);
  const record = path.join(gitDir, "t3blackout-verified");
  const shallow = path.join(gitDir, "shallow");
  const line = rendered.line;
  const chosen = (items) => items[Math.floor(history.pick * items.length)];
  const restore = [];
  switch (history.state) {
    case "recordOnChain":
      fs.writeFileSync(record, `${chosen(line)} ${history.now - 60_000}\n`);
      break;
    case "recordTip":
      fs.writeFileSync(record, `${rendered.tip} ${history.now - 60_000}\n`);
      break;
    case "recordFuture":
      fs.writeFileSync(record, `${chosen(line)} ${history.now + DAY}\n`);
      break;
    case "recordNoTime":
      fs.writeFileSync(record, `${chosen(line)}\n`);
      break;
    case "recordOffChain": {
      const off = rendered.made.filter((sha) => !line.includes(sha));
      fs.writeFileSync(record, `${off.length ? chosen(off) : "0".repeat(40)} ${history.now - 60_000}\n`);
      break;
    }
    case "shallow":
      fs.writeFileSync(shallow, `${chosen(line)}\n`);
      break;
    case "missing": {
      const victims = rendered.made.filter((sha) => sha !== rendered.tip);
      if (victims.length) {
        const file = world.store.file(chosen(victims));
        restore.push([file, fs.readFileSync(file)]);
        fs.rmSync(file);
      }
      break;
    }
  }
  try {
    return await body();
  } finally {
    fs.rmSync(record, { force: true });
    fs.rmSync(shallow, { force: true });
    for (const [file, bytes] of restore) fs.writeFileSync(file, bytes);
  }
}

const clockOf = (history) =>
  ({
    agrees: async () => history.now,
    ahead: async () => history.now - 11 * 60_000,
    behind: async () => history.now + 2 * DAY,
    unreachable: async () => {
      throw new Error("registry unreachable");
    },
  })[history.clock];

const passClosure = async (pin) => ({ ok: true, pin, reasons: [], notes: [] });

/**
 * Runs seeds `from` .. `from + count - 1`: each history in today's layout by both
 * verifiers, and (when it has a move step, or for some others) in the layout the
 * move makes, by the new one. Returns counts and any unexplained disagreement.
 * A disagreement keeps its world (the repository with every object, the keys,
 * and a record of the seed, tip and clone state) in the folder it names.
 */
export async function runSeeds({ from, count, layouts = true }) {
  const world = makeWorld();
  const stats = { histories: 0, results: {}, ops: {}, states: {}, layouts: {}, decided: {}, gated: 0, commits: 0 };
  const bump = (table, key) => (table[key] = (table[key] ?? 0) + 1);
  const disagreements = [];
  for (let seed = from; seed < from + count; seed++) {
    const history = generate(seed);
    const options = { upstream: history.upstream ? world.upstream : path.join(world.dir, "no-such-upstream"), reviewClosure: passClosure, advisories: async () => [], clock: clockOf(history), now: history.now };
    const today = render(world, history, "root");
    const both = await inState(world, history, today, () => verifyBoth({ repo: world.repo, ...options }));
    const old = normalized(both.old, today.made);
    if (JSON.stringify(both.new) !== JSON.stringify(both.old)) {
      const reason = DECIDED.map((rule) => rule(both)).find(Boolean);
      if (reason) bump(stats.decided, reason);
      else disagreements.push({ seed, layout: "root", tip: today.tip, history, old: both.old, new: both.new });
    }
    const moves = history.steps.some((step) => step.op === "move");
    const other = !layouts ? null : moves ? "across" : seed % 8 === 0 ? "monorepo" : null;
    if (other) {
      const rendered = render(world, history, other);
      const heard = [];
      const fresh = await inState(world, history, rendered, async () => {
        const verdict = await verifyHeadTs({ repo: world.repo, now: history.now, gates: t3Gates({ ...options, report: (line) => heard.push(line) }) }).then((value) => ({ value }), (error) => ({ threw: String(error?.message ?? error) }));
        return { ...verdict, record: fs.existsSync(path.join(world.gitDir, "t3blackout-verified")) ? fs.readFileSync(path.join(world.gitDir, "t3blackout-verified"), "utf8") : null, reports: heard, unplayed: [] };
      });
      bump(stats.layouts, `${other}:${fresh.value?.result ?? "threw"}${/evaluator commit\(s\) since/.test(fresh.value?.message ?? "") ? " after evaluator commits" : ""}`);
      const theirs = normalized(fresh, rendered.made);
      // The same history on today's layout, as the old verifier judged it.
      if (JSON.stringify(theirs) !== JSON.stringify(old) && !DECIDED.some((rule) => rule({ old, new: theirs }))) disagreements.push({ seed, layout: other, tip: rendered.tip, history, old, new: theirs });
    }
    stats.histories++;
    stats.commits += today.made.length;
    bump(stats.results, both.old.value?.result ?? "threw");
    bump(stats.states, history.state);
    for (const step of history.steps) bump(stats.ops, step.op === "pinShape" ? `pin:${step.shape}` : step.op === "forge" ? `forge:${step.kind}` : step.op);
    if (/evaluator commit\(s\) since|pins |adds dependencies|clock|device tools|couldn't check the tags/.test(both.old.value?.message ?? "")) stats.gated++;
  }
  if (disagreements.length) {
    for (const [name, key] of Object.entries(world.keys)) fs.writeFileSync(path.join(world.dir, `${name}.pem`), key.pem, { mode: 0o600 });
    for (const found of disagreements) fs.writeFileSync(path.join(world.dir, `disagreement-${found.seed}-${found.layout}.json`), JSON.stringify(found, null, 2));
    scratch.splice(scratch.indexOf(world.dir), 1);
    return { stats, disagreements: disagreements.map((found) => ({ ...found, kept: world.dir })) };
  }
  scratch.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true }));
  return { stats, disagreements };
}

/** Folds counts from several runs into one. */
export function addStats(all) {
  const sum = (a, b) => {
    for (const [key, value] of Object.entries(b)) a[key] = typeof value === "number" ? (a[key] ?? 0) + value : sum(a[key] ?? {}, value);
    return a;
  };
  return all.reduce((acc, stats) => sum(acc, stats), {});
}

/** runSeeds over `count` seeds from `from`, in `workers` worker threads. */
export async function runShards({ from = 1, count, workers = Math.min(os.availableParallelism(), 16), layouts = true }) {
  const size = Math.ceil(count / workers);
  const shards = Array.from({ length: workers }, (_, i) => ({ from: from + i * size, count: Math.max(0, Math.min(size, count - i * size)), layouts })).filter((shard) => shard.count);
  const results = await Promise.all(
    shards.map(
      (shard) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(new URL(import.meta.url), { workerData: shard });
          worker.once("message", resolve);
          worker.once("error", reject);
          worker.once("exit", (code) => code && reject(new Error(`a history worker exited with ${code}`)));
        }),
    ),
  );
  return { stats: addStats(results.map((r) => r.stats)), disagreements: results.flatMap((r) => r.disagreements) };
}

if (!isMainThread && workerData?.count) parentPort.postMessage(await runSeeds(workerData));
