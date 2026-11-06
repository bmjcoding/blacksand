// What the dependency age gate costs, measured on our own runs, so a future
// change to its length rests on data (decision 43). The alerts job's last step
// (.github/workflows/evaluate.yml, through security-issues.mjs) keeps one issue
// per channel, "[metrics] Age gate and fast lane (<channel>)", labelled
// `metrics`, never `security`: edited in place each run and never commented on,
// so after it opens it doesn't notify. It records:
//   - holds: each candidate release the age gate held, with the young
//     dependency versions that held it and their publish times, from the first
//     run that held it to the first run it passed the age gate in, or that no
//     longer evaluated it (superseded: the pin moved past it, or newer releases
//     took its place);
//   - held fixes: a young version that fixes an advisory open against the
//     version it replaces (lib/fastlane.mjs waive.decisions()), from the first
//     run that met it to its admission: by the fast lane, by an owner override
//     (main's lib/overrides.json covers every vulnerable version it replaces,
//     as lib/overrides.mjs overrideFor matches them), or by aging out (its
//     publish time plus the minimum age). That span is how long the gate kept
//     us on the known-vulnerable version;
//   - fast-lane decisions: each admission, and each refusal with its reason, once
//     per version and reason (not once per hourly run), with the time from the
//     fix's publication.
// State lives in the issue's marker (reconcile.mjs's markers). The totals count
// every event; the last EVENTS are listed too. The marker is held under
// STATE_MAX: the oldest listed events go first, then what it tracks (counted as
// dropped). Closing the issue starts the figures over.
// The figures come from the evaluate job, which ran upstream code: they're
// checked for shape here, rendered inert (reconcile.mjs code), and decide
// nothing. Nothing here can fail the alerts job: metricsStep returns its
// problems for the caller to report.

import * as fs from "node:fs";

import { REFUSALS } from "../lib/fastlane.mjs";
import { MIN_AGE_DAYS } from "../lib/gates.mjs";
import { overrideFor } from "../lib/overrides.mjs";
import { isReleaseTag } from "../lib/pin.mjs";
import { parseVersion } from "../lib/semver.mjs";
import { BOT, code as inert, compose, createOnce, markerOf, notesOf, ownedIssues, rewrite, sortOut } from "./reconcile.mjs";

const CHANNELS = new Set(["nightly", "preview", "stable"]);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** How many recent events the issue lists. */
export const EVENTS = 30;
/** The marker's size limit, in characters: half of GitHub's, so the text above it always has room. */
export const STATE_MAX = 30_000;
const MAX_TEXT = 300;
/** The most candidates a run reports: lib/evaluate.mjs MAX_LOOKBACK (kept equal by test/age-gate-metrics.test.mjs). */
export const MAX_CANDIDATES = 40;
const HOW_FIX = { "fast-lane": "fast lane", override: "owner override", aged: "aged out" };
const HOW_SAID = { "fast-lane": "by the fast lane", override: "by an owner override", aged: "by aging out" };
const HOW_HOLD = new Set(["passed", "superseded"]);
const CODES = new Set(["admitted", ...Object.keys(REFUSALS)]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// ------------------------------------------------------------- reading ------

const isTime = (v) => typeof v === "string" && ISO.test(v) && Number.isFinite(Date.parse(v));
const ms = (v) => Date.parse(v);
const iso = (t) => new Date(t).toISOString();
/** A name@version as the evaluator reports it: any text, bounded (rendered inert, never trusted). */
const isPkg = (v) => typeof v === "string" && v.length <= MAX_TEXT && v.lastIndexOf("@") > 0;
const isId = (v) => typeof v === "string" && ID.test(v);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
const listOf = (v, max, ok) => (Array.isArray(v) ? v.filter(ok).slice(0, max) : []);
const pair = (p) => Array.isArray(p) && p.length === 2 && isPkg(p[0]) && (p[1] === null || isTime(p[1]));
/** A histogram { "<whole hours>": n }, as the totals keep durations. */
const histogram = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([k, n]) => /^\d{1,6}$/.test(k) && count(n) > 0).slice(0, 500)) : {});
const tally = (v, keys) => (v && typeof v === "object" ? Object.fromEntries([...keys].filter((k) => count(v[k]) > 0).map((k) => [k, count(v[k])])) : {});

