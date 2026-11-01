import assert from "node:assert/strict";
import { test } from "node:test";

import type { Context } from "../core/command.ts";
import { fakeClock } from "../core/clock.ts";
import type { HeadCheck } from "../trust/check.ts";
import { trustChecks, verify } from "./verify.ts";

const HEAD = "1234567890".repeat(4);
const TAKEN = { result: "verified" as const, commits: [], trusted: "abcdef0123".repeat(4), bot: ["b".repeat(40)] };
const CLEAN = { refused: null, differs: [], outside: ["node_modules/"] };

test("verify names the verified commit only when its history is taken and every file is that commit's", () => {
  const clean = trustChecks({ head: HEAD, history: TAKEN, tree: CLEAN });
  assert.equal(clean.commit, HEAD);
  assert.deepEqual(clean.checks.map((check) => [check.id, check.ok]), [["trust/history", true], ["trust/working-tree", true]]);
  assert.match(clean.checks[0]?.text ?? "", /1 evaluator pin commit\(s\) since abcdef0123, which blacksand t3 update gates before it builds$/);
  assert.equal(clean.checks[1]?.text, "every file is 1234567890's (ignored, so outside the comparison: node_modules/)");

  const dirty = trustChecks({ head: HEAD, history: TAKEN, tree: { refused: null, differs: Array.from({ length: 7 }, (_, i) => `file${i}`), outside: [] } });
  assert.equal(dirty.commit, null);
  assert.match(dirty.checks[1]?.text ?? "", /^7 path\(s\) differ from 1234567890, .*: file0, file1, file2, file3, file4, …$/);

  const uncompared = trustChecks({ head: HEAD, history: TAKEN, tree: { refused: "a.ts is marked skip-worktree in the index, which this check doesn't model", differs: [], outside: [] } });
  assert.deepEqual([uncompared.commit, uncompared.checks[1]?.ok, uncompared.checks[1]?.text], [null, false, "a.ts is marked skip-worktree in the index, which this check doesn't model"]);

  const refused = trustChecks({ head: HEAD, history: { result: "refused", message: "commit 1234567890 isn't signed" }, tree: CLEAN });
  assert.deepEqual([refused.commit, refused.checks[0]?.ok, refused.checks[0]?.text], [null, false, "commit 1234567890 isn't signed"]);
});

test("blacksand verify --json reports the head check it's given, and refuses without a receipt", async () => {
  const out: string[] = [];
  const ctx = (headCheck: () => HeadCheck): Context => ({ json: true, io: { out: (text) => void out.push(text), err: () => {} }, clock: fakeClock(), run: () => ({ status: 0, signal: null }), headCheck });
  const exit = await verify.run([], ctx(() => ({ head: HEAD, history: TAKEN, tree: CLEAN })));
  const envelope = JSON.parse(out.join(""));
  assert.equal(exit, 4);
  assert.deepEqual([envelope.schema, envelope.result, envelope.blacksand.commit, envelope.warnings[0].code], ["blacksand.verify/1", "refused", HEAD, "verify/no-receipt"]);
});
