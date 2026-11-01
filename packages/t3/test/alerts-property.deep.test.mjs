// node --test test/: the alert job's issues (ci/reconcile.mjs) over
// random sequences of hourly runs, against an oracle that reads only the raw
// per-source records (never lib/advisories.mjs's merge) and its own copy of the
// owner's policy: high, critical and unrated ratings notify. Between and during
// runs: requests that fail before or after they land, closes or comments that
// fail for a whole run, checks that don't cover everything, owner notes,
// duplicates, the deployed version's issues, and a package past what one text
// can list. After every run that succeeded it checks that issues open and close
// as the records say, that nothing is on record as announced that wasn't named,
// nothing is said twice, nothing alerting goes unsaid, notes are kept, and every
// text is inert and within GitHub's limit.
//
// Fixed seeds: a failure names its seed; T3B_PROPERTY_SEED=<n> reruns it alone,
// T3B_PROPERTY_SEEDS=<n> runs seeds 1 to n.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { mergeAdvisories } from "../lib/advisories.mjs";
import { BOT, markerOf, readIssue, readMarker, reconcileAdvisories } from "../ci/reconcile.mjs";
import { listedPackages, parse, problems, statedPairs } from "./alerts-markdown.mjs";

const LIMIT = 65_536;
const CANARY = "pwn@evil";
const HOSTILE = `@repo-owner [Install the fix](https://evil.example/x) <img src=x> www.evil.example ${CANARY}`;

// The oracle's own reading of the policy: ratings from the least to the most alarming, anything else unrated.
const ORDER = ["LOW", "MODERATE", "UNKNOWN", "HIGH", "CRITICAL"];
const rating = (s) => (ORDER.includes(s) ? s : "UNKNOWN");
const ALERTS = new Set(["UNKNOWN", "HIGH", "CRITICAL"]);
const alertsOf = (pairs) => new Map([...pairs].filter(([, r]) => ALERTS.has(r)));
const PACKAGES = ["p", "q", "@s/r", `x[${CANARY}](https://evil.example)`];
const IDS = ["GHSA-2222-3333-4444", "GHSA-5555-6666-7777", "GHSA-8888-9999-cccc", "GHSA-cfgh-jmpq-rvwx", "MAL-2026-1", "OSV-2026-2", "OSV-2026-3", `OSV\`]${CANARY} (x)`, "GHSA-2345-6789-cfgh", "OSV-2026-4"];
const ALIASES = [...IDS.slice(0, 5), "CVE-2026-1", "CVE-2026-2"];
const SOURCES = ["osv", "github", "github-repository"];

const record = (id, source, pkgs, severity, { aliases = [], summary = `${id} summary`, fixed = ["9.9.9"], repository = "example/tool" } = {}) => ({
  id,
  aliases,
  summary,
  severity,
  url: "https://attacker.example/ignored",
  packages: pkgs.map((pkg) => ({ pkg, fixed })),
  sources: [source],
  ...(source === "github-repository" ? { repository } : {}),
});

/** mulberry32: a small seeded PRNG. */
function prng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (random, items) => items[Math.floor(random() * items.length)];
const some = (random, items, p) => items.filter(() => random() < p);

/** One run's raw records: what each source said, before any merge. */
function draw(random) {
  const records = [];
  for (const id of IDS) {
    if (random() < 0.45) continue;
    for (const source of some(random, SOURCES, 0.45).slice(0, 2).concat(random() < 0.3 ? [] : [pick(random, SOURCES)]).filter((s, i, all) => all.indexOf(s) === i).slice(0, 2)) {
      const pkgs = some(random, PACKAGES, 0.4).flatMap((name) => (random() < 0.3 ? [`${name}@1.0.0`, `${name}@2.0.0`] : [`${name}@1.0.0`]));
      if (!pkgs.length) continue;
      records.push(
        record(id, source, pkgs, pick(random, [...ORDER, "weird", "medium", "LOW", "MODERATE", "LOW", "MODERATE"]), {
          aliases: some(random, ALIASES, 0.15).filter((alias) => alias !== id),
          summary: pick(random, ["", "plain", HOSTILE, `\`${HOSTILE}\``, "x".repeat(400)]),
          fixed: some(random, ["1.0.1", " ", "`", "", `\` ${HOSTILE}`, "2.0.1"], 0.3),
          repository: pick(random, ["example/tool", "zzz/tool", "example/.."]),
        }),
      );
    }
  }
  return records;
}