/**
 * The evaluator's metrics for one run (lib/evaluate.mjs evaluateChannel
 * `metrics`, written by bin/t3 evaluate --metrics) for `channel`, checked for
 * shape: null when they aren't that. Its time is never later than `now`.
 */
export function readRun(raw, channel, now = Date.now()) {
  if (!raw || typeof raw !== "object" || raw.v !== 1 || raw.channel !== channel || !isTime(raw.at) || !Array.isArray(raw.candidates) || !Array.isArray(raw.decisions)) return null;
  const tag = (ref) => (isReleaseTag(ref, channel) ? ref : null);
  const candidates = listOf(raw.candidates, MAX_CANDIDATES, (c) => tag(c?.ref) && typeof c.held === "boolean" && (c.young === null || Array.isArray(c.young))).map((c) => ({
    ref: c.ref,
    held: c.held,
    // How many young versions held it (every one the run named, whatever its text), and those this can show.
    young: c.young === null ? null : { n: c.young.length, pkgs: listOf(c.young, 5, (p) => isPkg(p?.pkg) && isTime(p.publishedAt)).map((p) => [p.pkg, p.publishedAt]) },
  }));
  const decisions = listOf(
    raw.decisions,
    200,
    (d) => isPkg(d?.pkg) && typeof d.admitted === "boolean" && CODES.has(d.code) && d.admitted === (d.code === "admitted") && (d.publishedAt === null || d.publishedAt === undefined || isTime(d.publishedAt)),
  ).map((d) => ({
    pkg: d.pkg,
    pub: d.publishedAt ?? null,
    code: d.code,
    why: typeof d.reason === "string" ? d.reason.slice(0, 160) : "",
    adv: listOf(d.advisories, 5, isId),
    rep: listOf(d.replaces, 3, isPkg),
  }));
  return { at: iso(Math.min(ms(raw.at), now)), pinned: tag(raw.pinned), pinnedTo: tag(raw.pinnedTo), fastLane: raw.fastLane === true, candidates, decisions };
}

export const emptyState = () => ({
  since: null,
  at: null,
  runs: 0,
  totals: { holds: 0, superseded: 0, holdHours: {}, holdMaxMs: 0, fixes: 0, how: {}, fixMs: 0, fixMaxMs: 0, admitted: 0, laneHours: {}, refused: {}, dropped: 0 },
  holds: [],
  fixes: [],
  events: [],
});

const readHold = (h) => (h && tagLike(h.ref) && isTime(h.first) ? { ref: h.ref, first: h.first, n: count(h.n), pkgs: listOf(h.pkgs, 5, pair) } : null);
const tagLike = (ref) => typeof ref === "string" && ref.length <= 100 && isReleaseTag(ref);
const readFix = (f) => {
  if (!f || !isPkg(f.pkg) || !(f.pub === null || isTime(f.pub)) || !isTime(f.first) || !(f.code === null || CODES.has(f.code))) return null;
  const done = f.done && HOW_FIX[f.done.how] && isTime(f.done.at) ? { how: f.done.how, at: f.done.at } : null;
  // The codes already counted for it: each at most once, so no more than CODES.
  const seen = [...new Set(listOf(f.seen, CODES.size, (c) => CODES.has(c)))];
  return { pkg: f.pkg, pub: f.pub, rep: listOf(f.rep, 3, isPkg), adv: listOf(f.adv, 5, isId), first: f.first, code: f.code, seen, done };
};
const readEvent = (e) => {
  if (!e || !isTime(e.at)) return null;
  if (e.t === "hold" && tagLike(e.ref) && isTime(e.first) && HOW_HOLD.has(e.how)) return { t: "hold", ref: e.ref, first: e.first, at: e.at, how: e.how, n: count(e.n), pkgs: listOf(e.pkgs, 3, pair) };
  if (e.t === "fix" && isPkg(e.pkg) && isTime(e.first) && HOW_FIX[e.how] && (e.pub === null || isTime(e.pub))) return { t: "fix", pkg: e.pkg, pub: e.pub, first: e.first, at: e.at, how: e.how, rep: listOf(e.rep, 3, isPkg), adv: listOf(e.adv, 5, isId) };
  if (e.t === "lane" && isPkg(e.pkg) && CODES.has(e.code) && (e.pub === null || isTime(e.pub))) return { t: "lane", pkg: e.pkg, pub: e.pub, at: e.at, code: e.code, why: typeof e.why === "string" ? e.why.slice(0, 160) : "", rep: listOf(e.rep, 3, isPkg), adv: listOf(e.adv, 5, isId) };
  return null;
};
const present = (x) => x !== null;

