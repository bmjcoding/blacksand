// node --test test/: the alert job's GitHub issues (ci/reconcile.mjs),
// through the real client (github.mjs) against GitHub's REST API in memory, with
// its 65,536-character limit. What the owner is told, when, and that nothing they
// were told is lost or repeated; owner notes; older issues; failures; inert text.
// Every text is read with a real Markdown parser (test/alerts-markdown.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { mergeAdvisories } from "../lib/advisories.mjs";
import { githubClient } from "../ci/github.mjs";
import { BOT, code, codeBlock, markerOf, readIssue, readMarker, reconcileAdvisories, reconcileHeld } from "../ci/reconcile.mjs";
import { listedPackages, problems, statedPairs } from "./alerts-markdown.mjs";

const A = "GHSA-2222-3333-4444";
const B = "GHSA-5555-6666-7777";
const C = "GHSA-8888-9999-cccc";
const R = "GHSA-cfgh-jmpq-rvwx";
const CVE = "CVE-2026-10000";
const RELEASE = "v0.1.6-nightly.20261030.3917";
const NEXT = "v0.1.6-nightly.20261031.3940";
const RUN = "https://github.com/o/r/actions/runs/1";
const LIMIT = 65_536;
const CANARY = "pwn@evil";
const HOSTILE = `@repo-owner [Install the fix](https://evil.example/x) <img src=x> www.evil.example ${CANARY}`;
const GAP = { gaps: ["callstack/agent-device's own security advisories: GitHub has no repository"] };
const bot = { login: BOT, type: "Bot" };

/** One source's record of an advisory (lib/advisories.mjs merges them). */
const record = (id, severity = "HIGH", { pkgs = ["dep@1.0.0"], source = "osv", aliases = [], summary = `${id} summary`, fixed = ["1.0.1"], repository = "o/tool" } = {}) => ({
  id,
  aliases,
  summary,
  severity,
  url: "https://attacker.example/ignored",
  packages: pkgs.map((pkg) => ({ pkg, fixed })),
  sources: [source],
  ...(source === "github-repository" ? { repository } : {}),
});
const report = (open, { release = RELEASE, gaps = [] } = {}) => ({ channel: "nightly", release, sha: "a".repeat(40), sources: [], gaps, open });

/**
 * GitHub's REST API in memory, for the real client: `fault({ method, path, body })`
 * answers 502 "before" or "after" a change lands; a body past GitHub's limit gets 422.
 */
