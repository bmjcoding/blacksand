import assert from "node:assert/strict";
import { test } from "node:test";

import { fakeClock, systemClock } from "./clock.ts";

test("a fake clock wakes sleepers in deadline order as time moves, and not before", async () => {
  const clock = fakeClock(1_000);
  const woke: string[] = [];
  void clock.sleep(300).then(() => woke.push(`b@${clock.now()}`));
  void clock.sleep(100).then(() => woke.push(`a@${clock.now()}`));
  await clock.advance(99);
  assert.deepEqual(woke, []);
  assert.equal(clock.pending(), 2);
  await clock.advance(1_000);
  assert.deepEqual(woke, ["a@1100", "b@1300"]);
  assert.equal(clock.now(), 2_099);
});

test("a sleep started by a woken sleeper wakes within the same advance when its deadline falls inside it", async () => {
  const clock = fakeClock();
  const ticks: number[] = [];
  void (async () => {
    for (let i = 0; i < 3; i++) {
      await clock.sleep(10);
      ticks.push(clock.now());
    }
  })();
  await clock.advance(25);
  assert.deepEqual(ticks, [10, 20]);
  await clock.advance(5);
  assert.deepEqual(ticks, [10, 20, 30]);
});

test("an aborted sleep rejects with the signal's reason and stops waiting", async () => {
  const clock = fakeClock();
  const controller = new AbortController();
  const sleeping = clock.sleep(1_000, controller.signal);
  controller.abort(new Error("stopped"));
  await assert.rejects(sleeping, /stopped/);
  assert.equal(clock.pending(), 0);
  await assert.rejects(clock.sleep(1, controller.signal), /stopped/);
});

test("the system clock's sleep is abortable too", async () => {
  const controller = new AbortController();
  const sleeping = systemClock.sleep(60_000, controller.signal);
  controller.abort(new Error("stopped"));
  await assert.rejects(sleeping, /stopped/);
});