/** A metrics issue marker's `state`, checked field by field: what doesn't check out is left out, and none at all is a fresh start. */
export function readState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;
  const t = raw.totals ?? {};
  state.since = isTime(raw.since) ? raw.since : null;
  state.at = isTime(raw.at) ? raw.at : null;
  state.runs = count(raw.runs);
  for (const key of ["holds", "superseded", "holdMaxMs", "fixes", "fixMs", "fixMaxMs", "admitted", "dropped"]) state.totals[key] = count(t[key]);
  state.totals.holdHours = histogram(t.holdHours);
  state.totals.laneHours = histogram(t.laneHours);
  state.totals.how = tally(t.how, Object.keys(HOW_FIX));
  state.totals.refused = tally(t.refused, Object.keys(REFUSALS));
  state.holds = (Array.isArray(raw.holds) ? raw.holds.slice(0, 50) : []).map(readHold).filter(present);
  state.fixes = (Array.isArray(raw.fixes) ? raw.fixes.slice(0, 200) : []).map(readFix).filter(present);
  state.events = (Array.isArray(raw.events) ? raw.events.slice(0, EVENTS) : []).map(readEvent).filter(present);
  return state;
}

// ------------------------------------------------------------- merging ------

/** Whole hours, as the histograms keep them. */
const hoursOf = (duration) => String(Math.max(0, Math.round(duration / HOUR)));

/** Drops what the marker can't hold within STATE_MAX: the oldest listed events, then settled fixes, then what's tracked (counted as dropped). */
function fit(state, channel) {
  const size = () => markerOf({ kind: "metrics", channel, state }).length;
  while (size() > STATE_MAX) {
    const settled = state.fixes.findIndex((f) => f.done);
    if (state.events.length) state.events.pop();
    else if (settled >= 0) state.fixes.splice(settled, 1);
    else if (state.fixes.length || state.holds.length) {
      (state.fixes.length ? state.fixes : state.holds).shift();
      state.totals.dropped++;
    } else break;
  }
}

/** Whether one of `overrides` (lib/overrides.mjs readOverrides's) covers `pkg`, a name@version as the evaluator reported it. */
const covered = (pkg, overrides) => parseVersion(pkg.slice(pkg.lastIndexOf("@") + 1)) !== null && overrideFor(pkg, overrides) !== null;

/**
 * `state` with `run` (readRun's, or null when the evaluation left none) taken
 * in, at `now`: { state, events (those new here, oldest first) }. A run no
 * later than the last one taken in (a re-run job) changes nothing; what a
 * held fix's admission by override (`overrides`: main's lib/overrides.json,
 * as readOverrides returns it, covering every version the fix replaces) or by
 * aging out (`minAgeDays`) needs is checked every time, a run or not.
 */
