// node --test test/: installing and rolling back the app (lib/platform/app.mjs)
// are transactions over the app folders and the CLI's records of them: whatever
// fails, or wherever the process dies, recovery leaves the folders and the
// records agreeing, and it only ever finishes a journal this install wrote. And
// what counts as the app running: the desktop, not servers run from it.
import fsDefault, * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";

import { installBuild, isDesktopCommand, recoverActivation, rollBackBuild } from "../lib/platform/app.mjs";
import { writeJsonAtomic } from "../lib/atomic-file.mjs";
import { assertConsistent, world } from "./app-activation-fixtures.mjs";

// ----------------------------------------------------------- swapping builds --

function apps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3b-app-"));
  const paths = {
    installed: path.join(dir, "T3 Blackout.app"),
    staged: path.join(dir, ".T3 Blackout.new.app"),
    previous: path.join(dir, ".T3 Blackout.previous.app"),
    outgoing: path.join(dir, ".T3 Blackout.outgoing.app"),
  };
  const make = (where, version) => {
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, "version"), version);
  };
  const version = (where) => (fs.existsSync(where) ? fs.readFileSync(path.join(where, "version"), "utf8") : null);
  const journal = path.join(dir, "activation.json");
  const committed = [];
  const tx = { journal, commit: (records) => committed.push(records) };
  const { staged, ...slots } = paths;
  const swapIn = () => installBuild({ ...tx, slots, staged, records: { n: committed.length } });
  const swapBack = () => rollBackBuild({ ...tx, slots, records: { back: true } });
  return { dir, paths, make, version, journal, committed, swapIn, swapBack };
}

test("activation installs the new build and keeps the old one for rollback", () => {
  const { paths, make, version, journal, committed, swapIn, swapBack } = apps();
  make(paths.previous, "1");
  make(paths.installed, "2");
  make(paths.staged, "3");
  swapIn();
  assert.equal(version(paths.installed), "3");
  assert.equal(version(paths.previous), "2");
  assert.equal(fs.existsSync(paths.staged), false);
  assert.equal(fs.existsSync(paths.outgoing), false);
  assert.equal(fs.existsSync(journal), false, "closed");
  swapBack();
  assert.equal(version(paths.installed), "2");
  assert.equal(version(paths.previous), "3");
  assert.deepEqual(committed, [{ n: 0 }, { back: true }]);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.installed)).sort(), [path.basename(paths.previous), path.basename(paths.installed)].sort());
});