/** A package past what one text can list: 195 to 264 HIGH records with long ids. */
const bigRecords = (random) => Array.from({ length: 195 + Math.floor(random() * 70) }, (_, i) => record(`OSV-${String(i).padStart(60, "0")}`, "osv", ["big@1.0.0"], "HIGH", { summary: "x".repeat(200) }));

/** What names each package, from the raw records alone: Map name -> Map id -> the most alarming rating any record with that id gives it. */
function oracle(records) {
  const out = new Map();
  for (const r of records) {
    for (const { pkg } of r.packages) {
      const name = pkg.slice(0, pkg.lastIndexOf("@"));
      const ids = out.get(name) ?? new Map();
      if (!ids.has(r.id) || ORDER.indexOf(rating(r.severity)) > ORDER.indexOf(ids.get(r.id))) ids.set(r.id, rating(r.severity));
      out.set(name, ids);
    }
  }
  return out;
}

/** GitHub's issues in memory; `fail(what, fields)` may make a request fail before ("before") or after ("after") it lands. */
function github(issues) {
  const state = { issues: structuredClone(issues), comments: [], created: [] };
  let next = 100;
  let fail = () => null;
  const find = (number) => state.issues.find((issue) => issue.number === number);
  const change = (what, apply, fields) => {
    const when = fail(what, fields);
    if (when === "before") throw new Error(`GitHub ${what} answered 502`);
    const out = apply();
    if (when === "after") throw new Error(`GitHub ${what}: the response was lost`);
    return out;
  };
  const read = (what, value) => {
    if (fail(what) === "before") throw new Error(`GitHub ${what} answered 502`);
    return structuredClone(value);
  };
  return {
    state,
    find,
    failWith: (f) => (fail = f),
    gh: {
      ensureLabel: async () => {},
      openIssues: async () => read("GET issues", state.issues.filter((issue) => issue.state === "open")),
      comments: async (number) => read("GET comments", state.comments.filter((c) => c.number === number)),
      comment: async (number, body) => change("POST comment", () => state.comments.push({ number, body, user: { login: BOT, type: "Bot" } })),
      createIssue: async (fields) =>
        change("POST issue", () => {
          const issue = { number: next++, state: "open", user: { login: BOT, type: "Bot" }, labels: [], ...fields };
          state.issues.push(issue);
          state.created.push({ number: issue.number, body: fields.body });
          return structuredClone(issue);
        }),
      updateIssue: async (number, fields) => change("PATCH issue", () => Object.assign(find(number), fields), fields),
    },
  };
}

/** The markers of a text, outside code. */
const markersOf = (body) =>
  parse(body)
    .filter((t) => t.type === "html")
    .map((t) => /^<!-- t3blackout (\{[^\n]*\}) -->/.exec(t.raw)?.[1])
    .filter(Boolean)
    .map((json) => JSON.parse(json));
const LIFECYCLE = new Set(["notify", "fixed", "no-longer-alerting"]);
const CUT = /^- …and \d+ more advisories, left out to fit GitHub's limit; /m;
const NO_LONGER = /^No longer high or critical: now rated /;
const hashOf = (id) => createHash("sha256").update(id).digest("hex").slice(0, 16);
const withoutUnsent = (body) => body.replace(/,"unsent":\[[^\]]*\]/, "");
const samePairs = (x, y) => x.size === y.size && [...x].every(([id, r]) => y.get(id) === r);

/** The deployed version's package issue: an older marker, no START line. */
const deployedIssue = () => ({
  number: 1,
  title: "[security] p (nightly)",
  state: "open",
  user: { login: BOT, type: "Bot" },
  body: `Advisories open against \`p\` in the pinned nightly release:\n\n- **HIGH** [${IDS[0]}](https://osv.dev/vulnerability/${IDS[0]}): \`old\`\n\n${markerOf({ kind: "package", channel: "nightly", package: "p", ids: [IDS[0]], notified: [IDS[0]] })}`,
});

