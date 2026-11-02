import assert from "node:assert/strict";
import { test } from "node:test";
import { applyWindowOpacity, storedWindowOpacity } from "../lib/files/blacksandWindowOpacity.ts";

test("startup applies a safe stored native opacity, with 100 as the default", () => {
  const calls = [];
  const window = { setOpacity: (value) => calls.push(value) };
  for (const saved of [undefined, null, NaN, Infinity, "60", 0, 49, 101, 73, 50, 100]) applyWindowOpacity(window, storedWindowOpacity(saved));
  assert.deepEqual(calls, [1, 1, 1, 1, 1, 1, 1, 1, .73, .5, 1]);
  for (const invalid of [undefined, null, NaN, Infinity, "60", 0, 49, 101, 50.1]) assert.throws(() => applyWindowOpacity(window, invalid));
});