test("a failed activation puts the installed build and the old rollback back", () => {
  const { paths, make, version, journal, committed, swapIn } = apps();
  make(paths.previous, "1");
  make(paths.installed, "2");
  // Nothing staged: refused before anything moves.
  assert.throws(() => swapIn(), /staged build .* is missing/);
  // Staged where it can't be moved from (its folder read-only): the move into
  // place fails after the installed app moved out.
  const locked = path.join(path.dirname(paths.installed), "locked");
  const staged = path.join(locked, "staged.app");
  make(staged, "3");
  fs.chmodSync(locked, 0o555);
  try {
    const { staged: _, ...slots } = paths;
    assert.throws(() => installBuild({ journal, commit: (records) => committed.push(records), slots, staged, records: {} }), /EACCES|EPERM/);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  assert.equal(version(paths.installed), "2");
  assert.equal(version(paths.previous), "1");
  assert.equal(version(staged), "3", "still staged");
  assert.equal(fs.existsSync(paths.outgoing), false);
  assert.equal(fs.existsSync(journal), false);
  assert.deepEqual(committed, []);
});

test("a first activation installs with no rollback copy", () => {
  const { paths, make, version, swapIn } = apps();
  make(paths.staged, "1");
  swapIn();
  assert.equal(version(paths.installed), "1");
  assert.equal(fs.existsSync(paths.previous), false);
});

test("rollback without a previous build changes nothing", () => {
  const { paths, make, version, committed, swapBack } = apps();
  make(paths.installed, "2");
  assert.throws(() => swapBack(), /no previous build/);
  assert.equal(version(paths.installed), "2");
  assert.deepEqual(committed, []);
});

test("only the desktop holds an update back, not servers run from the app", () => {
  const exe = "/Applications/T3 Blackout.app/Contents/MacOS/";
  assert.equal(isDesktopCommand("/Applications/T3 Blackout.app/Contents/MacOS/T3 Blackout", exe), true);
  assert.equal(isDesktopCommand("/Applications/T3 Blackout.app/Contents/MacOS/T3 Blackout -psn_0_12345", exe), true);
  const server = "/Applications/T3 Blackout.app/Contents/MacOS/T3 Blackout /Applications/T3 Blackout.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs";
  assert.equal(isDesktopCommand(`${server} serve --host 127.0.0.1 --port 3773 --base-dir /Users/agent-claude/.t3blackout`, exe), false);
  assert.equal(isDesktopCommand(`${server} auth pairing create --json`, exe), false);
  assert.equal(isDesktopCommand("/Applications/T3 Blackout.app/Contents/Frameworks/T3 Blackout Helper.app/Contents/MacOS/T3 Blackout Helper", exe), false);
  assert.equal(isDesktopCommand("/opt/t3/app/t3code --type=renderer", "/opt/t3/app/"), true);
  assert.equal(isDesktopCommand("/opt/t3/app/t3code /opt/t3/app/resources/app.asar/apps/server/dist/bin.mjs serve", "/opt/t3/app/"), false);
});

// ------------------------------------------------------------------ recovery --

test("records that fail after the new build went in: committed, never restaged, finished later", () => {
  const w = world();
  let failing = true;
  const flaky = (records) => {
    if (failing) throw Object.assign(new Error("EISDIR: illegal operation on a directory"), { code: "EISDIR" });
    writeJsonAtomic(w.current, records.current);
    writeJsonAtomic(w.previous, records.previous);
  };
  assert.throws(
    () => installBuild({ journal: w.journal, slots: w.slots, staged: w.staged, records: { current: { v: "3" }, previous: { v: "2" } }, commit: flaky }),
    (error) => error.committed === true && /new build is in place/.test(error.message),
  );
  let view = w.view();
  assert.equal(view.installed, "3");
  assert.equal(view.staged, null, "the staged build was consumed: nothing to restage");
  assert.equal(view.journal, true, "kept for recovery");
  assert.equal(view.current, "2", "records not written yet");
  // A rollback now must not run on the stale records: recovery comes first.
  assert.throws(() => w.rollback(), /didn't finish/);
  failing = false;
  assert.deepEqual(recoverActivation({ journal: w.journal, commit: flaky, slots: w.slots, staging: [w.staged] }).committed, true);
  view = w.view();
  assertConsistent(view, "after recovery");
  assert.equal(view.installed, "3");
});

test("a rollback whose last move fails is finished by recovery, not left without a rollback copy", () => {
  const w = world();
  const realRename = fsDefault.renameSync;
  fsDefault.renameSync = (from, to) => {
    if (from === w.slots.outgoing && to === w.slots.previous) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return realRename(from, to);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => w.rollback(), (error) => error.committed === true);
  } finally {
    fsDefault.renameSync = realRename;
    syncBuiltinESMExports();
  }
  let view = w.view();
  assert.equal(view.installed, "1");
  assert.equal(view.previous, null);
  assert.equal(view.journal, true);
  w.recover();
  view = w.view();
  assertConsistent(view, "after recovery");
  assert.deepEqual([view.installed, view.previous], ["1", "2"]);
});

test("a damaged journal stops recovery instead of guessing", () => {
  const w = world();
  fs.writeFileSync(w.journal, "{\"op\":");
  assert.throws(() => w.recover(), /activation\.json is damaged/);
  assert.equal(fs.existsSync(w.journal), true);
});

// ------------------------------------------ which journals recovery finishes --

const REPO = path.dirname(path.dirname(new URL(import.meta.url).pathname));

/** Installed v2, rollback copy v1, v3 staged; an unrelated project beside them. */
function journalWorld() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-app-")));
  const apps = path.join(dir, "Applications");
  fs.mkdirSync(apps);
  const slots = {
    installed: path.join(apps, "T3 Blackout.app"),
    previous: path.join(apps, ".T3 Blackout.previous.app"),
    outgoing: path.join(apps, ".T3 Blackout.outgoing.app"),
  };
  const staged = path.join(apps, ".T3 Blackout.new.app");
  const pending = path.join(apps, ".T3 Blackout.pending.app");
  const make = (where, v) => {
    fs.mkdirSync(where);
    fs.writeFileSync(path.join(where, "version"), v);
  };
  make(slots.installed, "2");
  make(slots.previous, "1");
  make(staged, "3");
  const project = path.join(dir, "project");
  make(project, "keep");
  const journal = path.join(dir, "activation.json");
  const commits = [];
  const recover = () => recoverActivation({ journal, commit: (records) => commits.push(records), slots, staging: [staged, pending] });
  const write = (entry) => fs.writeFileSync(journal, JSON.stringify(entry));
  const listing = () => [fs.readdirSync(apps).sort(), fs.readFileSync(path.join(project, "version"), "utf8")];
  const records = { current: { ref: "v3" }, previous: { ref: "v2" }, clearPending: true, build: { ref: "v3", sha: "3".repeat(40) } };
  const install = { v: 1, op: "install", slots, staged, origin: slots.installed, records, committed: false };
  const rollback = { v: 1, op: "rollback", slots, records: { current: { ref: "v1" }, previous: { ref: "v2" }, clearPending: false }, committed: false };
  return { dir, apps, slots, staged, project, journal, commits, recover, write, listing, install, rollback, make };
}