export function mergeRun(prior, run, { channel = "nightly", now = Date.now(), minAgeDays = MIN_AGE_DAYS, overrides = [] } = {}) {
  const state = structuredClone(prior);
  const t = state.totals;
  const events = [];
  const add = (event) => {
    events.push(event);
    state.events.unshift(event);
  };
  const bump = (histogram, duration) => {
    const key = hoursOf(duration);
    histogram[key] = (histogram[key] ?? 0) + 1;
  };
  const closeHold = (hold, how, at) => {
    const duration = Math.max(0, ms(at) - ms(hold.first));
    t.holds++;
    if (how === "superseded") t.superseded++;
    bump(t.holdHours, duration);
    t.holdMaxMs = Math.max(t.holdMaxMs, duration);
    add({ t: "hold", ref: hold.ref, first: hold.first, at, how, n: hold.n, pkgs: hold.pkgs.slice(0, 3) });
  };
  const settle = (fix, how, at) => {
    fix.done = { how, at };
    const duration = Math.max(0, ms(at) - ms(fix.first));
    t.fixes++;
    t.how[how] = (t.how[how] ?? 0) + 1;
    t.fixMs += duration;
    t.fixMaxMs = Math.max(t.fixMaxMs, duration);
    add({ t: "fix", pkg: fix.pkg, pub: fix.pub, first: fix.first, at, how, rep: fix.rep, adv: fix.adv });
  };

  if (run && (!state.at || ms(run.at) > ms(state.at))) {
    state.at = run.at;
    state.since ??= run.at;
    state.runs++;
    // Holds: kept while the run says the age gate holds them, or can't say; else cleared.
    const byRef = new Map(run.candidates.map((c) => [c.ref, c]));
    const holds = [];
    for (const hold of state.holds) {
      const c = byRef.get(hold.ref);
      if (!c) closeHold(hold, "superseded", run.at);
      else if (c.young && c.young.n === 0) closeHold(hold, "passed", run.at);
      else holds.push(c.young ? { ...hold, n: c.young.n, pkgs: c.young.pkgs } : hold);
    }
    for (const c of run.candidates) {
      if (c.young?.n && !holds.some((h) => h.ref === c.ref)) holds.push({ ref: c.ref, first: run.at, n: c.young.n, pkgs: c.young.pkgs });
    }
    state.holds = holds;
    // Fast-lane decisions: counted once per version and outcome, however often it changes back; the
    // latest is what "Held now" shows. An admission settles the held fix.
    for (const d of run.decisions) {
      let fix = state.fixes.find((f) => f.pkg === d.pkg);
      if (fix?.done) continue;
      if (!fix) state.fixes.push((fix = { pkg: d.pkg, pub: d.pub, rep: d.rep, adv: d.adv, first: run.at, code: null, seen: [], done: null }));
      fix.code = d.code;
      fix.pub ??= d.pub;
      if (fix.seen.includes(d.code)) continue;
      fix.seen.push(d.code);
      add({ t: "lane", pkg: d.pkg, pub: fix.pub, at: run.at, code: d.code, why: d.why, rep: fix.rep, adv: fix.adv });
      if (d.code === "admitted") {
        t.admitted++;
        if (fix.pub) bump(t.laneHours, ms(run.at) - ms(fix.pub));
        settle(fix, "fast-lane", run.at);
      } else t.refused[d.code] = (t.refused[d.code] ?? 0) + 1;
    }
  }
  // Held fixes an owner override took (every vulnerable version it replaces covered; one left
  // uncovered keeps it open), or that aged out: whatever this run said, or if it said nothing.
  const gate = minAgeDays * DAY;
  for (const fix of state.fixes.filter((f) => !f.done)) {
    const aged = (fix.pub ? ms(fix.pub) : ms(fix.first)) + gate;
    if (fix.rep.length && fix.rep.every((pkg) => covered(pkg, overrides))) settle(fix, "override", iso(now));
    else if (aged <= now) settle(fix, "aged", iso(Math.max(aged, ms(fix.first))));
  }
  // A settled fix is kept a day past the gate, so a later run's word on it isn't counted again; by then none asks.
  state.fixes = state.fixes.filter((f) => !f.done || (f.pub ? ms(f.pub) : ms(f.first)) + gate + DAY > now);
  state.events = state.events.slice(0, EVENTS);
  fit(state, channel);
  return { state, events };
}

