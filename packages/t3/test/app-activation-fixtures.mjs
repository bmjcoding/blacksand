// The app folders and records the activation tests (app-activation*.test.mjs)
// install into, roll back and recover: an installed build, its rollback copy
// and a staged one, each a folder holding its version.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";

import { installBuild, recoverActivation, rollBackBuild } from "../lib/platform/app.mjs";
import { writeJsonAtomic } from "../lib/atomic-file.mjs";

/** Installed v2 (records v2/v1), rollback copy v1, and v3 staged. */
export function world() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "t3b-app-")));
  const apps = path.join(dir, "Applications");
  const state = path.join(dir, "state");
  fs.mkdirSync(apps);
  fs.mkdirSync(state);
  const slots = {
    installed: path.join(apps, "T3 Blackout.app"),
    previous: path.join(apps, ".T3 Blackout.previous.app"),
    outgoing: path.join(apps, ".T3 Blackout.outgoing.app"),
  };
  const staged = path.join(apps, ".T3 Blackout.new.app");
  const make = (where, v) => {
    fs.mkdirSync(where);
    fs.writeFileSync(path.join(where, "version"), v);
  };
  make(slots.installed, "2");
  make(slots.previous, "1");
  make(staged, "3");
  const current = path.join(state, "current.json");
  const previous = path.join(state, "previous.json");
  writeJsonAtomic(current, { v: "2" });
  writeJsonAtomic(previous, { v: "1" });
  const journal = path.join(state, "activation.json");
  const commit = (records) => {
    writeJsonAtomic(previous, records.previous);
    writeJsonAtomic(current, records.current);
  };
  const version = (where) => (fs.existsSync(where) ? fs.readFileSync(path.join(where, "version"), "utf8") : null);
  const record = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).v : null);
  const install = () => installBuild({ journal, slots, staged, records: { current: { v: "3" }, previous: { v: "2" } }, commit });
  const rollback = () => rollBackBuild({ journal, slots, records: { current: { v: "1" }, previous: { v: "2" } }, commit });
  const recover = () => recoverActivation({ journal, commit, slots, staging: [staged] });
  const view = () => ({
    installed: version(slots.installed),
    previous: version(slots.previous),
    staged: version(staged),
    current: record(current),
    previousRecord: record(previous),
    journal: fs.existsSync(journal),
    apps: fs.readdirSync(apps).sort(),
  });
  return { slots, staged, journal, install, rollback, recover, view, current, previous };
}

/** The folders and records agree, and nothing half-done is left. */
export function assertConsistent(view, label) {
  assert.equal(view.journal, false, `${label}: journal closed`);
  assert.equal(view.installed, view.current, `${label}: the installed build is the one recorded`);
  assert.equal(view.previous, view.previousRecord, `${label}: the rollback copy is the one recorded`);
  assert.equal(view.apps.some((name) => /outgoing|discard/.test(name)), false, `${label}: no scratch left (${view.apps})`);
}
