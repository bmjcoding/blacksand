// node --test test/: the age gate's metrics issue (ci/metrics.mjs): holds that
// clear by passing the gate or by being superseded, held security fixes the fast
// lane, an owner override or aging out admits, fast-lane refusals said once, a
// run with nothing held; the marker read back as written, its size cap, hostile
// package names kept inert, and a metrics failure that leaves the alert issues
// as they were. Every text is read with a real Markdown parser
// (test/alerts-markdown.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { EVENTS, STATE_MAX, emptyState, mergeRun, metricsBody, metricsStep, readRun, readState, reconcileMetrics, runSummary } from "../ci/metrics.mjs";
import { BOT, markerOf, readIssue, readMarker, reconcileAdvisories, reconcileHeld } from "../ci/reconcile.mjs";
import { problems } from "./alerts-markdown.mjs";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T00:00:00Z");
const at = (h) => new Date(T0 + h * HOUR).toISOString();
const PINNED = "v0.1.6-nightly.20261030.3917";
const A = "v0.1.7-nightly.20261031.4001";
const B = "v0.1.7-nightly.20261101.4010";
const ADV = "GHSA-2222-3333-4444";
const LIMIT = 65_536;
const CANARY = "pwn@evil";
const HOSTILE = `x\`\`\`\n@repo-owner [fix](https://evil.example) <img src=x> --> | ${CANARY}`;

/** What bin/t3 evaluate --metrics writes for a run at hour `h`. */
const run = (h, { candidates = [], decisions = [], pinnedTo = null, fastLane = true } = {}) => ({ v: 1, channel: "nightly", at: at(h), minAgeDays: 3, pinned: PINNED, pinnedTo, fastLane, candidates, decisions });
const held = (ref, ...young) => ({ ref, held: true, young: young.map(([pkg, h]) => ({ pkg, publishedAt: at(h) })) });
const passed = (ref) => ({ ref, held: false, young: [] });
const REASONS = { admitted: `fixes ${ADV} (publisher maint)`, "no-curated-fix": "no curated source states this fix", "still-flagged": "a source still flags it" };
const decision = (pkg, code, h, { replaces = ["dep@1.0.0"], reason = REASONS[code] ?? "published by mallory, not by maint" } = {}) => ({
  pkg,
  publishedAt: at(h),
  admitted: code === "admitted",
  code,
  reason,
  advisories: [ADV],
  replaces,
});

/** Takes `raw` (a run, or null) in at half past hour `h`, as the alerts job does after the evaluate job. */
function merge(state, raw, h, opts = {}) {
  const now = T0 + h * HOUR + HOUR / 2;
  return mergeRun(state, raw && readRun(raw, "nightly", now), { now, ...opts });
}

/** Runs `steps` ([hour, raw, opts]) in turn from a fresh state: { state, events (all of them, oldest first) }. */
function replay(steps) {
  let state = emptyState();
  const events = [];
  for (const [h, raw, opts] of steps) {
    const out = merge(state, raw, h, opts);
    state = out.state;
    events.push(...out.events);
  }
  return { state, events };
}

/** The issue's text for `state`, checked inert and read back the way the next run reads it. */
function rendered(state, opts = {}) {
  const { body } = metricsBody(state, "nightly", opts);
  assert.ok(body.length <= LIMIT);
  assert.deepEqual(problems(body, { canary: CANARY, layout: true }), []);
  assert.deepEqual(readState(readIssue(body).meta.state), state, "the marker reads back as the state it was written from");
  return body;
}

// ---------------------------------------------------------------- holds ----

test("a hold that clears by aging: from the first run that held it to the first it passed the age gate in", () => {
  const { state, events } = replay([
    [0, run(0, { candidates: [held(A, ["dep@1.0.1", -2], ["fresh@2.0.0", -1])] })],
    [1, run(1, { candidates: [held(A, ["dep@1.0.1", -2], ["fresh@2.0.0", -1])] })],
    [70, run(70, { candidates: [passed(A)], pinnedTo: A })],
  ]);
  assert.deepEqual(events, [{ t: "hold", ref: A, first: at(0), at: at(70), how: "passed", n: 2, pkgs: [["dep@1.0.1", at(-2)], ["fresh@2.0.0", at(-1)]] }]);
  assert.deepEqual(state.holds, []);
  assert.deepEqual([state.runs, state.since, state.at], [3, at(0), at(70)]);
  assert.deepEqual([state.totals.holds, state.totals.superseded, state.totals.holdHours, state.totals.holdMaxMs], [1, 0, { 70: 1 }, 70 * HOUR]);
  const body = rendered(state);
  assert.match(body, /\| Releases the age gate held, cleared \| 1 \|/);
  assert.match(body, /\| Hold, median \/ longest \| 70 h \/ 70 h \|/);
  assert.match(body, /release `v0\.1\.7-nightly\.20261031\.4001` passed the age gate after 70 h held, by `dep@1\.0\.1` \(published 2026-10-31 22:00 UTC\)/);
});