// ----------------------------------------------------------- rendering ------

const when = (time) => `${time.slice(0, 16).replace("T", " ")} UTC`;
const span = (duration) => `${hoursOf(duration)} h`;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/** The lower median of a histogram, in hours; "none yet" for an empty one. */
function median(histogram) {
  const entries = Object.entries(histogram).map(([k, n]) => [Number(k), n]).sort(([a], [b]) => a - b);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return "none yet";
  let seen = 0;
  for (const [hours, n] of entries) if ((seen += n) >= Math.ceil(total / 2)) return `${hours} h`;
  return "none yet";
}

const versions = (pkgs, n) => {
  const shown = pkgs.map(([pkg, pub]) => `${inert(pkg, 120)}${pub ? ` (published ${when(pub)})` : ""}`);
  return `${shown.join(", ") || "versions it couldn't show"}${n > pkgs.length ? ` and ${n - pkgs.length} more` : ""}`;
};
const ids = (adv) => (adv.length ? adv.map((id) => inert(id, 100)).join(", ") : "an open advisory");
const replaced = (rep) => (rep.length ? rep.map((pkg) => inert(pkg, 120)).join(", ") : "the version it replaces");
const outcome = (c) => (c === "admitted" ? "admitted" : `refused (${REFUSALS[c]})`);

/** One event as a list item; everything from outside in code spans. */
function eventLine(e) {
  if (e.t === "hold") return `- ${when(e.at)}: release ${inert(e.ref, 80)} ${e.how === "passed" ? "passed the age gate" : "was superseded"} after ${span(ms(e.at) - ms(e.first))} held, by ${versions(e.pkgs, e.n)}.`;
  if (e.t === "fix") return `- ${when(e.at)}: fix ${inert(e.pkg, 120)} for ${ids(e.adv)} admitted ${HOW_SAID[e.how]}, after ${span(ms(e.at) - ms(e.first))} on ${replaced(e.rep)}${e.pub ? ` (published ${when(e.pub)})` : ""}.`;
  const after = e.pub ? `${span(ms(e.at) - ms(e.pub))} after its publication` : "its publication time unknown";
  return `- ${when(e.at)}: fast lane ${outcome(e.code)} ${inert(e.pkg, 120)} for ${ids(e.adv)}, ${after}: ${inert(e.why, 160, "no reason given")}.`;
}

/** What's held now, at most 10 of each, for the issue's head. */
function heldNow(state) {
  const open = state.fixes.filter((f) => !f.done);
  if (!state.holds.length && !open.length) return ["Nothing is held by the age gate now.", ""];
  const more = (n, what) => (n > 10 ? [`- …and ${n - 10} more ${what}`] : []);
  return [
    "### Held now",
    "",
    ...state.holds.slice(0, 10).map((h) => `- Release ${inert(h.ref, 80)}, since ${when(h.first)}, by ${versions(h.pkgs, h.n)}.`),
    ...more(state.holds.length, "releases"),
    ...open.slice(0, 10).map((f) => `- Fix ${inert(f.pkg, 120)} for ${ids(f.adv)}, on ${replaced(f.rep)} since ${when(f.first)}${f.pub ? ` (published ${when(f.pub)})` : ""}; the fast lane ${outcome(f.code)}.`),
    ...more(open.length, "fixes"),
    "",
  ];
}

export const metricsTitle = (channel) => `[metrics] Age gate and fast lane (${channel})`;