function github({ issues = [] } = {}) {
  const state = { issues: structuredClone(issues), comments: [], logs: [], created: 0 };
  let fault = () => null;
  let next = 100;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (href, init = {}) => {
    const url = new URL(href);
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const when = fault({ method, path: url.pathname, body });
    if (when === "before") return json({ message: "Bad Gateway" }, 502);
    if (typeof body?.body === "string" && body.body.length > LIMIT) return json({ message: "body is too long (maximum is 65536 characters)" }, 422);
    let m;
    let out = {};
    if (url.pathname === "/repos/o/r/labels") return json({}, 201);
    if (url.pathname === "/repos/o/r/issues" && method === "GET") out = state.issues.filter((i) => i.state === "open");
    else if (url.pathname === "/repos/o/r/issues" && method === "POST") {
      state.issues.push((out = { number: next++, state: "open", user: bot, ...body }));
      state.created++;
    } else if ((m = /^\/repos\/o\/r\/issues\/(\d+)$/.exec(url.pathname)) && method === "PATCH") {
      out = Object.assign(state.issues.find((i) => i.number === Number(m[1])), body);
    } else if ((m = /^\/repos\/o\/r\/issues\/(\d+)\/comments$/.exec(url.pathname))) {
      if (method === "GET") out = state.comments.filter((c) => c.number === Number(m[1]));
      else state.comments.push({ number: Number(m[1]), body: body.body, user: bot });
    }
    if (when === "after") return json({ message: "Bad Gateway" }, 502);
    if (method === "GET") out = out.slice((url.searchParams.get("page") - 1) * 100, url.searchParams.get("page") * 100);
    return json(out, method === "POST" ? 201 : 200);
  };
  const gh = githubClient({ token: "t", repo: "o/r", fetch, sleep: async () => {} });
  const open = (kind, name) => state.issues.filter((i) => i.state === "open" && readMarker(i.body)?.kind === kind && (name === undefined || readMarker(i.body).package === name));
  return {
    state,
    gh,
    fault: (f) => (fault = f ?? (() => null)),
    runReport: (r) => reconcileAdvisories(r, gh, { log: (line) => state.logs.push(line), run: RUN }),
    run: (records, opts) => reconcileAdvisories(report(mergeAdvisories(records), opts), gh, { log: (line) => state.logs.push(line), run: RUN }),
    find: (number) => state.issues.find((i) => i.number === number),
    open: (name) => open("package", name),
    /** The one open issue for package `name`. */
    issue: (name = "dep") => {
      const found = open("package", name);
      assert.equal(found.length, 1, `one open issue for ${name}`);
      return found[0];
    },
    list: () => open("rolling")[0] ?? null,
    coverage: () => open("coverage")[0] ?? null,
    on: (number) => state.comments.filter((c) => c.number === number).map((c) => c.body),
    /** What GitHub holds: to tell a run that changed nothing. */
    held: () => JSON.stringify({ issues: state.issues, comments: state.comments }),
  };
}
const failing = (method, path) => (call) => (call.method === method && path.test(call.path) ? "before" : null);
const inert = (text, opts) => assert.deepEqual(problems(text, { canary: CANARY, ...opts }), [], text);
/** Every text GitHub holds is inert (issue references only where a comment links one issue to another). */
const allInert = (g) => {
  for (const issue of g.state.issues) inert(issue.body, { codeBlocks: readMarker(issue.body)?.kind === "held" });
  for (const c of g.state.comments) inert(c.body, { issueRefs: /^(Superseded by|Closing as a duplicate of) #/.test(c.body) });
};
const NO_LONGER = /^No longer high or critical: now rated /;

test("the vendored Markdown parser is marked 15.0.12's published file, and finds what these checks rest on", () => {
  const file = fs.readFileSync(new URL("./vendor/marked/marked.esm.js", import.meta.url));
  assert.equal(createHash("sha256").update(file).digest("hex"), "29e25cdf1a06075c90e9885af06ddd23fb22a5424ed23a61dda986c73a8af641");
  assert.ok(problems("  - `dep@1.0.0` → fixed in `` / `` ` @owner [fix](https://evil.dev) ``").some((p) => /evil\.dev/.test(p)), "an empty span opens a run that leaves a live link");
  assert.ok(problems("`cut short [x](https://evil.example)").some((p) => /evil\.example/.test(p)), "an unclosed span is no span");
});

// --------------------------------------------------------- what's said -----

test("a package a high, critical or unrated record names gets one issue; it lists every id naming the package, linked to where it was published, with its own rating", async () => {
  const g = github();
  await g.run([
    record(A, "HIGH", { pkgs: ["dep@1.0.0", "dep@1.1.0", "other@2.0.0"], aliases: [CVE] }),
    record(B, "LOW", { source: "github" }),
    record(R, "MODERATE", { source: "github-repository" }),
    record(C, "LOW", { pkgs: ["calm@1.0.0"] }),
  ]);
  const dep = g.issue("dep");
  assert.equal(dep.title, "[security] dep (nightly)");
  assert.deepEqual(dep.labels, ["security"]);
  assert.deepEqual([...statedPairs(dep.body)], [[A, "HIGH"], [R, "MODERATE"], [B, "LOW"]]);
  assert.ok(dep.body.includes(`[${A}](https://osv.dev/vulnerability/${A}) (${CVE})`));
  assert.ok(dep.body.includes(`[${B}](https://github.com/advisories/${B})`));
  assert.ok(dep.body.includes(`[${R}](https://github.com/o/tool/security/advisories/${R})`), "a repository's own advisory links to that repository");
  // A report that doesn't say where a version ships: it counts as shipping.
  for (const pkg of ["dep@1.0.0", "dep@1.1.0"]) assert.ok(dep.body.includes(`\`${pkg}\` → fixed in \`1.0.1\`. **Ships (couldn't rule it out)**: the check couldn't trace it`), pkg);
  assert.deepEqual(readMarker(dep.body), { kind: "package", channel: "nightly", package: "dep", seen: readMarker(dep.body).seen });
  assert.deepEqual([...statedPairs(g.issue("other").body)], [[A, "HIGH"]]);
  // Only moderate and low: no issue of its own, a line in the one list, which notifies only when it opens.
  assert.deepEqual(g.open("calm"), []);
  assert.deepEqual([...listedPackages(g.list().body)].map(([name, pairs]) => [name, [...pairs]]), [["calm", [[C, "LOW"]]]]);
  assert.equal(g.state.comments.length, 0);
  // Each package's every id is in the run's log.
  assert.ok(g.state.logs.includes(`nightly: "dep" is named by ${JSON.stringify([[A, "HIGH"], [R, "MODERATE"], [B, "LOW"]])}`));
  allInert(g);
  // An unchanged run changes nothing.
  const before = g.held();
  await g.run([record(A, "HIGH", { pkgs: ["dep@1.0.0", "dep@1.1.0", "other@2.0.0"], aliases: [CVE] }), record(B, "LOW", { source: "github" }), record(R, "MODERATE", { source: "github-repository" }), record(C, "LOW", { pkgs: ["calm@1.0.0"] })]);
  assert.equal(g.held(), before);
});

test("what's new is said once: an id new to the issue, or a new rating for one; moderate and low changes, aliases, fewer ids and a new pin only update the text", async () => {
  const g = github();
  await g.run([record(A)]);
  const { number } = g.issue();
  for (const records of [
    [record(A), record(B, "LOW")],
    [record(A), record(B, "MODERATE", { aliases: [CVE] })],
    [record(A, "HIGH", { aliases: [CVE] })],
  ]) await g.run(records);
  assert.deepEqual(g.on(number), []);
  await g.run([record(A), record(C)]);
  assert.equal(g.on(number).length, 1);
  assert.match(g.on(number)[0], new RegExp(`^- New: \\*\\*HIGH\\*\\* \\[${C}\\]`, "m"));
  // C going, a new pin, and C back at the rating it was said at: nothing new.
  await g.run([record(A)], { release: NEXT });
  await g.run([record(A), record(C)], { release: NEXT });
  assert.equal(g.on(number).length, 1);
  assert.deepEqual([...statedPairs(g.find(number).body)], [[A, "HIGH"], [C, "HIGH"]]);
  assert.ok(g.find(number).body.includes(`\`${NEXT}\``), "the text follows the pin");
  // A new rating, either way, is said; the same again isn't.
  await g.run([record(A, "CRITICAL"), record(C)]);
  await g.run([record(A, "CRITICAL"), record(C)]);
  await g.run([record(A, "HIGH"), record(C)]);
  assert.equal(g.on(number).length, 3);
  assert.match(g.on(number)[1], new RegExp(`^- Now \\*\\*CRITICAL\\*\\* \\[${A}\\].* \\(was HIGH\\)$`, "m"));
  assert.match(g.on(number)[2], new RegExp(`^- Now \\*\\*HIGH\\*\\* \\[${A}\\].* \\(was CRITICAL\\)$`, "m"));
  // An id only aliasing one said before is still a record of its own: said once.
  await g.run([record(A), record(C), record(B, "HIGH", { source: "github", aliases: [A] })]);
  await g.run([record(A), record(C), record(B, "HIGH", { source: "github", aliases: [] })]);
  assert.equal(g.on(number).length, 4);
  allInert(g);
});

test("a change comment also names what no longer alerts, and the record follows it: a return to high is said again", async () => {
  const g = github();
  await g.run([record(A), record(B)]);
  const { number } = g.issue();
  // B rated higher and A lower: one comment says both.
  await g.run([record(A, "LOW"), record(B, "CRITICAL")]);
  assert.equal(g.on(number).length, 1);
  assert.match(g.on(number)[0], new RegExp(`^- Now \\*\\*CRITICAL\\*\\* \\[${B}\\].* \\(was HIGH\\)$`, "m"));
  assert.match(g.on(number)[0], new RegExp(`^- Now \\*\\*LOW\\*\\* \\[${A}\\].* \\(was HIGH\\)$`, "m"));
  // A high again: said.
  await g.run([record(A), record(B, "CRITICAL")]);
  assert.equal(g.on(number).length, 2);
  assert.match(g.on(number)[1], new RegExp(`^- New: \\*\\*HIGH\\*\\* \\[${A}\\]`, "m"));
  // Gone, on a check that covered everything, alongside something new: counted. Back again: said.
  await g.run([record(B, "CRITICAL"), record(C)]);
  assert.match(g.on(number)[2], /^- No longer named: 1 high, critical or unrated advisory this issue named before\.$/m);
  await g.run([record(A), record(B, "CRITICAL"), record(C)]);
  assert.match(g.on(number)[3], new RegExp(`^- New: \\*\\*HIGH\\*\\* \\[${A}\\]`, "m"));
  // Lower alone says nothing (what's new is what notifies), and a return to what was last said is nothing new.
  await g.run([record(A, "LOW"), record(B, "CRITICAL"), record(C)]);
  await g.run([record(A), record(B, "CRITICAL"), record(C)]);
  assert.equal(g.on(number).length, 4);
  allInert(g);
});

test("a change comment that doesn't go out is said by the next run, whatever that run's check can see", async () => {
  for (const [then, gaps, tail, onRecord] of [
    // The next check can't see B (its part wasn't covered): said as an earlier check's, and on record.
    [[record(A)], GAP.gaps, "", true],
    // A check that covers everything no longer names B: said, as not named now, and not on record (its return is new).
    [[record(A)], [], " (not named now)", false],
    // A check that sees B: said as it is now.
    [[record(A), record(B, "HIGH", { pkgs: ["dep@2.0.0"] })], GAP.gaps, null, true],
  ]) {
    const g = github();
    await g.run([record(A)]);
    const { number } = g.issue();
    const text = g.find(number).body;
    g.fault(failing("POST", /\/comments$/));
    await assert.rejects(g.run([record(A), record(B, "HIGH", { pkgs: ["dep@2.0.0"] })]), /package "dep": GitHub POST/);
    assert.deepEqual(readMarker(g.find(number).body).unsent, [`H${B}`], "kept before posting");
    g.fault(null);
    await g.run(then, { gaps });
    assert.equal(g.on(number).length, 1);
    const said = g.on(number)[0];
    if (tail === null) assert.match(said, new RegExp(`^- New: \\*\\*HIGH\\*\\* \\[${B}\\]`, "m"));
    else assert.ok(said.includes(`- Seen by an earlier check, whose comment didn't go out: **HIGH** \`${B}\`${tail}\n`), said);
    assert.equal(readMarker(g.find(number).body).unsent, undefined, "cleared once said");
    if (gaps.length) assert.equal(g.find(number).body, text, "a check that didn't cover everything leaves the text as it was");
    // Said once: the same check again says nothing; B back on a check that covers everything is new only if it wasn't on record.
    await g.run(then, { gaps });
    await g.run([record(A), record(B, "HIGH", { pkgs: ["dep@2.0.0"] })]);
    assert.equal(g.on(number).length, onRecord ? 1 : 2);
    allInert(g);
  }
});

test("what a change comment was to say leaves the issue's marker only once a received comment names it, even past its cut", async () => {
  const g = github();
  const b = record(B, "HIGH", { pkgs: ["dep@2.0.0"] });
  // A hundred more that sort ahead of B: one comment can't name them all.
  const ahead = Array.from({ length: 100 }, (_, i) => record(`OSV-2026-${1000 + i}`, "CRITICAL"));
  await g.run([record(A)]);
  const { number } = g.issue();
  g.fault(failing("POST", /\/comments$/));
  await assert.rejects(g.run([record(A), b]), /package "dep": GitHub POST/);
  g.fault(null);
  // A check that didn't cover everything sees B among a hundred others; its comment names a hundred, not B.
  await g.run([record(A), b, ...ahead], GAP);
  assert.equal(g.on(number).length, 1);
  assert.ok(!statedPairs(g.on(number)[0]).has(B));
  assert.ok(readMarker(g.find(number).body).unsent.includes(`H${B}`), "B still to be said");
  // The next checks can't see B: it's said, as an earlier check saw it, and then it's gone from the marker.
  await g.run([record(A), ...ahead], GAP);
  assert.equal(g.on(number).length, 2);
  assert.ok(g.on(number)[1].includes(`- Seen by an earlier check, whose comment didn't go out: **HIGH** \`${B}\`\n`), g.on(number)[1]);
  assert.equal(readMarker(g.find(number).body).unsent, undefined);
  await g.run([record(A), ...ahead], GAP);
  assert.equal(g.on(number).length, 2, "said once");
  allInert(g);
});

test("a check that covered everything and finds nothing alerting closes the issue saying why: \"Fixed\" only when nothing names the package", async () => {
  const g = github();
  const calm = record(C, "LOW", { pkgs: ["calm@1.0.0"] });
  await g.run([record(A), calm]);
  const first = g.issue();
  // Rated LOW now: never "Fixed"; it's in the moderate and low list.
  await g.run([record(A, "LOW"), calm]);
  assert.deepEqual([first.number, g.find(first.number).state, g.find(first.number).state_reason], [first.number, "closed", "not_planned"]);
  assert.match(g.on(first.number).at(-1), NO_LONGER);
  assert.match(g.on(first.number).at(-1), /\(`GHSA-2222-3333-4444`\); tracked in the moderate\/low issue, `\[security\] Moderate and low advisories \(nightly\)`\. `dep` in `v0\.1\.6-nightly\.20261030\.3917` still has it: this isn't a fix\./);
  assert.deepEqual([...listedPackages(g.list().body).keys()], ["calm", "dep"]);
  // High again: a new issue. Then nothing names it: "Fixed", and the list, empty, closes with nothing said.
  await g.run([record(A), calm]);
  const second = g.issue();
  assert.notEqual(second.number, first.number);
  const list = g.list();
  await g.run([]);
  assert.deepEqual([g.find(second.number).state, g.find(second.number).state_reason], ["closed", "completed"]);
  assert.match(g.on(second.number).at(-1), /^Fixed: `v0\.1\.6-nightly\.20261030\.3917` no longer has any advisory for `dep` in any source\./);
  assert.deepEqual([g.find(list.number).state, g.on(list.number)], ["closed", []]);
});

test("an unrated advisory merged with a LOW repository advisory by alias still alerts; the repository's own package goes in the list", async () => {
  const g = github();
  await g.run([record(A, "UNKNOWN", { aliases: [CVE] }), record(R, "LOW", { source: "github-repository", pkgs: ["tool@0.21.31"], aliases: [CVE] })]);
  assert.deepEqual([...statedPairs(g.issue("dep").body)], [[A, "UNKNOWN"]]);
  assert.deepEqual(g.open("tool"), []);
  assert.deepEqual([...listedPackages(g.list().body).get("tool")], [[R, "LOW"]]);
});

test("a check that couldn't cover everything closes nothing and leaves issue text as it was; it still opens issues and says what's new, and the coverage issue says what's missing until it can", async () => {
  const g = github();
  await g.run([record(A), record(C, "LOW", { pkgs: ["calm@1.0.0"] })]);
  const dep = g.issue();
  const text = dep.body;
  // Nothing seen at all: nothing closes, nothing is said, nothing is rewritten; the list stays.
  await g.run([], GAP);
  assert.equal(g.find(dep.number).body, text);
  assert.ok(g.list(), "the moderate and low list isn't closed either");
  const coverage = g.coverage();
  assert.ok(coverage.body.includes(code(GAP.gaps[0], 500)));
  // A new HIGH is said, and a package with none before gets its issue; the text it had stays.
  await g.run([record(B), record(C, "HIGH", { pkgs: ["fresh@1.0.0"] })], GAP);
  assert.equal(g.on(dep.number).length, 1);
  assert.match(g.on(dep.number)[0], new RegExp(`^- New: \\*\\*HIGH\\*\\* \\[${B}\\]`, "m"));
  assert.match(g.on(dep.number)[0], /This check didn't cover everything; the issue's list is brought up to date by the next one that does\./);
  assert.equal(g.find(dep.number).body, text);
  assert.match(g.issue("fresh").body, /This check didn't cover everything \(see the coverage issue\)/);
  // Covered again: the list is brought up to date with nothing more said, and the coverage issue closes, saying so.
  await g.run([record(A), record(B), record(C, "HIGH", { pkgs: ["fresh@1.0.0"] })]);
  assert.deepEqual([...statedPairs(g.find(dep.number).body)], [[A, "HIGH"], [B, "HIGH"]]);
  assert.equal(g.on(dep.number).length, 1);
  assert.equal(g.find(coverage.number).state, "closed");
  assert.match(g.on(coverage.number).at(-1), /^The check covers everything a build of `v0\.1\.6-nightly\.20261030\.3917` installs again\./);
  allInert(g);
});

test("what one text can't show isn't on record: later runs say the rest, each id once, and every text fits GitHub's limit", async () => {
  const g = github();
  const ids = Array.from({ length: 300 }, (_, i) => `OSV-2026-${String(i).padStart(90, "0")}`);
  const records = ids.map((id) => record(id, "HIGH", { summary: `${"s".repeat(290)} ${CANARY}` }));
  await g.run(records);
  const issue = g.issue();
  const told = new Map();
  const tell = (text) => {
    for (const [id, rating] of statedPairs(text)) {
      assert.ok(!told.has(id), `${id} said twice`);
      told.set(id, rating);
    }
  };
  tell(issue.body);
  assert.ok(told.size < ids.length, "the opening text is cut");
  assert.match(issue.body, /^- …and \d+ more advisories, left out to fit GitHub's limit; \[this run's log\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\) lists every one\.$/m);
  for (let i = 0; i < 5; i++) await g.run(records);
  for (const body of g.on(issue.number)) tell(body);
  assert.equal(told.size, ids.length, "every one said, in the comments that followed");
  assert.ok(g.on(issue.number).length >= 2);
  for (const text of [...g.state.issues.map((i) => i.body), ...g.state.comments.map((c) => c.body)]) assert.ok(text.length <= LIMIT);
  allInert(g);
});

test("past what an issue's record keeps (1,000 ids), the rest is listed and logged but never comments every hour", async () => {
  const g = github();
  const records = Array.from({ length: 1050 }, (_, i) => record(`OSV-2026-${i}`, "HIGH", { summary: "s" }));
  for (let i = 0; i < 12; i++) await g.run(records);
  const { number } = g.issue();
  const said = g.on(number).length;
  await g.run(records);
  await g.run(records);
  assert.equal(g.on(number).length, said, "settled: nothing more to say that a record could keep");
  const told = new Set([...statedPairs(g.state.issues.find((i) => i.number === number && i.body).body).keys()]);
  for (const body of g.on(number)) for (const id of statedPairs(body).keys()) told.add(id);
  assert.ok(told.size >= 1000, `${told.size} said`);
  const marker = /<!-- blacksand (\{.*"kind":"notify".*\}) -->/.exec(g.on(number).at(-1))[1];
  assert.equal(JSON.parse(marker).seen.length, 1000 * 17);
  for (const text of [...g.state.issues.map((i) => i.body), ...g.state.comments.map((c) => c.body)]) assert.ok(text.length <= LIMIT);
});

// ----------------------------------------------------------- failures ------

test("a comment that fails has recorded nothing: the next run says it, once; a lost response isn't posted twice", async () => {
  const g = github();
  await g.run([record(A)]);
  const { number } = g.issue();
  const text = g.find(number).body;
  g.fault(failing("POST", /\/comments$/));
  await assert.rejects(g.run([record(A), record(B)]), /package "dep": GitHub POST \/repos\/o\/r\/issues\/\d+\/comments answered 502/);
  // Nothing said; the text as it was, its marker keeping what the comment was to name.
  assert.deepEqual(g.on(number), []);
  assert.equal(g.find(number).body.replace(/,"unsent":\[[^\]]*\]/, ""), text);
  assert.deepEqual(readMarker(g.find(number).body).unsent, [`H${B}`]);
  // The report moves on meanwhile: what's new now is said, B included.
  g.fault(null);
  await g.run([record(A), record(B), record(C, "CRITICAL")]);
  assert.equal(g.on(number).length, 1);
  assert.deepEqual([...statedPairs(g.on(number)[0])], [[C, "CRITICAL"], [B, "HIGH"]]);
  await g.run([record(A), record(B), record(C, "CRITICAL")]);
  assert.equal(g.on(number).length, 1);
  // A post that fails before it lands, then goes through on a retry: posted, though an earlier comment is there.
  let once = true;
  g.fault((call) => (call.method === "POST" && call.path.endsWith("/comments") && once ? ((once = false), "before") : null));
  await g.run([record(A), record(B, "CRITICAL"), record(C, "CRITICAL")]);
  assert.equal(g.on(number).length, 2);
  assert.match(g.on(number)[1], new RegExp(`^- Now \\*\\*CRITICAL\\*\\* \\[${B}\\]`, "m"));
  // The comment lands but its answer is lost; the text then fails to save: said once all the same.
  let posted = false;
  g.fault((call) => (call.method === "POST" && call.path.endsWith("/comments") && !posted ? ((posted = true), "after") : call.method === "PATCH" && posted ? "before" : null));
  await assert.rejects(g.run([record(A, "CRITICAL"), record(B, "CRITICAL"), record(C, "CRITICAL")]), /PATCH/);
  g.fault(null);
  await g.run([record(A, "CRITICAL"), record(B, "CRITICAL"), record(C, "CRITICAL")]);
  assert.equal(g.on(number).length, 3);
  assert.equal(statedPairs(g.find(number).body).get(A), "CRITICAL");
  assert.equal(readMarker(g.find(number).body).unsent, undefined);
});

test("a close that fails: the next complete check closes it without saying it twice, says a different reason, or says it alerts again", async () => {
  const closes = failing("PATCH", /\/issues\/\d+$/);
  for (const [then, said] of [
    [[], ["Fixed"]],
    [[record(A, "LOW")], ["Fixed", "No longer"]],
    [[record(A)], ["Fixed", "again"]],
  ]) {
    const g = github();
    await g.run([record(A)]);
    const { number } = g.issue();
    g.fault((call) => (call.body?.state === "closed" ? closes(call) : null));
    await assert.rejects(g.run([]), /PATCH/);
    g.fault(null);
    await g.run(then);
    await g.run(then);
    const words = g.on(number).map((body) => (body.startsWith("Fixed:") ? "Fixed" : NO_LONGER.test(body) ? "No longer" : /again, after the comment above said this issue closes:/.test(body) ? "again" : body));
    assert.deepEqual(words, said);
    assert.equal(g.find(number).state, then.length && then[0].severity === "HIGH" ? "open" : "closed");
    if (said.at(-1) === "again") assert.ok(g.on(number).at(-1).includes(`- New: **HIGH** [${A}]`));
  }
});

test("one part that fails doesn't keep the others from being brought up to date; the run fails at the end, naming it", async () => {
  const g = github();
  await g.run([record(A), record(B, "HIGH", { pkgs: ["mid@1.0.0"] })]);
  const dep = g.issue("dep");
  g.fault((call) => (call.method === "PATCH" && call.path.endsWith(`/${dep.number}`) ? "before" : null));
  await assert.rejects(g.run([record(B, "LOW", { pkgs: ["mid@1.0.0"] }), record(C, "HIGH", { pkgs: ["zzz@1.0.0"] })]), (error) => {
    assert.match(error.message, /^1 part\(s\) of the alert issues couldn't be brought up to date; the rest were:\n- package "dep": GitHub PATCH \/repos\/o\/r\/issues\/\d+ answered 502/);
    return true;
  });
  assert.equal(g.open("mid").length, 0, "the package after it closed");
  assert.equal(g.open("zzz").length, 1, "and the one after that opened");
});

// --------------------------------------------------------------- notes -----

test("notes added above or below an issue's text are kept whole when it's redone; where they leave no room, the issue is left as it is and the run fails, naming it", async () => {
  const g = github();
  await g.run([record(A)]);
  const issue = g.issue();
  const above = "Owner: looked at this on Friday.";
  const below = "Owner: upstream says the fix lands next week.";
  g.find(issue.number).body = `${above}\n${issue.body}\n${below}`;
  await g.run([record(A), record(B, "LOW")]);
  const body = g.find(issue.number).body;
  assert.ok(body.startsWith(`${above}\n<!-- blacksand text -->\n`) && body.endsWith(`\n${below}`));
  assert.deepEqual([...statedPairs(body)], [[A, "HIGH"], [B, "LOW"]]);
  // A long note: the issue's own list gives way, never the note.
  const many = Array.from({ length: 60 }, (_, i) => record(`OSV-2026-${i}`, "HIGH", { summary: "y".repeat(250) }));
  const long = `Owner: ${"n".repeat(50_000)}`;
  g.find(issue.number).body = `${body}\n${long}`;
  await g.run([record(A), ...many]);
  assert.ok(g.find(issue.number).body.endsWith(`\n${below}\n${long}`));
  assert.ok(g.find(issue.number).body.length <= LIMIT);
  assert.match(g.find(issue.number).body, /^- …and \d+ more advisories, left out to fit GitHub's limit/m);
  // Notes that leave no room for its own text at all: left as it is, named; other parts carry on.
  const huge = `Owner: ${"n".repeat(LIMIT)}`;
  g.find(issue.number).body = `${body}\n${huge}`;
  const full = g.find(issue.number).body;
  const calm = record(C, "LOW", { pkgs: ["calm@1.0.0"] });
  await assert.rejects(g.run([record(A), calm]), /package "dep": its notes \(\d+ characters\) leave no room for its own text within GitHub's 65536-character limit, so it's left as it is; shorten them/);
  assert.equal(g.find(issue.number).body, full);
  assert.deepEqual([...statedPairs(g.list().body)], [[C, "LOW"]], "the list was still brought up to date");
  // Shortened: brought up to date, the notes kept.
  g.find(issue.number).body = full.replace(huge, "Owner: short now.");
  await g.run([record(A), calm]);
  assert.ok(g.find(issue.number).body.includes(above) && g.find(issue.number).body.includes("Owner: short now."));
  // Notes on the list are kept too, and a long one makes its own text give way, never the note.
  const list = g.list();
  const note = `List note: ${"m".repeat(40_000)}`;
  g.find(list.number).body = `${note}\n${list.body}`;
  await g.run([record(A), ...Array.from({ length: 300 }, (_, i) => record(`OSV-2026-${i}`, "LOW", { pkgs: ["calm@1.0.0"], summary: "y".repeat(250) }))]);
  assert.ok(g.find(list.number).body.startsWith(`${note}\n`));
  assert.ok(g.find(list.number).body.length <= LIMIT);
  assert.match(g.find(list.number).body, /^- …and \d+ more advisories, left out to fit GitHub's limit/m);
});

// ----------------------------------------------------- older issues ------

/** The five issues the deployed version left open on bmjcoding/t3blackout (#1-#4, #6, 2026-10-31): old markers, no START line. */
function deployed() {
  const pkg = (number, name, ids) => ({
    number,
    title: `[security] ${name} (nightly)`,
    state: "open",
    user: bot,
    labels: [{ name: "security" }],
    body: `Advisories open against \`${name}\` in the pinned nightly release:\n\n${ids.map((id) => `- **HIGH** [${id}](https://osv.dev/vulnerability/${id}) CVE-2026-1: \`x\`\n  - \`${name}@1.0.0\` → fixed in \`1.0.1\``).join("\n")}\n\nPinned nightly release on main: \`v0.1.6-nightly.20261030.3940\` (\`ae521d1d79\`).\n\n${markerOf({ kind: "package", channel: "nightly", package: name, ids, notified: ids })}`,
  });
  return [
    pkg(1, "node-forge", [A, B, C]),
    pkg(2, "uuid", [R]),
    pkg(3, "zod", ["GHSA-2345-6789-cfgh"]),
    { number: 4, title: "[security] Moderate and low advisories (nightly)", state: "open", user: bot, body: `12 moderate or low advisories open against the pinned nightly release. This issue is edited in place.\n\n- **MODERATE** [GHSA-3456-789c-fghj](https://osv.dev/vulnerability/GHSA-3456-789c-fghj) CVE-2026-2: \`glob\`\n  - \`glob@13.0.6\` → fixed in \`14.0.2\`\n\n${markerOf({ kind: "rolling", channel: "nightly", ids: ["GHSA-3456-789c-fghj"] })}` },
    { number: 6, title: "Upstream nightly releases held", state: "open", user: bot, body: `The evaluator held every upstream nightly release it evaluated, so it proposes none.\n\n${markerOf({ kind: "held", channel: "nightly" })}` },
  ];
}

test("the deployed version's five open issues are taken over in one run, once: never rewritten, closed as they were, a package's with a link", async () => {
  const issues = deployed();
  const g = github({ issues });
  const findings = [
    ...[A, B, C].map((id) => record(id, "HIGH", { pkgs: ["node-forge@1.4.0"] })),
    record(R, "HIGH", { pkgs: ["uuid@7.0.3"] }),
    record("GHSA-2345-6789-cfgh", "HIGH", { pkgs: ["zod@3.25.76"] }),
    record("GHSA-3456-789c-fghj", "MODERATE", { pkgs: ["glob@13.0.6"] }),
  ];
  const evaluate = () => reconcileHeld({ channel: "nightly", exit: "3", published: "", report: "held", pinned: "v0.1.6-nightly.20261030.3940", newer: ["v0.1.6-nightly.20261031.4001"] }, g.gh, { log: () => {} });
  await g.run(findings);
  await evaluate();
  // Sent: five new issues (three packages, announcing their HIGHs; the list; the held issue) and three comments.
  assert.equal(g.state.created, 5);
  assert.deepEqual(g.state.comments.map((c) => [c.number, c.body.split("\n")[0].replace(/#\d+/, "#N")]), [1, 2, 3].map((n) => [n, "Superseded by #N, which tracks this from now on; this issue is closed as it was."]));
  for (const [i, issue] of issues.entries()) assert.deepEqual([g.state.issues[i].state, g.state.issues[i].body], ["closed", issue.body], `#${issue.number}`);
  for (const [name, n] of [["node-forge", 3], ["uuid", 1], ["zod", 1]]) assert.equal(statedPairs(g.issue(name).body).size, n, name);
  for (const issue of g.state.issues.filter((i) => i.state === "open")) assert.ok(readIssue(issue.body).notes, `#${issue.number} is delimited`);
  allInert(g);
  const after = g.held();
  await g.run(findings);
  await evaluate();
  assert.equal(g.held(), after, "the next hour, nothing");
});

test("an older package issue is left alone by a check that couldn't cover everything, closed as it was by one that finds nothing alerting, and taken over once even when the new issue's creation answer was lost", async () => {
  const [old] = deployed();
  const g = github({ issues: [old] });
  await g.run([record(A, "LOW", { pkgs: ["node-forge@1.4.0"] })], GAP);
  assert.deepEqual([g.find(1).state, g.find(1).body, g.on(1)], ["open", old.body, []]);
  await g.run([record(A, "LOW", { pkgs: ["node-forge@1.4.0"] })]);
  assert.deepEqual([g.find(1).state, g.find(1).state_reason, g.find(1).body], ["closed", "not_planned", old.body]);
  assert.match(g.on(1)[0], NO_LONGER);
  // Taking over: the creation lands but its answer is lost; the client finds the new, delimited issue by its marker.
  const h = github({ issues: [old] });
  let lost = true;
  h.fault((call) => (call.method === "POST" && call.path === "/repos/o/r/issues" && lost ? ((lost = false), "after") : null));
  await h.run([record(A, "HIGH", { pkgs: ["node-forge@1.4.0"] })]);
  assert.equal(h.state.created, 1);
  assert.deepEqual([h.find(1).state, h.on(1).length, h.issue("node-forge").number], ["closed", 1, 100]);
});

test("duplicates: the oldest delimited issue is kept and the others close with a link to it; the moderate and low list's close with nothing said", async () => {
  const g = github();
  await g.run([record(A), record(C, "LOW", { pkgs: ["calm@1.0.0"] })]);
  const [dep, list] = [g.issue(), g.list()];
  for (const issue of [dep, list]) g.state.issues.push({ ...structuredClone(issue), number: issue.number + 50 });
  await g.run([record(A), record(C, "LOW", { pkgs: ["calm@1.0.0"] })]);
  assert.deepEqual([g.issue().number, g.list().number], [dep.number, list.number]);
  assert.deepEqual(g.on(dep.number + 50), [`Closing as a duplicate of #${dep.number}, which tracks this.\n\n${markerOf({ kind: "duplicate", of: dep.number })}`]);
  assert.deepEqual([g.find(list.number + 50).state, g.on(list.number + 50)], ["closed", []]);
});

test("only the automation's own issues for this channel are touched", async () => {
  const marked = (number, user, channel = "nightly") => ({ number, title: "[security] dep (nightly)", state: "open", user, body: `<!-- blacksand text -->\nmine\n\n${markerOf({ kind: "package", channel, package: "dep" })}` });
  const issues = [marked(1, { login: "someone", type: "User" }), marked(2, { login: BOT, type: "User" }), marked(3, bot, "preview"), { number: 4, title: "[security] dep (nightly)", state: "open", user: bot, body: "no marker" }];
  const g = github({ issues });
  await g.run([]);
  await g.run([record(A)]);
  assert.deepEqual(g.state.issues.slice(0, 4), issues);
  assert.deepEqual(g.state.issues.slice(4).map((i) => [i.number, i.state, readMarker(i.body).package]), [[100, "open", "dep"]]);
});

// --------------------------------------------------------- inert text ------

test("outside text is inert in every body and comment, whatever an advisory holds; links are built here, never taken from it", async () => {
  const g = github();
  const hostile = (id, severity) =>
    record(id, severity, { pkgs: ["dep@1.0.0", `x[${CANARY}](https://evil.example)@1.0.0`], summary: `\`${HOSTILE}\n\n# heading`, fixed: [" ", "", "`", `\` ${HOSTILE}`], aliases: [CVE] });
  // An id that only a code span can hold, and a repository that isn't one.
  await g.run([hostile(A, "HIGH"), hostile(`OSV-2026-x\n\n@repo-owner [Install](https://evil.example) ${CANARY}`, "HIGH"), record(R, "LOW", { source: "github-repository", repository: "example/..", summary: HOSTILE })]);
  await g.run([hostile(A, "CRITICAL"), hostile(`www.evil.example${CANARY}`, "HIGH"), record(R, "LOW", { source: "github-repository", repository: "example/..", summary: HOSTILE })]);
  await g.run([record(R, "LOW", { source: "github-repository", repository: "example/..", summary: HOSTILE })]);
  allInert(g);
  assert.ok(!g.state.issues.some((i) => i.body.includes(`(https://github.com/example/../security/advisories/${R})`)), "a repository with a dot-only part never links");
  assert.ok(g.state.comments.some((c) => NO_LONGER.test(c.body)), "the closing comment was checked too");
  // A blank value is a placeholder in a span of its own, never an empty span.
  assert.equal(code(""), "`(empty)`");
  assert.equal(code(" ", 300, "no summary"), "`no summary`");
  assert.equal(code("a\nb``c", 100), "```a b``c```");
  assert.equal(code("`x`"), "`` `x` ``");
  assert.match(codeBlock("```\n@someone\n````"), /^`````text\n```\n@someone\n````\n`````$/);
});

test("code() over random text: always exactly one code span, holding the text", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const alphabet = ["`", "``", " ", "[", "]", "(", ")", "@", "<", ">", "\n", "\t", "*", "_", "a", "b", "#", "!", "www.", " "];
  for (let i = 0; i < 3000; i++) {
    const text = Array.from({ length: Math.floor(random() * 12) }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    const span = code(text, 40);
    const tokens = problems(`- before ${span} after ${CANARY.replace("@", "")}`);
    assert.deepEqual(tokens, [], JSON.stringify(text));
  }
});

test("a malformed report is refused before anything changes", async () => {
  const g = github();
  await assert.rejects(g.runReport({ channel: "nightly", release: "x", gaps: [], open: [{ id: "A", severity: "HIGH", packages: [{ pkg: "noversion", fixed: [] }] }] }), /malformed advisory/);
  await assert.rejects(g.runReport({ channel: "evil", release: "x", open: [] }), /not an advisory report/);
  await assert.rejects(g.runReport({ channel: "nightly", release: "x", open: [] }), /doesn't say what it couldn't cover/);
  assert.equal(g.state.created, 0);
});

test("Electron's runtime advisories link to Electron's release; an id without a known origin is inert code", async () => {
  const g = github();
  const runtime = { id: "ELECTRON-RUNTIME-40.1.2", aliases: [], summary: "Electron 40.0.0 lacks runtime security updates", severity: "HIGH", url: "x", packages: [{ pkg: "electron@40.0.0", fixed: ["40.1.2"] }] };
  const unknown = { id: "GHSA-6789-cfgh-jmpq", aliases: [], summary: "s", severity: "HIGH", url: "https://evil.example", packages: [{ pkg: "electron@40.0.0", fixed: [] }] };
  await g.runReport(report([runtime, unknown]));
  const body = g.issue("electron").body;
  assert.ok(body.includes("[ELECTRON-RUNTIME-40.1.2](https://github.com/electron/electron/releases/tag/v40.1.2)"));
  assert.ok(body.includes("**HIGH** `GHSA-6789-cfgh-jmpq`"));
  inert(body);
});

// ------------------------------------------------------------- held -------

const PINNED = "v0.1.6-nightly.20261030.3917";
const NEWER = "v0.1.7-nightly.20261031.4001";

test("the held issue: opened by a hold, its report a code block; closed only for a trusted reason, never by the evaluate job's exit code", async () => {
  const g = github({ issues: [{ number: 5, title: "Upstream nightly releases held", state: "open", user: { login: "someone", type: "User" }, body: "I made this" }] });
  const hold = { channel: "nightly", exit: "3", published: "", pinned: PINNED, newer: [NEWER], report: "# Upstream evaluation\n- device tool x: @repo-owner\n<!-- blacksand {\"v\":1,\"kind\":\"package\",\"channel\":\"nightly\",\"package\":\"x\"} -->" };
  const held = (fields) => reconcileHeld({ ...hold, ...fields }, g.gh, { log: () => {} });
  await held({});
  const [ours] = g.state.issues.filter((i) => i.state === "open" && readMarker(i.body)?.kind === "held");
  assert.match(ours.body, /```text\n# Upstream evaluation\n- device tool x: @repo-owner\n/);
  assert.match(ours.body, /each Mac re-checks any pin itself/i);
  assert.equal(g.find(5).body, "I made this");
  inert(ours.body, { codeBlocks: true });
  // A compromised evaluate job (exit 0 with main's own pin), upstream unreadable, or a pin main doesn't have: open.
  for (const fields of [{ exit: "0" }, { exit: "0", newer: null }, { exit: "0", published: NEWER }]) await held(fields);
  assert.equal(g.find(ours.number).state, "open");
  await held({ report: "changed" });
  assert.match(g.find(ours.number).body, /```text\nchanged\n```/);
  // A pin the commit job pushed and main now has: closed, saying so.
  await held({ exit: "0", published: NEWER, pinned: NEWER, newer: [] });
  assert.equal(g.find(ours.number).state, "closed");
  assert.match(g.on(ours.number).at(-1), /^`v0\.1\.7-nightly\.20261031\.4001` is pinned; releases aren't held anymore\./);
  // Nothing newer upstream: a forged hold can't open it; a failed evaluation still fails the step.
  await held({ newer: [], report: "forged" });
  assert.equal(g.state.issues.filter((i) => i.state === "open" && readMarker(i.body)?.kind === "held").length, 0);
  await assert.rejects(held({ exit: "1" }), /evaluate job failed/);
  await assert.rejects(held({ exit: "1", newer: [] }), /evaluate job failed/);
});

test("the held issue: upstream with nothing newer closes it, a duplicate closes with a link, and an older one is taken over with nothing said", async () => {
  const g = github({ issues: [deployed()[4]] });
  const held = (fields) => reconcileHeld({ channel: "nightly", exit: "3", published: "", pinned: PINNED, newer: [NEWER], report: "x", ...fields }, g.gh, { log: () => {} });
  await held({});
  assert.deepEqual([g.find(6).state, g.on(6)], ["closed", []]);
  const [ours] = g.state.issues.filter((i) => i.state === "open");
  g.state.issues.push({ ...structuredClone(ours), number: 300 });
  await held({});
  assert.deepEqual([g.find(300).state, g.on(300).length], ["closed", 1]);
  await held({ exit: "0", newer: [] });
  assert.equal(g.find(ours.number).state, "closed");
  assert.match(g.on(ours.number).at(-1), /is upstream's newest nightly release/);
});