test("property: issues follow the raw records; nothing is on record unsaid, said twice, or left unsaid; notes are kept; every text is inert", async () => {
  const seen = { runs: 0, failed: 0, incomplete: 0, closes: 0, fixed: 0, noLonger: 0, notified: 0, again: 0, cutNotices: 0, owedSaid: 0, lower: 0, lists: 0, duplicates: 0, notes: 0, bigSequences: 0, deployed: 0, closeOutages: 0, commentOutages: 0, notesRed: 0 };
  const only = process.env.T3B_PROPERTY_SEED ? [Number(process.env.T3B_PROPERTY_SEED)] : null;
  const seeds = only ?? Array.from({ length: Number(process.env.T3B_PROPERTY_SEEDS ?? 300) }, (_, i) => i + 1);
  for (const seed of seeds) {
    try {
      const random = prng(seed);
      const deployed = random() < 0.3;
      seen.deployed += deployed;
      const g = github(deployed ? [deployedIssue()] : []);
      const big = random() < 0.1 ? bigRecords(random) : null;
      seen.bigSequences += Boolean(big);
      const names = big ? [...PACKAGES, "big"] : PACKAGES;
      const notes = new Map(); // issue number -> every owner note added to it
      const models = new Map(); // package issue number -> its record as this oracle reads it: Map id -> rating
      let records = draw(random);
      let complete = random() >= 0.2;
      let last = null; // the previous run's oracle and completeness, when it succeeded with nothing left to say
      for (let step = 0; step < 9; step++) {
        const why = `step ${step}`;
        // Between runs: an owner's note, a long one on the big package's issue, or a duplicate.
        const open = g.state.issues.filter((issue) => issue.state === "open" && readIssue(issue.body)?.notes && ["package", "rolling"].includes(readMarker(issue.body).kind));
        let touched = false;
        if (open.length && random() < 0.15) {
          const issue = pick(random, open);
          const note = `Owner note ${step}: watching this.`;
          issue.body = random() < 0.5 ? `${issue.body}\n\n${note}` : `${note}\n\n${issue.body}`;
          notes.set(issue.number, [...(notes.get(issue.number) ?? []), note]);
          touched = true;
          seen.notes++;
        }
        const bigIssue = open.find((issue) => readMarker(issue.body).package === "big");
        if (bigIssue && random() < 0.3 && bigIssue.body.length + 20_000 < LIMIT) {
          const note = `Owner note BIG ${step}: ${"n".repeat(19_970)}`;
          bigIssue.body += `\n${note}`;
          notes.set(bigIssue.number, [...(notes.get(bigIssue.number) ?? []), note]);
          touched = true;
          seen.notes++;
        }
        if (open.length && random() < 0.1) {
          g.state.issues.push({ ...structuredClone(pick(random, open)), number: 1000 + g.state.issues.length });
          touched = true;
          seen.duplicates++;
        }
        // During the run: one request fails before or after it lands; or every close, or every comment, fails.
        let calls = 0;
        const failAt = random() < 0.25 ? 1 + Math.floor(random() * 8) : 0;
        const mode = random() < 0.5 ? "before" : "after";
        const closes = random() < 0.1;
        const comments = random() < (big ? 0.25 : 0.08);
        seen.closeOutages += closes;
        seen.commentOutages += comments;
        g.failWith((what, fields) => ((closes && what === "PATCH issue" && fields?.state === "closed") || (comments && what === "POST comment") ? "before" : ++calls === failAt ? (what.startsWith("GET") ? "before" : mode) : null));
        // The big package: complete checks see it all, sometimes with a batch of new CRITICALs past one comment's
        // hundred, which sort ahead of what's still to be said; incomplete ones see one new record, or nothing of it.
        const bigNow = !big
          ? []
          : complete
            ? [...big, ...(random() < 0.3 ? Array.from({ length: 110 }, (_, i) => record(`OSV-B${step}-${i}`, "osv", ["big@1.0.0"], "CRITICAL", { summary: "x" })) : [])]
            : random() < 0.5
              ? [record(`OSV-2026-8${step}`, "osv", ["big@1.0.0"], pick(random, ["HIGH", "CRITICAL", "UNKNOWN"]))]
              : [];
        const world = [...records, ...bigNow];
        const openBefore = new Set(g.state.issues.filter((issue) => issue.state === "open").map((issue) => issue.number));
        const bodiesBefore = new Map(g.state.issues.map((issue) => [issue.number, issue.body]));
        const commentsBefore = g.state.comments.length;
        const createdBefore = g.state.created.length;
        let ok = true;
        try {
          await reconcileAdvisories({ channel: "nightly", release: "v1", sha: "a".repeat(40), sources: [], gaps: complete ? [] : ["a source couldn't be read"], open: mergeAdvisories(world) }, g.gh, { log: () => {}, run: "https://github.com/o/r/actions/runs/1" });
        } catch (error) {
          // A request that failed, or the parts that did, each with what GitHub answered or why nothing changed.
          assert.match(error.message, /^GitHub |^\d+ part\(s\) of the alert issues couldn't be brought up to date; the rest were:\n(- [^\n]*: (GitHub [^\n]*|its notes [^\n]*shorten them)(\n|$))+$/, `${why}: ${error.stack}`);
          seen.notesRed += /shorten them/.test(error.message);
          ok = false;
        }
        g.failWith(() => null);
        seen.runs++;
        // Whatever happened: every text is inert and within GitHub's limit; the list is never commented on.
        for (const c of g.state.comments.slice(commentsBefore)) {
          assert.ok(c.body.length <= LIMIT, `${why}: a comment past GitHub's limit`);
          assert.deepEqual(problems(c.body, { canary: CANARY, issueRefs: /^(Superseded by|Closing as a duplicate of) #/.test(c.body) }), [], `${why}: ${c.body}`);
          assert.notEqual(readMarker(g.find(c.number).body)?.kind, "rolling", `${why}: a comment on the moderate and low list`);
        }
        for (const issue of g.state.issues) {
          if (issue.body === bodiesBefore.get(issue.number)) continue;
          assert.ok(issue.body.length <= LIMIT, `${why}: #${issue.number} past GitHub's limit`);
          assert.deepEqual(problems(issue.body, { canary: CANARY }), [], `${why}: #${issue.number}`);
        }
        // The oracle's model of each package issue's record, from what it received in order: the alerting pairs its
        // opening named, then each change comment's entries; a closing empties it. Said once: no entry names an
        // alerting pair the record already holds at that rating.
        const world_ = oracle(world);
        const before_ = new Map([...models].map(([number, told]) => [number, new Map(told)]));
        for (const { number, body } of g.state.created.slice(createdBefore)) if (readMarker(body)?.kind === "package") models.set(number, alertsOf(statedPairs(body)));
        for (const c of g.state.comments.slice(commentsBefore)) {
          const told = models.get(c.number);
          const kind = markersOf(c.body).find((m) => LIFECYCLE.has(m.kind))?.kind;
          if (!told || !kind) continue;
          if (kind !== "notify") {
            told.clear();
            continue;
          }
          const want = world_.get(readMarker(g.find(c.number).body).package) ?? new Map();
          const held = [...told.keys()]; // the record before this comment: what "no longer named" counts
          for (const item of parse(c.body).filter((t) => t.type === "list").flatMap((t) => t.items)) {
            const text = item.raw.trim();
            const [pair] = statedPairs(text);
            const gone = /^- No longer named: (\d+) /.exec(text);
            if (/^- Seen by an earlier check, whose comment didn't go out: /.test(text)) {
              seen.owedSaid++;
              if (!/ \((rated [A-Z]+|not named) now\)$/.test(text)) told.set(...pair);
            } else if (/^- (New: |Now )/.test(text)) {
              if (ALERTS.has(pair[1])) {
                assert.notEqual(told.get(pair[0]), pair[1], `${why}: #${c.number}: ${pair[0]} at ${pair[1]} said again, already on record`);
                told.set(...pair);
              } else {
                assert.ok(told.has(pair[0]), `${why}: #${c.number}: ${pair[0]} said to be lower now, but it wasn't on record`);
                told.delete(pair[0]);
                seen.lower++;
              }
            } else if (gone) {
              const ids = held.filter((id) => !want.has(id));
              assert.equal(Number(gone[1]), ids.length, `${why}: #${c.number}: no longer named ${gone[1]}, the record held ${ids.length} not named now`);
              for (const id of ids) told.delete(id);
            }
          }
        }
        if (!ok) {
          seen.failed++;
          last = null;
        } else {
          const expected = oracle(world);
          const quiet = new Map();
          let owed = false;
          // Owner notes are never dropped from an open issue.
          for (const [number, added] of notes) if (g.find(number).state === "open") for (const note of added) assert.ok(g.find(number).body.includes(note), `${why}: #${number} lost an owner note`);
          for (const name of names) {
            const want = expected.get(name) ?? new Map();
            const alerts = alertsOf(want);
            if (want.size && !alerts.size) quiet.set(name, want);
            const issues = g.state.issues.filter((issue) => issue.state === "open" && readMarker(issue.body)?.package === name);
            const had = issues.some((issue) => openBefore.has(issue.number)) || g.state.issues.some((issue) => openBefore.has(issue.number) && readMarker(issue.body)?.package === name);
            assert.ok(issues.length <= 1, `${why}: ${name} has ${issues.length} open issues`);
            if (complete || alerts.size) assert.equal(issues.length, alerts.size ? 1 : 0, `${why}: ${name} open exactly while an alerting record names it`);
            else assert.equal(issues.length, had ? 1 : 0, `${why}: a check that didn't cover everything neither closes nor opens ${name}`);
            const [issue] = issues;
            if (issue && !readIssue(issue.body).notes) {
              // The deployed version's issue: left as it was while nothing takes over or closes it.
              assert.deepEqual([issue.number, issue.body, complete || alerts.size > 0], [1, deployedIssue().body, false], `${why}: ${name}'s older issue left open`);
            } else if (issue) {
              const fresh = g.state.created.slice(createdBefore).some((c) => c.number === issue.number);
              const listed = statedPairs(issue.body);
              if (complete) {
                if (CUT.test(issue.body)) for (const [id, r] of listed) assert.equal(want.get(id), r, `${why}: ${name}'s cut list names ${id} at ${r}`);
                else assert.ok(samePairs(listed, want), `${why}: ${name} lists ${JSON.stringify([...listed])}, the records say ${JSON.stringify([...want])}`);
              } else if (!fresh && bodiesBefore.has(issue.number)) {
                assert.equal(withoutUnsent(issue.body), withoutUnsent(bodiesBefore.get(issue.number)), `${why}: ${name}'s text rewritten by a check that didn't cover everything`);
              }
              // Its record (the latest lifecycle comment's, else its own marker's) is exactly the oracle's model: nothing on
              // record that a received text didn't name, nothing named that isn't.
              const opening = g.state.created.find((c) => c.number === issue.number).body;
              const lifecycle = g.state.comments.filter((c) => c.number === issue.number).map((c) => ({ ...(markersOf(c.body).find((m) => LIFECYCLE.has(m.kind)) ?? { kind: "other" }), body: c.body })).filter((e) => LIFECYCLE.has(e.kind));
              const told = models.get(issue.number);
              const recordSeen = lifecycle.length ? lifecycle.at(-1).seen ?? "" : readMarker(issue.body).seen;
              const record = new Map((recordSeen.match(/.{17}/g) ?? []).map((entry) => [entry.slice(0, 16), { U: "UNKNOWN", H: "HIGH", C: "CRITICAL" }[entry[16]]]));
              assert.deepEqual(record, new Map([...told].map(([id, r]) => [hashOf(id), r])), `${why}: ${name}'s record isn't what it was told: ${JSON.stringify([...told])}`);
              // What earlier runs were to say (`unsent`) leaves the marker only once a received comment names it: each entry
              // not on record before this run is named by one of this run's comments, or still kept; nothing else is kept
              // but what alerts now; and once a comment names everything (it isn't cut), nothing is.
              const unsentBefore = bodiesBefore.has(issue.number) ? readMarker(bodiesBefore.get(issue.number)).unsent ?? [] : [];
              const unsentAfter = readMarker(issue.body).unsent ?? [];
              const newComments = g.state.comments.slice(commentsBefore).filter((c) => c.number === issue.number).map((c) => c.body);
              const namedNow = new Set(newComments.flatMap((body) => parse(body).filter((t) => t.type === "list").flatMap((t) => t.items).flatMap((item) => [...statedPairs(item.raw).keys()])));
              const letter = { UNKNOWN: "U", HIGH: "H", CRITICAL: "C" };
              for (const entry of unsentBefore) {
                const [id, r] = [entry.slice(1), { U: "UNKNOWN", H: "HIGH", C: "CRITICAL" }[entry[0]]];
                if (before_.get(issue.number)?.get(id) === r) continue;
                assert.ok(namedNow.has(id) || unsentAfter.some((kept) => kept.slice(1) === id), `${why}: ${name}'s unsent ${id} at ${r} dropped, never said`);
              }
              for (const entry of unsentAfter) assert.ok(unsentBefore.includes(entry) || alerts.get(entry.slice(1)) && letter[alerts.get(entry.slice(1))] === entry[0], `${why}: ${name} keeps ${entry}, neither owed nor alerting`);
              if (!newComments.length || !CUT.test(newComments.at(-1))) assert.deepEqual(unsentAfter, [], `${why}: ${name} still holds what it was to say`);
              // Never left unsaid: every alerting pair is on record at its rating, or the latest notification was cut
              // (the next run says the rest).
              const unsaid = [...alerts].filter(([id, r]) => told.get(id) !== r);
              const latest = lifecycle.filter((e) => e.kind === "notify").at(-1)?.body ?? opening;
              if (unsaid.length) {
                assert.ok(CUT.test(latest), `${why}: ${name}'s ${JSON.stringify(unsaid)} never said`);
                owed = true;
                seen.cutNotices++;
              }
              // While it alerts, the latest word on it is never a closing.
              if (alerts.size) assert.ok(!["fixed", "no-longer-alerting"].includes(lifecycle.at(-1)?.kind), `${why}: ${name} alerts, but the latest word on it is a closing`);
              // Said once: lifecycle comments are numbered 1, 2, 3...; a repeated one (a retry, a lost response) would repeat a number.
              assert.deepEqual(lifecycle.map((e) => e.n), lifecycle.map((_, i) => i + 1), `${why}: ${name}'s lifecycle comments`);
            }
            // A package issue closed this run (not as a duplicate or superseded) says honestly why, last.
            for (const closed of g.state.issues.filter((i) => openBefore.has(i.number) && i.state === "closed" && readMarker(i.body)?.package === name)) {
              const comments = g.state.comments.filter((c) => c.number === closed.number).map((c) => c.body);
              if (comments.some((body) => /^Closing as a duplicate of #|^Superseded by #/.test(body))) continue;
              assert.ok(complete && !alerts.size, `${why}: ${name} closed while alerting, or on a check that didn't cover everything`);
              const reason = comments.filter((body) => /^Fixed:/.test(body) || NO_LONGER.test(body)).at(-1) ?? "";
              if (want.size) assert.match(reason, NO_LONGER, `${why}: ${name} closed while still named, without saying so`);
              else assert.match(reason, /^Fixed:/, `${why}: ${name} closed with nothing naming it, but not "Fixed"`);
              assert.equal(closed.state_reason, want.size ? "not_planned" : "completed");
              seen[want.size ? "noLonger" : "fixed"]++;
            }
          }
          // The moderate and low list: open, listing exactly the packages named only by moderate and low records, while
          // there are any; a check that didn't cover everything never closes it.
          const lists = g.state.issues.filter((issue) => issue.state === "open" && readMarker(issue.body)?.kind === "rolling");
          assert.ok(lists.length <= 1, `${why}: ${lists.length} moderate and low lists`);
          if (complete || quiet.size) assert.equal(lists.length, quiet.size ? 1 : 0, `${why}: the moderate and low list open exactly while a package is named only by moderate or low records`);
          if (quiet.size) {
            const listed = listedPackages(lists[0].body);
            assert.deepEqual([...listed.keys()].sort(), [...quiet.keys()].sort(), `${why}: the list's packages`);
            for (const [name, want] of quiet) assert.ok(samePairs(listed.get(name), want), `${why}: ${name} in the list`);
            seen.lists++;
          }
          // Nothing new happened (and nothing was left to say): nothing is opened or said.
          const newComments = g.state.comments.slice(commentsBefore);
          if (last && !touched && last.complete === complete && [...new Set([...last.expected.keys(), ...expected.keys()])].every((name) => samePairs(last.expected.get(name) ?? new Map(), expected.get(name) ?? new Map()))) {
            assert.deepEqual(g.state.created.slice(createdBefore), [], `${why}: opened an issue for nothing new`);
            assert.deepEqual(newComments, [], `${why}: commented on nothing new`);
          }
          for (const c of newComments) {
            if (markersOf(c.body).some((m) => m.kind === "notify")) seen.notified++;
            if (/again, after the comment above said this issue closes/.test(c.body)) seen.again++;
          }
          seen.closes += g.state.issues.filter((issue) => openBefore.has(issue.number) && issue.state === "closed").length;
          seen.incomplete += !complete;
          last = owed ? null : { expected, complete };
        }
        // The next hour: after a failure, often the same world again (a retry); otherwise it moves on.
        if (ok || random() < 0.5) {
          if (random() < 0.7) records = draw(random);
          complete = random() >= 0.2;
        }
      }
    } catch (error) {
      throw new Error(`seed ${seed} (rerun it alone: T3B_PROPERTY_SEED=${seed} node --test test/alerts-property.deep.test.mjs): ${error.message}`, { cause: error });
    }
  }
  assert.equal(seen.runs, seeds.length * 9);
  if (only) return;
  if (process.env.T3B_PROPERTY_COUNTS) console.log(JSON.stringify(seen));
  const floor = { bigSequences: 5, cutNotices: 5, again: 3, owedSaid: 5, notesRed: 0 };
  for (const [what, n] of Object.entries(seen)) assert.ok(n >= (floor[what] ?? 20), `the sequences exercise ${what} (${n})`);
});