/** The issue's text for `state`: compose's result (reconcile.mjs), the marker carrying the state. */
export function metricsBody(state, channel, { notes = null, minAgeDays = MIN_AGE_DAYS } = {}) {
  const t = state.totals;
  const refusals = Object.entries(t.refused).sort(([, a], [, b]) => b - a);
  const refused = refusals.reduce((sum, [, n]) => sum + n, 0);
  const open = state.fixes.filter((f) => !f.done).length;
  return compose({
    head: [
      `What the ${Math.round(minAgeDays * 24)}-hour dependency age gate costs on the ${channel} channel, measured on the evaluator's own runs${state.since ? ` since ${when(state.since)} (${plural(state.runs, "run")})` : " (none recorded yet)"}. The alerts job edits this in place and never comments, so it doesn't notify. The figures come from the evaluate job, which ran upstream code: they inform a choice of the gate's length and decide nothing.`,
      "",
      "| Measure | Value |",
      "| --- | --- |",
      `| Releases the age gate held, cleared | ${t.holds}${t.superseded ? ` (${t.superseded} superseded before passing)` : ""} |`,
      `| Hold, median / longest | ${median(t.holdHours)} / ${t.holds ? span(t.holdMaxMs) : "none yet"} |`,
      `| Releases held now | ${state.holds.length} |`,
      `| Security fixes held, admitted | ${t.fixes}: ${Object.entries(HOW_FIX).map(([how, label]) => `${t.how[how] ?? 0} ${label}`).join(", ")} |`,
      `| Days on a vulnerable version because of the gate | ${(t.fixMs / DAY).toFixed(1)}${t.fixes ? ` (longest ${span(t.fixMaxMs)})` : ""} |`,
      `| Security fixes held now | ${open} |`,
      `| Fast lane, admitted / refused | ${t.admitted} / ${refused} |`,
      `| Fast lane, publication to admission (median) | ${median(t.laneHours)} |`,
      `| Fast-lane refusals by reason | ${refusals.map(([c, n]) => `${REFUSALS[c]}: ${n}`).join(", ") || "none"} |`,
      ...(t.dropped ? [`| Tracked items dropped to fit GitHub's limit | ${t.dropped} |`] : []),
      "",
      ...heldNow(state),
      `### Recent events, newest first (the last ${EVENTS})`,
      "",
    ],
    units: state.events.length ? state.events.map(eventLine) : ["- None yet."],
    more: (n) => `- …and ${n} more, left out to fit; the totals count them.`,
    foot: [
      "",
      "Older events are counted in the totals. A hold runs from the first run that held a release to the first it passed the age gate in, or that no longer evaluated it (superseded). A held fix runs from the first run that met it to its admission: by the fast lane, an owner override (lib/overrides.json) or aging out. Runs are hourly, so times are to the hour. Device tool versions have their own review and aren't counted yet.",
      "Notes added above or below this text are kept; closing this issue starts the figures over.",
    ],
    meta: { kind: "metrics", channel, state },
    notes,
  });
}

/** The run's own figures and what it added, as Markdown for $GITHUB_STEP_SUMMARY. */
export function runSummary(channel, run, events, problems = []) {
  const lines = [`### Age gate metrics (${channel})`, ""];
  if (!run) lines.push("The evaluate job left no metrics this run (it failed, timed out or predates them). Held fixes that aged out or that an owner override took are still recorded.");
  else {
    lines.push(
      `Run at ${when(run.at)}, from ${run.pinned ? inert(run.pinned, 80) : "no pin"}: ${run.pinnedTo ? `pinned ${inert(run.pinnedTo, 80)}` : "nothing pinned"}. ${run.fastLane ? "The fast lane could run." : "The fast lane couldn't run (what the pinned release is exposed to wasn't known)."}`,
      "",
      ...(run.candidates.length ? [] : ["No candidate release was evaluated."]),
      ...run.candidates.map((c) => `- ${inert(c.ref, 80)}: ${c.young === null ? "the age gate couldn't tell" : c.young.n ? `held by the age gate: ${versions(c.young.pkgs, c.young.n)}` : "passed the age gate"}${c.held ? "; held" : "; passed every gate"}.`),
      "",
      ...(run.decisions.length ? ["Fast-lane decisions:", ...run.decisions.slice(0, 50).map((d) => `- ${outcome(d.code)} ${inert(d.pkg, 120)} for ${ids(d.adv)}${d.pub ? `, ${span(ms(run.at) - ms(d.pub))} after its publication` : ""}: ${inert(d.why, 160, "no reason given")}`)] : ["No fast-lane decisions."]),
    );
  }
  lines.push("", events === null ? "The metrics issue couldn't be brought up to date." : events.length ? "Recorded in the metrics issue:" : "Nothing new for the metrics issue.");
  if (events?.length) lines.push(...events.slice(0, 50).map(eventLine));
  if (problems.length) lines.push("", "Problems:", ...problems.map((p) => `- ${inert(p, 500)}`));
  return `${lines.join("\n")}\n`;
}