test("a journal that isn't one this install wrote is refused before anything moves", () => {
  const cases = (w) => [
    ["another version", { ...w.rollback, v: 999 }],
    ["no version", (({ v, ...rest }) => rest)(w.rollback)],
    ["an unknown op", { ...w.rollback, op: "swap" }],
    ["an extra field", { ...w.rollback, staged: w.staged }],
    ["a missing field", (({ committed, ...rest }) => rest)(w.install)],
    ["committed not a boolean", { ...w.rollback, committed: "yes" }],
    ["previous slot elsewhere", { ...w.rollback, committed: true, slots: { ...w.slots, previous: w.project } }],
    ["outgoing slot elsewhere", { ...w.rollback, committed: true, slots: { ...w.slots, outgoing: w.project } }],
    ["installed slot elsewhere", { ...w.rollback, slots: { ...w.slots, installed: w.project } }],
    ["an unknown slot", { ...w.rollback, slots: { ...w.slots, extra: w.project } }],
    ["staged outside staging", { ...w.install, staged: w.project }],
    ["origin elsewhere", { ...w.install, origin: w.project }],
    ["records not objects", { ...w.rollback, records: { ...w.rollback.records, current: "v1" } }],
    ["an unknown record", { ...w.rollback, records: { ...w.rollback.records, install: { ref: "x" } } }],
    ["clearPending not a boolean", { ...w.install, records: { ...w.install.records, clearPending: "yes" } }],
    ["a build that isn't an object", { ...w.install, records: { ...w.install.records, build: "v3" } }],
  ];
  for (const [label] of cases(journalWorld())) {
    const w = journalWorld();
    const [, entry] = cases(w).find(([name]) => name === label);
    w.write(entry);
    const before = w.listing();
    assert.throws(() => w.recover(), /activation\.json is damaged/, label);
    assert.deepEqual(w.listing(), before, `${label}: nothing moved`);
    assert.deepEqual(w.commits, [], `${label}: no records written`);
    assert.equal(fs.existsSync(w.journal), true, `${label}: the journal stays`);
  }
});