test("a hold superseded: a run that no longer evaluates the release clears it, and says so", () => {
  const first = merge(emptyState(), run(0, { candidates: [held(A, ["dep@1.0.1", -2])] }), 0);
  assert.match(rendered(first.state), /### Held now\n\n- Release `v0\.1\.7-nightly\.20261031\.4001`, since 2026-11-01 00:00 UTC/);
  const { state, events } = merge(first.state, run(5, { candidates: [passed(B)], pinnedTo: B }), 5);
  assert.deepEqual(events.map((e) => [e.t, e.ref, e.how, e.at]), [["hold", A, "superseded", at(5)]]);
  assert.deepEqual([state.totals.holds, state.totals.superseded, state.totals.holdHours], [1, 1, { 5: 1 }]);
  assert.match(rendered(state), /\| Releases the age gate held, cleared \| 1 \(1 superseded before passing\) \|/);
  // A run that couldn't tell (the age gate's word unknown) neither clears a hold nor counts as superseding it.
  const unknown = merge(first.state, run(2, { candidates: [{ ref: A, held: true, young: null }] }), 2);
  assert.deepEqual([unknown.events, unknown.state.holds.map((h) => h.ref)], [[], [A]]);
});

// ------------------------------------------------------------ held fixes ---

test("a held security fix the fast lane admits: refused once (said once), then admitted, with the time held and since publication", () => {
  const { state, events } = replay([
    [0, run(0, { candidates: [held(A, ["dep@1.0.1", -1])], decisions: [decision("dep@1.0.1", "no-curated-fix", -1)] })],
    [1, run(1, { candidates: [held(A, ["dep@1.0.1", -1])], decisions: [decision("dep@1.0.1", "no-curated-fix", -1)] })],
    [6, run(6, { candidates: [passed(A)], decisions: [decision("dep@1.0.1", "admitted", -1)] })],
    [7, run(7, { candidates: [passed(A)], decisions: [decision("dep@1.0.1", "admitted", -1)] })],
  ]);
  assert.deepEqual(
    events.map((e) => [e.t, e.code ?? e.how, e.at]),
    [
      ["lane", "no-curated-fix", at(0)],
      ["hold", "passed", at(6)],
      ["lane", "admitted", at(6)],
      ["fix", "fast-lane", at(6)],
    ],
    "the hourly repeat of a refusal and of an admission is no new event",
  );
  const t = state.totals;
  assert.deepEqual([t.admitted, t.refused, t.laneHours], [1, { "no-curated-fix": 1 }, { 7: 1 }]);
  assert.deepEqual([t.fixes, t.how, t.fixMs, t.fixMaxMs], [1, { "fast-lane": 1 }, 6 * HOUR, 6 * HOUR]);
  const body = rendered(state);
  assert.match(body, /\| Security fixes held, admitted \| 1: 1 fast lane, 0 owner override, 0 aged out \|/);
  assert.match(body, /\| Days on a vulnerable version because of the gate \| 0\.3 \(longest 6 h\) \|/);
  assert.match(body, /\| Fast lane, admitted \/ refused \| 1 \/ 1 \|/);
  assert.match(body, /\| Fast lane, publication to admission \(median\) \| 7 h \|/);
  assert.match(body, /fix `dep@1\.0\.1` for `GHSA-2222-3333-4444` admitted by the fast lane, after 6 h on `dep@1\.0\.0`/);
  // One admitted at its first run: no time on the vulnerable version from the gate.
  const quick = replay([[0, run(0, { decisions: [decision("dep@1.0.1", "admitted", -3)] })]]);
  assert.deepEqual([quick.state.totals.fixMs, quick.state.totals.laneHours], [0, { 3: 1 }]);
});

test("a fast-lane refusal, with its reason, until the fix ages out: held from the first run to publication plus the minimum age", () => {
  const { state, events } = replay([
    [0, run(0, { decisions: [decision("dep@1.0.1", "publisher-changed", -10)] })],
    [1, run(1, { decisions: [decision("dep@1.0.1", "still-flagged", -10)] })],
    [40, null],
    [63, null],
  ]);
  assert.deepEqual(
    events.map((e) => [e.t, e.code ?? e.how, e.at]),
    [
      ["lane", "publisher-changed", at(0)],
      ["lane", "still-flagged", at(1)],
      ["fix", "aged", at(62)],
    ],
  );
  assert.deepEqual([state.totals.refused, state.totals.how, state.totals.fixMs], [{ "publisher-changed": 1, "still-flagged": 1 }, { aged: 1 }, 62 * HOUR]);
  const body = rendered(state);
  assert.match(body, /\| Fast-lane refusals by reason \| another npm publisher: 1, a source still flags it: 1 \|/);
  assert.match(body, /fast lane refused \(another npm publisher\) `dep@1\.0\.1` for `GHSA-2222-3333-4444`, 10 h after its publication: `published by mallory, not by maint`/);
  // While it's held, it's listed as held now, with the latest word on it.
  const open = replay([[0, run(0, { decisions: [decision("dep@1.0.1", "publisher-changed", -10)] })]]);
  assert.match(rendered(open.state), /- Fix `dep@1\.0\.1` for `GHSA-2222-3333-4444`, on `dep@1\.0\.0` since 2026-11-01 00:00 UTC \(published 2026-10-31 14:00 UTC\); the fast lane refused \(another npm publisher\)\./);
});

test("a refusal whose reason changes back and forth hourly: one count per reason, through the marker each run", () => {
  // Each run reads the state back from the issue's marker, as the alerts job does.
  const throughMarker = (state) => readState(readIssue(metricsBody(state, "nightly").body).meta.state);
  let state = emptyState();
  const events = [];
  for (const [h, code] of [[0, "publisher-changed"], [1, "still-flagged"], [2, "publisher-changed"], [3, "still-flagged"]]) {
    const out = merge(throughMarker(state), run(h, { decisions: [decision("dep@1.0.1", code, -10)] }), h);
    state = out.state;
    events.push(...out.events);
  }
  assert.deepEqual(events.map((e) => [e.t, e.code, e.at]), [["lane", "publisher-changed", at(0)], ["lane", "still-flagged", at(1)]]);
  assert.deepEqual(state.totals.refused, { "publisher-changed": 1, "still-flagged": 1 });
  assert.deepEqual(state.fixes.map((f) => [f.pkg, f.first, f.code, f.seen]), [["dep@1.0.1", at(0), "still-flagged", ["publisher-changed", "still-flagged"]]]);
  assert.match(rendered(state), /- Fix `dep@1\.0\.1` for `GHSA-2222-3333-4444`, on `dep@1\.0\.0` since 2026-11-01 00:00 UTC \(published 2026-10-31 14:00 UTC\); the fast lane refused \(a source still flags it\)\./);
  // A marker can't make a fix's counted codes grow past the codes there are.
  const forged = readState({ fixes: [{ pkg: "dep@1.0.1", pub: null, first: at(0), code: null, seen: [...Array(500).fill("still-flagged"), "made-up"] }] });
  assert.deepEqual(forged.fixes[0].seen, ["still-flagged"]);
});

test("an owner override admits a held fix only once it covers every vulnerable version the fix replaces, as the overrides match", () => {
  // The override names another vulnerable version in the line; it covers dep@1.0.0 all the same (lib/overrides.mjs overrideFor).
  const OVERRIDE = { selector: "dep@1.0.1", version: "1.0.2", advisories: [ADV] };
  const covered = replay([
    [0, run(0, { decisions: [decision("dep@1.0.2", "no-curated-fix", -1)] })],
    [3, run(3, { decisions: [decision("dep@1.0.2", "no-curated-fix", -1)] }), { overrides: [OVERRIDE] }],
  ]);
  assert.deepEqual(covered.events.at(-1), { t: "fix", pkg: "dep@1.0.2", pub: at(-1), first: at(0), at: new Date(T0 + 3.5 * HOUR).toISOString(), how: "override", rep: ["dep@1.0.0"], adv: [ADV] });
  assert.deepEqual([covered.state.totals.how, covered.state.fixes.filter((f) => !f.done)], [{ override: 1 }, []]);
  // Two vulnerable versions replaced, one of them covered: still open, then aged out, not overridden.
  const partly = replay([
    [0, run(0, { decisions: [decision("dep@1.0.2", "no-curated-fix", -1, { replaces: ["dep@1.0.0", "dep@0.9.0"] })] })],
    [3, null, { overrides: [OVERRIDE] }],
    [80, null, { overrides: [OVERRIDE] }],
  ]);
  assert.deepEqual(partly.events.map((e) => [e.t, e.how ?? e.code]), [["lane", "no-curated-fix"], ["fix", "aged"]]);
  // Another package, a version past the fix, or one that isn't a version: not covered, and nothing thrown.
  for (const replaces of [["other@1.0.0"], ["dep@1.0.2"], ["dep@not-a-version"]]) {
    const open = replay([[0, run(0, { decisions: [decision("dep@1.0.2", "no-curated-fix", -1, { replaces })] }), { overrides: [OVERRIDE] }]]);
    assert.deepEqual(open.state.fixes.map((f) => f.done), [null], replaces[0]);
  }
});

test("a run with nothing held: counted, nothing new, and the issue says nothing is held", () => {
  const { state, events } = replay([
    [0, run(0)],
    [1, run(1, { candidates: [passed(A)], pinnedTo: A })],
  ]);
  assert.deepEqual([events, state.runs, state.holds, state.fixes], [[], 2, [], []]);
  const body = rendered(state);
  assert.match(body, /Nothing is held by the age gate now\./);
  assert.match(body, /- None yet\./);
  assert.match(runSummary("nightly", readRun(run(1, { candidates: [passed(A)], pinnedTo: A }), "nightly"), []), /- `v0\.1\.7-nightly\.20261031\.4001`: passed the age gate; passed every gate\.\n[\s\S]*Nothing new for the metrics issue\./);
});

test("a run taken in once: a re-run job, or an older run, changes nothing; a run from the future is taken as now", () => {
  const first = merge(emptyState(), run(0, { candidates: [held(A, ["dep@1.0.1", -2])] }), 0);
  const again = merge(first.state, run(0, { candidates: [passed(A)] }), 0);
  assert.deepEqual([again.events, again.state], [[], first.state]);
  const older = merge(first.state, run(-5, { candidates: [passed(A)] }), 0);
  assert.deepEqual(older.events, []);
  const ahead = readRun(run(500), "nightly", T0);
  assert.equal(ahead.at, at(0));
});

// ------------------------------------------------------- shape and size ----

test("the evaluate job's metrics are checked for shape: another channel, a bad tag, a bad code or a mismatched outcome are left out", () => {
  assert.equal(readRun({ ...run(0), channel: "stable" }, "nightly"), null);
  assert.equal(readRun({ ...run(0), v: 2 }, "nightly"), null);
  assert.equal(readRun({ ...run(0), at: "yesterday" }, "nightly"), null);
  assert.equal(readRun("not an object", "nightly"), null);
  const read = readRun(
    run(0, {
      candidates: [held(`v1.0.0-nightly.20261031.1\n@owner`, ["dep@1.0.1", -1]), held(A, [HOSTILE, -1], ["x".repeat(400) + "@1", -1])],
      decisions: [
        { ...decision("dep@1.0.1", "admitted", -1), admitted: false },
        { ...decision("dep@1.0.1", "made-up", -1) },
        { ...decision("dep@1.0.2", "no-curated-fix", -1), advisories: [ADV, "<b>not an id</b>"] },
      ],
    }),
    "nightly",
    T0 + HOUR,
  );
  assert.deepEqual(read.candidates.map((c) => [c.ref, c.young.n, c.young.pkgs.map(([pkg]) => pkg)]), [[A, 2, [HOSTILE]]], "every young version counts; only those of a bounded length are shown");
  assert.deepEqual(read.decisions.map((d) => [d.pkg, d.adv]), [["dep@1.0.2", [ADV]]]);
  // A marker's state that doesn't check out is a fresh start, field by field.
  assert.deepEqual(readState({ runs: -1, totals: { holds: "many", refused: { "made-up": 3, "publisher-changed": 2 } }, holds: [{ ref: "main" }], events: [{ t: "hold" }] }), {
    ...emptyState(),
    totals: { ...emptyState().totals, refused: { "publisher-changed": 2 } },
  });
});

test("hostile package names stay inert in the issue, the run's summary and the marker, and read back whole", () => {
  const pkg = `${HOSTILE}@1.0.1`;
  const { state, events } = replay([
    [0, run(0, { candidates: [held(A, [pkg, -1])], decisions: [{ ...decision(pkg, "publisher-changed", -1, { replaces: [`${HOSTILE}@1.0.0`] }), reason: `published by ${HOSTILE}` }] })],
    [2, run(2, { candidates: [passed(A)], decisions: [decision(pkg, "admitted", -1, { replaces: [`${HOSTILE}@1.0.0`] })] })],
  ]);
  assert.equal(events.length, 4);
  const body = rendered(state);
  const marker = body.split("\n").find((line) => line.startsWith("<!-- blacksand {"));
  assert.ok(marker && !/-->.*-->/.test(marker) && !marker.includes("<img"), "the marker is one line, closed once");
  assert.equal(readState(readMarker(body).state).fixes[0].pkg, pkg);
  const summary = runSummary("nightly", readRun(run(2, { decisions: [decision(pkg, "admitted", -1)] }), "nightly", T0 + 3 * HOUR), events, [`GitHub answered 502: ${HOSTILE}`]);
  assert.deepEqual(problems(summary, { canary: CANARY, layout: true }), []);
});

test("the marker stays under its cap: the oldest listed events go first, then what's tracked, counted as dropped; the totals keep every event", () => {
  const long = (i) => `@${"s".repeat(100)}/${"<".repeat(150)}${i}@1.0.${i}`;
  let state = emptyState();
  for (let h = 0; h < 120; h++) {
    state = merge(state, run(h, { candidates: [held(A, [long(h), h - 1])], decisions: [decision(long(h), "publisher-changed", h - 1, { replaces: [long(h), long(h + 1), long(h + 2)] })] }), h).state;
    assert.ok(markerOf({ kind: "metrics", channel: "nightly", state }).length <= STATE_MAX);
  }
  assert.ok(state.events.length < EVENTS, "listed events made room");
  assert.ok(state.totals.dropped > 0 && state.fixes.length < 120, "the oldest tracked fixes went too, counted");
  assert.equal(state.totals.refused["publisher-changed"], 120, "every refusal is in the totals");
  rendered(state);
  // Owner notes are kept around it; notes that leave no room fail this step, nothing else.
  const body = metricsBody(state, "nightly", { notes: { before: "Owner's note above.", after: "Owner's note below." } }).body;
  assert.ok(body.startsWith("Owner's note above.\n<!-- blacksand text -->") && body.endsWith("\nOwner's note below.") && body.length <= LIMIT);
  assert.throws(() => metricsBody(state, "nightly", { notes: { before: "n".repeat(LIMIT), after: "" } }), /leave no room/);
});

// ---------------------------------------------------------------- issues ---

/** GitHub's issues API in memory, as ci/github.mjs's client offers it; `fail(method, args)` throws to refuse a call. */
function github(fail = () => false) {
  const state = { issues: [], comments: [], labels: [] };
  let next = 1;
  const check = (method, ...args) => {
    if (fail(method, ...args)) throw new Error(`GitHub ${method} answered 502: ${HOSTILE}`);
  };
  const gh = {
    openIssues: async () => (check("openIssues"), structuredClone(state.issues.filter((i) => i.state === "open"))),
    comments: async (n) => (check("comments", n), state.comments.filter((c) => c.number === n)),
    createIssue: async (fields) => {
      check("createIssue", fields);
      const issue = { number: next++, state: "open", user: { login: BOT, type: "Bot" }, ...fields };
      state.issues.push(issue);
      return issue;
    },
    updateIssue: async (n, fields) => (check("updateIssue", n, fields), Object.assign(state.issues.find((i) => i.number === n), fields)),
    comment: async (n, body) => (check("comment", n, body), state.comments.push({ number: n, body, user: { login: BOT, type: "Bot" } })),
    ensureLabel: async (name) => (check("ensureLabel", name), state.labels.push(name)),
  };
  return { state, gh };
}

const metricsIssues = (state) => state.issues.filter((i) => readMarker(i.body)?.kind === "metrics");

test("one metrics issue per channel, labelled metrics and never security, edited in place and never commented on", async () => {
  const { state, gh } = github();
  await reconcileMetrics({ channel: "nightly", run: readRun(run(0, { candidates: [held(A, ["dep@1.0.1", -1])] }), "nightly", T0 + HOUR), now: T0 + HOUR }, gh);
  await reconcileMetrics({ channel: "nightly", run: readRun(run(3, { candidates: [passed(A)] }), "nightly", T0 + 4 * HOUR), now: T0 + 4 * HOUR }, gh);
  const [issue, ...others] = metricsIssues(state);
  assert.deepEqual([others, issue.title, issue.labels, state.labels, state.comments], [[], "[metrics] Age gate and fast lane (nightly)", ["metrics"], ["metrics"], []]);
  assert.equal(readState(readMarker(issue.body).state).totals.holds, 1);
  assert.deepEqual(problems(issue.body, { canary: CANARY, layout: true }), []);
});

test("a metrics failure leaves the alert issues as they were, and the step reports it rather than throwing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-"));
  try {
    // The alert issues first, as the job makes them; then a metrics step whose every GitHub write fails.
    let failing = false;
    const { state, gh } = github((method) => failing && method !== "openIssues" && method !== "comments");
    const report = { channel: "nightly", release: PINNED, sha: "a".repeat(40), sources: [], gaps: [], open: [{ id: ADV, aliases: [], summary: "bad", severity: "HIGH", packages: [{ pkg: "dep@1.0.0", fixed: ["1.0.1"] }] }] };
    await reconcileAdvisories(report, gh, { log: () => {} });
    await reconcileHeld({ channel: "nightly", exit: "3", published: "", report: "# held", pinned: PINNED, newer: [A] }, gh, { log: () => {} });
    const before = structuredClone(state);
    failing = true;
    const runFile = path.join(dir, "metrics.json");
    fs.writeFileSync(runFile, JSON.stringify(run(0, { candidates: [held(A, ["dep@1.0.1", -1])] })));
    const summaryFile = path.join(dir, "summary.md");
    const out = await metricsStep({ channel: "nightly", runFile, summaryFile, now: T0 + HOUR }, gh, { log: () => {} });
    assert.equal(out.problems.length, 1);
    assert.match(out.problems[0], /^the metrics issue couldn't be brought up to date: GitHub ensureLabel answered 502/);
    assert.deepEqual(state, before, "nothing the alert issues hold changed");
    const summary = fs.readFileSync(summaryFile, "utf8");
    assert.match(summary, /held by the age gate: `dep@1\.0\.1`/, "the run's own figures are still in its summary");
    assert.match(summary, /The metrics issue couldn't be brought up to date\./);
    assert.deepEqual(problems(summary, { canary: CANARY, layout: true }), []);
    // Unreadable metrics, overrides that can't be read, a summary that can't be written: each a problem, none thrown.
    failing = false;
    fs.writeFileSync(runFile, "{ not json");
    const broken = await metricsStep({ channel: "nightly", runFile, summaryFile: path.join(dir, "missing", "summary.md"), overrides: () => { throw new Error("lib/overrides.json: invalid"); }, now: T0 + HOUR }, gh, { log: () => {} });
    assert.deepEqual(broken.problems.map((p) => p.split(":")[0]), ["the evaluation's metrics couldn't be read", "lib/overrides.json couldn't be read, so no held fix counts as overridden this run", "the step summary couldn't be written"]);
    // And the alert reconcilers leave the metrics issue alone.
    const [metrics] = metricsIssues(state);
    const body = metrics.body;
    await reconcileAdvisories({ ...report, open: [] }, gh, { log: () => {} });
    await reconcileHeld({ channel: "nightly", exit: "0", published: "", report: "", pinned: PINNED, newer: [] }, gh, { log: () => {} });
    assert.deepEqual([metrics.state, metrics.body, state.comments.filter((c) => c.number === metrics.number)], ["open", body, []]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a week in brief: a fix refused then admitted, a release held till it ages, a new hold with its own fix", () => {
  const { state } = replay([
    [0, run(0, { candidates: [held(A, ["dep@1.0.1", -1], ["fresh@2.0.0", -5])], decisions: [decision("dep@1.0.1", "publisher-changed", -1)] })],
    [30, run(30, { candidates: [held(A, ["fresh@2.0.0", -5])], decisions: [decision("dep@1.0.1", "admitted", -1)] })],
    [68, run(68, { candidates: [passed(A)], pinnedTo: A })],
    [69, run(69, { candidates: [held(B, ["late@3.0.0", 68])], decisions: [decision("late@3.0.0", "no-curated-fix", 68, { replaces: ["late@2.9.0"] })] })],
  ]);
  const body = rendered(state);
  assert.match(body, /\| Releases held now \| 1 \|/);
  assert.match(body, /\| Hold, median \/ longest \| 68 h \/ 68 h \|/);
  assert.match(body, /\| Days on a vulnerable version because of the gate \| 1\.3 \(longest 30 h\) \|/);
});