// -------------------------------------------------------------- issues ------

/**
 * Brings `channel`'s metrics issue up to date with `run` (readRun's, or null):
 * { state, events }. Only this automation's issues (reconcile.mjs ownedIssues).
 */
export async function reconcileMetrics({ channel, run, now = Date.now(), minAgeDays = MIN_AGE_DAYS, overrides = [] }, gh, { bot = BOT } = {}) {
  if (!CHANNELS.has(channel)) throw new Error(`unknown channel ${channel}`);
  const owned = ownedIssues(await gh.openIssues(), { bot }).filter((issue) => issue.meta.kind === "metrics" && issue.meta.channel === channel);
  const { fresh, legacy } = await sortOut(owned, gh, bot, { quietly: true });
  const { state, events } = mergeRun(readState(fresh?.meta.state), run, { channel, now, minAgeDays, overrides });
  const title = metricsTitle(channel);
  const { body } = metricsBody(state, channel, { notes: notesOf(fresh), minAgeDays });
  if (fresh) await rewrite(gh, fresh, title, body);
  else {
    await gh.ensureLabel("metrics", "C5DEF5", "Age gate and fast-lane figures; never notifies");
    await createOnce(gh, { title, labels: ["metrics"], body }, { kind: "metrics", channel }, bot);
  }
  for (const issue of legacy) await gh.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
  return { state, events };
}

/**
 * The alerts job's metrics step, which never throws: reads the run's metrics
 * (`runFile`, bin/t3 evaluate --metrics; none when the evaluation left none),
 * brings the issue up to date and appends the run's figures to `summaryFile`
 * ($GITHUB_STEP_SUMMARY). Returns { run, events, problems }: each problem is
 * for the caller to report, without failing the job.
 */
export async function metricsStep({ channel, runFile = null, summaryFile = null, overrides = () => [], now = Date.now() }, gh, { bot = BOT, log = console.log } = {}) {
  const problems = [];
  const message = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 500);
  let run = null;
  try {
    if (runFile && fs.existsSync(runFile)) {
      run = readRun(JSON.parse(fs.readFileSync(runFile, "utf8")), channel, now);
      if (!run) problems.push("the evaluation's metrics aren't in the shape bin/t3 evaluate writes; left out");
    } else log("the evaluate job left no metrics this run");
  } catch (error) {
    problems.push(`the evaluation's metrics couldn't be read: ${message(error)}`);
  }
  let events = null;
  try {
    let read = [];
    try {
      read = overrides();
    } catch (error) {
      problems.push(`lib/overrides.json couldn't be read, so no held fix counts as overridden this run: ${message(error)}`);
    }
    ({ events } = await reconcileMetrics({ channel, run, now, overrides: read }, gh, { bot }));
  } catch (error) {
    problems.push(`the metrics issue couldn't be brought up to date: ${message(error)}`);
  }
  if (summaryFile) {
    try {
      fs.appendFileSync(summaryFile, runSummary(channel, run, events, problems));
    } catch (error) {
      problems.push(`the step summary couldn't be written: ${message(error)}`);
    }
  }
  return { run, events, problems };
}