test("a committed journal is never finished while nothing is installed", () => {
  for (const op of ["install", "rollback"]) {
    const w = journalWorld();
    fs.renameSync(w.slots.installed, w.slots.outgoing);
    fs.rmSync(w.staged, { recursive: true });
    w.write({ ...w[op], committed: true });
    const before = w.listing();
    assert.throws(() => w.recover(), /says its build went in, but nothing is installed/, op);
    assert.deepEqual(w.listing(), before, `${op}: the rollback copy wasn't replaced or deleted`);
    assert.deepEqual(w.commits, []);
    assert.equal(fs.existsSync(w.journal), true);
  }
});

test("a staged build gone missing isn't taken for a committed install: the build it would replace never moved", () => {
  const w = journalWorld();
  fs.rmSync(w.staged, { recursive: true });
  w.write(w.install);
  const outcome = w.recover();
  assert.equal(outcome.committed, false);
  assert.deepEqual(w.commits, [], "records still name v2, which is what's installed");
  assert.equal(fs.readFileSync(path.join(w.slots.installed, "version"), "utf8"), "2");
  assert.equal(fs.readFileSync(path.join(w.slots.previous, "version"), "utf8"), "1");
});

test("journals this install wrote still recover, from either staging folder", () => {
  const w = journalWorld();
  // Cut off right after the new build went in.
  fs.renameSync(w.slots.installed, w.slots.outgoing);
  fs.renameSync(w.staged, w.slots.installed);
  w.write(w.install);
  assert.equal(w.recover().committed, true);
  assert.deepEqual(w.commits, [w.install.records]);
  assert.equal(fs.readFileSync(path.join(w.slots.previous, "version"), "utf8"), "2");
  // A pending build whose install was cut off before anything moved: undone, still staged.
  const p = journalWorld();
  const pending = path.join(p.apps, ".T3 Blackout.pending.app");
  fs.renameSync(p.staged, pending);
  p.write({ ...p.install, staged: pending });
  assert.deepEqual(p.recover(), { op: "install", committed: false, staged: pending, records: p.install.records });
  assert.equal(fs.existsSync(pending), true);
});

test("the CLI refuses a crafted rollback journal naming another project, and leaves it alone", () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-app-cli-")));
  const repo = path.join(dir, "repo");
  fs.mkdirSync(repo);
  for (const part of ["bin", "lib"]) fs.cpSync(path.join(REPO, part), path.join(repo, part), { recursive: true });
  const state = path.join(repo, "state");
  fs.mkdirSync(state, { mode: 0o700 });
  const victim = path.join(dir, "unrelated-project");
  const other = path.join(dir, "unrelated-backup");
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, "important.txt"), "keep");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "different.txt"), "other");
  fs.writeFileSync(
    path.join(state, "activation.json"),
    JSON.stringify({ v: 1, op: "rollback", committed: true, slots: { installed: path.join(dir, "unrelated-installed"), previous: victim, outgoing: other }, records: { current: { ref: "fake" }, previous: { ref: "fake-previous" }, clearPending: false } }),
  );
  const home = path.join(dir, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const env = { PATH: process.env.PATH, HOME: home, T3BLACKOUT_HOME: path.join(home, ".t3blackout"), T3BLACKOUT_APPS: path.join(dir, "Apps"), T3BLACKOUT_UPDATE_REQUESTS: path.join(dir, "Shared", "requests"), XDG_DATA_HOME: path.join(dir, "data"), T3BLACKOUT_HEADLESS: "1" };
  const result = spawnSync(process.execPath, [path.join(repo, "bin", "t3blackout"), "rollback"], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /activation\.json is damaged \(its app folders aren't this install's\)/);
  assert.deepEqual(fs.readdirSync(victim), ["important.txt"]);
  assert.deepEqual(fs.readdirSync(other), ["different.txt"]);
  assert.equal(fs.existsSync(path.join(state, "current.json")), false, "no records rewritten");
  assert.equal(fs.existsSync(path.join(state, "activation.json")), true);
});
