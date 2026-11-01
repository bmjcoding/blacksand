// node --test: installing and rolling back the app (lib/platform/app.mjs) with
// the process dying at every filesystem change in turn: recovery always leaves
// the folders and the records agreeing (see app-activation.test.mjs).

import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import assert from "node:assert/strict";

import { assertConsistent, world } from "./app-activation-fixtures.mjs";

const MUTATIONS = ["renameSync", "rmSync", "openSync", "writeFileSync", "mkdirSync", "rmdirSync", "unlinkSync"];

/** Runs `fn` with the process "dying" at the `at`-th filesystem change: that call and every later one fail. */
function dyingAt(at, fn) {
  const real = Object.fromEntries(MUTATIONS.map((name) => [name, fsDefault[name]]));
  let calls = 0;
  for (const name of MUTATIONS) {
    fsDefault[name] = (...args) => {
      calls++;
      if (at && calls >= at) throw Object.assign(new Error(`died at change ${at}`), { code: "EDIED" });
      return real[name](...args);
    };
  }
  syncBuiltinESMExports();
  try {
    fn();
  } catch (error) {
    if (!at) throw error;
  } finally {
    Object.assign(fsDefault, real);
    syncBuiltinESMExports();
  }
  return calls;
}

test("an install interrupted at any step is finished or undone by recovery", () => {
  const total = dyingAt(0, () => world().install());
  assert.ok(total > 5, `counted ${total} changes`);
  for (let at = 1; at <= total; at++) {
    const w = world();
    dyingAt(at, w.install);
    w.recover();
    const view = w.view();
    assertConsistent(view, `install dying at change ${at}`);
    // Either it went in (and v2 is the rollback copy) or it didn't (and v3 is still staged).
    if (view.installed === "3") assert.deepEqual([view.previous, view.staged], ["2", null], `at ${at}`);
    else assert.deepEqual([view.installed, view.previous, view.staged], ["2", "1", "3"], `at ${at}`);
  }
});

test("a rollback interrupted at any step is finished or undone by recovery", () => {
  const total = dyingAt(0, () => world().rollback());
  for (let at = 1; at <= total; at++) {
    const w = world();
    dyingAt(at, w.rollback);
    w.recover();
    const view = w.view();
    assertConsistent(view, `rollback dying at change ${at}`);
    assert.ok(
      (view.installed === "1" && view.previous === "2") || (view.installed === "2" && view.previous === "1"),
      `rollback dying at change ${at}: ${JSON.stringify(view)}`,
    );
  }
});
