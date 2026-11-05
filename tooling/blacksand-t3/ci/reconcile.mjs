// Turns the alert job's findings into GitHub issues, which email and push to the
// repo owner (.github/workflows/evaluate.yml, through security-issues.mjs). The
// owner's choice: GitHub notifies only for high, critical and unrated ratings
// (lib/advisories.mjs isAlerting; a malicious package is critical).
//   - one issue per channel and package with an alerting record, "[security]
//     <package> (<channel>)", open while a check finds one naming the package at
//     its pinned version. Its text lists every advisory id naming the package,
//     moderate and low ones included, each with its own source's link and rating.
//     Once a check that covered everything finds none alerting, it closes: "Fixed"
//     when nothing names the package, "No longer high or critical" (never
//     "Fixed") when moderate or low ones still do;
//   - what the owner was told about an issue is its record: the alerting (id,
//     rating) set as last announced, kept in the marker of the bot's latest
//     comment saying what changed (before any, the issue's own, from its opening
//     text). An alerting id new to the record, or rated differently, is a comment
//     saying so, which also names what no longer alerts; the record is then what
//     that comment leaves announced (all of it shown: the alerting set now).
//     Nothing goes on record that a received text didn't name. Before posting, the
//     issue's marker keeps the alerting pairs the comment is to name as `unsent`
//     (bounded), and they leave it only once a received text names them: a later
//     run names them, whatever its check covers. Each lifecycle comment is
//     numbered (`n`), so a lost response is never mistaken for the one before. A
//     closing comment empties the record, so a package that alerts
//     again after one (a close that failed, or an owner's reopen) is said again;
//   - each version an advisory names is labeled "ships in the app", "ships
//     (couldn't rule it out)" or "build tooling only", with the dependency path
//     that says so (lib/inventory.mjs shipsIn defines them; anything the report
//     doesn't say counts as shipping), and those that ship are listed first.
//     Labels only inform: they never change what opens, closes or notifies;
//   - packages named only by moderate and low advisories: one list, "[security]
//     Moderate and low advisories (<channel>)", redone each run and never
//     commented on (an edit doesn't notify); closed once a complete check finds
//     none;
//   - a check that couldn't cover everything (report.gaps) closes nothing and
//     leaves package issues' text as the last complete check left it, so it
//     drops nothing; it still opens issues and says what's new. What it
//     couldn't cover is one more issue, "[security] Advisory coverage incomplete
//     (<channel>)", until it can;
//   - "Upstream <channel> releases held": open while the evaluator holds every
//     newer release; closed once the commit job has pushed a pin that is now
//     main's, or upstream itself (read by the alert job) has nothing newer than
//     main's pin. The evaluate job's word never closes it: that job ran upstream code.
// Everything here is advisory: each Mac re-checks a pin itself before it
// installs it, so these issues say what the evaluator saw, not what was installed.
// Only issues this automation owns are touched: opened by the workflow's bot
// account and carrying its marker, a hidden line found wherever it is in the
// body (outside code blocks). Its own text runs from a hidden START line to the
// marker; notes added above or below are kept, whole, when it's redone, and
// where they leave it no room within GitHub's limit, the issue is left as it is
// and the run fails, naming it. An issue without the START line (an older
// version's) can't tell its text from notes, so it's never rewritten: a new
// issue takes over and it's closed as it was, a package's with a link to the
// new one (or, once a complete check finds nothing alerting, saying why).
// Text from outside (advisory ids, summaries and versions, the evaluate job's
// report: that job ran upstream code) goes in code spans and blocks, bounded, so
// it can't mention anyone, link anywhere or format the bot's issues; a text is
// made of whole rendered pieces that fit GitHub's limit, never cut.

import { createHash } from "node:crypto";

import { RANKED, isAlerting, rankOf } from "../lib/advisories.mjs";

export const BOT = "github-actions[bot]";
const CHANNELS = new Set(["nightly", "preview", "stable"]);
const ISSUE_KINDS = new Set(["package", "rolling", "coverage", "held"]);
/** The comments that tell the owner where a package issue stands: what changed, and why it closed. */
const LIFECYCLE = new Set(["notify", "fixed", "no-longer-alerting"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const CVE = /^CVE-\d{4}-\d{4,}$/;
const RUN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/;
const MARKER = /^<!-- blacksand (\{.*\}) -->[ \t]*$/;
/** The hidden line an issue's own text starts with: notes above it are kept, like those below its marker. */
const START = "<!-- blacksand text -->";
/** GitHub's limit on an issue's body or a comment, in characters. */
const LIMIT = 65_536;
const MAX_UNITS = 200;
/**
 * A record keeps each alerting pair as 16 hex characters of its id's SHA-256
 * and its rating's letter, at most SEEN_MAX of them (17,000 characters). Past
 * that, what isn't kept counts as never announced.
 */
const SEEN_MAX = 1000;
const LETTER = { UNKNOWN: "U", HIGH: "H", CRITICAL: "C" };
const RATING = { U: "UNKNOWN", H: "HIGH", C: "CRITICAL" };
const SEEN = /^(?:[0-9a-f]{16}[UHC])*$/;
/** A change comment names at most this many entries, and `unsent` keeps those that alert: a rating's letter and an id (ID's), each. */
const MAX_TOLD = 100;
const UNSENT = /^[UHC][A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** What a full `unsent` adds to a marker (MAX_TOLD entries of up to 101 characters, quoted): room a package issue's text keeps free for it. */
const UNSENT_ROOM = 10_500;

// ---------------------------------------------------------------- text ------

const oneLine = (text) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();

/**
 * Untrusted text as an inline code span: one line, at most `max` characters,
 * inert. Never an empty span (two backticks open one that runs into whatever
 * follows): blank text is `blank`, in a span of its own.
 */
export function code(text, max = 300, blank = "(empty)") {
  let s = oneLine(text) || blank;
  if (s.length > max) s = `${s.slice(0, max - 1)}…`;
  const fence = "`".repeat(Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}

/** Untrusted multi-line text as a fenced code block, at most `max` characters, inert. */
export function codeBlock(text, max = 40_000) {
  let s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd();
  if (s.length > max) s = `${s.slice(0, max)}\n… (${s.length - max} more characters in the run's artifact)`;
  const fence = "`".repeat(Math.max(2, ...[...s.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
  return `${fence}text\n${s}\n${fence}`;
}

/** A title from parts we chose; plain text on GitHub, but kept to one bounded line. */
const titleOf = (text) => oneLine(text).slice(0, 250);

/** The hidden marker naming what an issue or comment is, on a line of its own. */
export const markerOf = (meta) =>
  `<!-- blacksand ${JSON.stringify({ v: 1, ...meta }).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)} -->`;

/** `text`'s lines outside fenced code blocks, with their indexes (CommonMark: a fence closes on a run of its own character at least as long). */
function* outsideCode(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^[ \t]*$/.test(f[2])) fence = null;
    } else if (f && !(f[1][0] === "`" && f[2].includes("`"))) fence = f[1];
    else yield [i, lines[i], lines];
  }
}

/** The markers on `text`'s lines outside code blocks, parsed, in order. */
function* markersIn(text) {
  for (const [i, line, lines] of outsideCode(text)) {
    const match = MARKER.exec(line);
    if (!match) continue;
    try {
      const meta = JSON.parse(match[1]);
      if (meta?.v === 1) yield [meta, i, lines];
    } catch {}
  }
}

/** A record as markers keep it (`seen`), or "" for one that isn't. */
const seenOf = (meta) => (typeof meta?.seen === "string" && meta.seen.length <= SEEN_MAX * 17 && SEEN.test(meta.seen) ? meta.seen : "");

/** Alerting pairs as an issue's marker keeps them (`unsent`: a rating's letter and an id each), or none for a list that isn't. */
const unsentOf = (list) => (Array.isArray(list) && list.length <= MAX_TOLD && list.every((entry) => typeof entry === "string" && UNSENT.test(entry)) ? list : []);

/** (id, rating) pairs as `unsent`: one per id (the last rating given, the first place), those a marker can hold, at most MAX_TOLD (the first). */
function toUnsent(pairs) {
  const byId = new Map();
  for (const [id, rating] of pairs) byId.set(id, rating);
  return [...byId].map(([id, rating]) => `${LETTER[rating]}${id}`).filter((entry) => UNSENT.test(entry)).slice(0, MAX_TOLD);
}

/** An issue marker's meta as this file reads it (an older marker's kind, channel and package, nothing else it held), or null. */
function issueMeta(meta) {
  if (!ISSUE_KINDS.has(meta.kind) || !CHANNELS.has(meta.channel)) return null;
  if (meta.kind !== "package") return { kind: meta.kind, channel: meta.channel };
  if (typeof meta.package !== "string" || !meta.package || meta.package.length > 300) return null;
  const unsent = unsentOf(meta.unsent);
  return { kind: "package", channel: meta.channel, package: meta.package, seen: seenOf(meta), ...(unsent.length ? { unsent } : {}) };
}

/**
 * An issue body's marker, the first outside code blocks: { meta, notes,
 * remark(meta) (the body with that marker line alone rewritten) }, where notes
 * ({ before, after }: above its START line and below the marker) is null when
 * its text isn't delimited (no START line above the marker); null without one.
 */
export function readIssue(body) {
  for (const [found, i, lines] of markersIn(body)) {
    const meta = issueMeta(found);
    if (!meta) continue;
    const start = lines.slice(0, i).findIndex((line) => line.trimEnd() === START);
    return {
      meta,
      notes: start < 0 ? null : { before: lines.slice(0, start).join("\n"), after: lines.slice(i + 1).join("\n") },
      remark: (next) => [...lines.slice(0, i), markerOf(next), ...lines.slice(i + 1)].join("\n"),
    };
  }
  return null;
}

export const readMarker = (body) => readIssue(body)?.meta ?? null;

/** Whether `issue`'s body can be rewritten: its text is delimited (START, then its marker). */
const delimited = (issue) => Boolean(readIssue(issue?.body)?.notes);

/**
 * A text made of whole pieces: `head` and `foot` lines (ours, short), then as
 * many `units` (each rendered, inert) as fit `max` and GitHub's limit, with the
 * marker and an issue's `notes` counted, and `more(n)` for the n left out.
 * Nothing rendered is ever cut, and notes are never dropped: where they leave
 * no room, this throws. `meta` is the marker's, or a function of how many units
 * are shown giving it (no longer for fewer); `reserve`, characters kept free for
 * the marker to grow. Returns { body, meta, shown }.
 */
export function compose({ head = [], units = [], more = (n) => `- …and ${n} more`, foot = [], meta, notes = null, max = MAX_UNITS, reserve = 0 }) {
  const metaFor = typeof meta === "function" ? meta : () => meta;
  const above = notes?.before.trim() ? `${notes.before}\n` : "";
  const below = notes?.after.trim() ? `\n${notes.after}` : "";
  const start = ISSUE_KINDS.has(metaFor(0).kind) ? `${START}\n` : "";
  const render = (shown, marker) => `${above}${start}${[...head, ...units.slice(0, shown), ...(shown < units.length ? [more(units.length - shown)] : []), ...foot].join("\n")}\n\n${marker}${below}`;
  // Sized with the longest marker and the longest "more" line, so whatever is shown fits.
  let size = render(0, markerOf(metaFor(units.length))).length;
  if (size > LIMIT - reserve) throw new Error(`its notes (${above.length + below.length} characters) leave no room for its own text within GitHub's ${LIMIT}-character limit, so it's left as it is; shorten them`);
  let shown = 0;
  while (shown < Math.min(units.length, max) && size + units[shown].length + 1 <= LIMIT - reserve) size += units[shown++].length + 1;
  return { body: render(shown, markerOf(metaFor(shown))), meta: metaFor(shown), shown };
}

// ------------------------------------------------------------ advisories ----

const nameOf = (pkg) => pkg.slice(0, pkg.lastIndexOf("@"));
const rated = (severity) => RANKED[rankOf(severity)];
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The link for advisory id `id` in `a`, built here from the id and where it
 * came from (lib/advisories.mjs mergeAdvisories `origins`), never one from the
 * report: OSV's page for OSV's, GitHub's database page for its, a repository's
 * own advisory page (its validated owner/repo) for one only a repository
 * published, Electron's release for a runtime one; null otherwise.
 */
function linkFor(id, a) {
  const runtime = /^ELECTRON-RUNTIME-(\d+\.\d+\.\d+)$/.exec(id);
  if (runtime) return `https://github.com/electron/electron/releases/tag/v${runtime[1]}`;
  const origin = Array.isArray(a?.origins) ? a.origins.find((o) => o?.id === id) : null;
  if (!origin || !ID.test(id)) return null;
  if (origin.source === "osv") return `https://osv.dev/vulnerability/${encodeURIComponent(id)}`;
  if (!GHSA.test(id)) return null;
  if (origin.source === "github") return `https://github.com/advisories/${id}`;
  const repo = origin.repository;
  const valid = origin.source === "github-repository" && typeof repo === "string" && REPOSITORY.test(repo) && !repo.split("/").some((part) => /^\.+$/.test(part));
  return valid ? `https://github.com/${repo}/security/advisories/${id}` : null;
}

/** Advisory id `id` (of `a`) for Markdown: our own link to it when we know where it came from, else inert code. */
const idRef = (id, a) => {
  const link = linkFor(id, a);
  return link ? `[${id}](${link})` : code(id, 100);
};

/** What the record behind id `id` (of `a`) says it is: its own summary (`origins`), else the advisory's. */
const summaryOf = (id, a) => a?.origins?.find?.((o) => o?.id === id && typeof o.summary === "string" && o.summary.trim())?.summary ?? a?.summary;

/** One (id, rating) pair as every text here writes it: the rating, then the id. */
const pairText = (id, rating, a) => `**${rating}** ${idRef(id, a)}`;

/** Pairs in the order texts list them: the most alarming first, then by id. */
const listed = ([x, s], [y, t]) => rankOf(t) - rankOf(s) || byId(x, y);

/**
 * Where a version ships, as lib/inventory.mjs shipsIn says (the report's
 * `ships`): { rank (0 ships in the app, 1 couldn't be ruled out, 2 build
 * tooling only), label, text (why, with the path in code spans) }. Anything the
 * report doesn't say, or says in a way this can't read, counts as shipping.
 */
function shipsOf(p) {
  const how = typeof p?.ships?.how === "string" ? p.ships.how : null;
  const hops = Array.isArray(p?.ships?.via) ? p.ships.via.filter((hop) => typeof hop === "string").map((hop) => code(hop, 200)) : [];
  const shown = hops.length > 6 ? [...hops.slice(0, 4), "…", hops.at(-1)] : hops;
  const via = shown.length ? `, via ${shown.join(" ← ")}` : "";
  switch (how) {
    case "dependencies":
      return { rank: 0, label: SHIPS, text: `a packaged app depends on it${via}` };
    case "staged":
      return { rank: 0, label: SHIPS, text: "it's in the staged app's node_modules (app.asar)" };
    case "device-tool":
      return { rank: 0, label: SHIPS, text: `a device tool the app installs${hops.length ? `, or in the dependencies of one${via}` : ""}` };
    case "dev-dependencies":
      return { rank: 1, label: MAYBE, text: `a packaged app reaches it only through a devDependency, and a bundler takes whatever the code imports${via}` };
    case "unpackaged":
      return { rank: 2, label: TOOLING, text: `only projects that aren't packaged reach it${via}` };
    default:
      return { rank: 1, label: MAYBE, text: `the check couldn't trace it to the app or away from it${via}` };
  }
}

const SHIPS = "Ships in the app";
const MAYBE = "Ships (couldn't rule it out)";
const TOOLING = "Build tooling only";

/** An advisory entry's place in a list: the versions that ship first (shipsOf's rank, its versions' lowest). */
const shipsFirst = (e) => Math.min(...e.own.map((p) => shipsOf(p).rank));

/** A package's place in a list, and its label: its entries' lowest rank. */
const packageRank = (entry) => Math.min(...entry.entries.map(shipsFirst));

/** What the labels mean, for the foot of every text that uses them (the definition is lib/inventory.mjs shipsIn's). */
const SHIPS_DEFINED = [
  "Where each version ships, traced in the lockfile a build installs from and in what it installs besides:",
  `**${SHIPS}**: in the staged app's node_modules (app.asar), a device tool the app installs or in one's dependencies, or reached from apps/desktop, apps/server or apps/web through dependencies alone.`,
  `**${MAYBE}**: reached from those only through a devDependency (they're bundled, and a bundler takes whatever the code imports, whatever package.json calls it), or not traceable.`,
  `**${TOOLING}**: reached only from projects that aren't packaged (mobile, marketing, infra, scripts), by a check that covered everything a build installs.`,
];

/**
 * What names each package in `report`: Map name -> { pairs (Map id -> rating:
 * the id of every source record naming it, lib/advisories.mjs `records`, with
 * the most alarming rating any gives it; a runtime advisory's own id and
 * rating), alerting (those that alert), entries ([{ a, own, pairs }], one per
 * advisory, the most alarming first), of (Map id -> its advisory) }.
 */
export function packageFindings(report) {
  const out = new Map();
  for (const a of report.open) {
    for (const name of new Set(a.packages.map((p) => nameOf(p.pkg)))) {
      const own = a.packages.filter((p) => nameOf(p.pkg) === name).sort((x, y) => shipsOf(x).rank - shipsOf(y).rank);
      const pairs = new Map();
      for (const p of own) {
        const records = Array.isArray(p.records) ? p.records.filter((r) => typeof r?.id === "string" && r.id) : [];
        for (const r of records.length ? records : [{ id: a.id, severity: p.severity ?? a.severity }]) {
          if (!pairs.has(r.id) || rankOf(r.severity) > rankOf(pairs.get(r.id))) pairs.set(r.id, rated(r.severity));
        }
      }
      const entry = out.get(name) ?? { pairs: new Map(), entries: [], of: new Map() };
      for (const [id, rating] of pairs) {
        if (!entry.pairs.has(id) || rankOf(rating) > rankOf(entry.pairs.get(id))) entry.pairs.set(id, rating);
        entry.of.set(id, a);
      }
      entry.entries.push({ a, own, pairs: [...pairs].sort(listed) });
      out.set(name, entry);
    }
  }
  for (const entry of out.values()) {
    entry.entries.sort((x, y) => shipsFirst(x) - shipsFirst(y) || listed(x.pairs[0], y.pairs[0]) || byId(x.a.id, y.a.id));
    entry.alerting = new Map([...entry.pairs].filter(([, rating]) => isAlerting(rating)));
  }
  return out;
}

/** Advisory entry `e`'s lines in a package's issue (or, after `label`, the moderate and low list): its ids naming the package, each rated, its CVEs, its summary, and the versions. */
function unitFor({ a, own, pairs }, label = "") {
  const cves = (Array.isArray(a.aliases) ? a.aliases : []).filter((alias) => typeof alias === "string" && CVE.test(alias)).slice(0, 5);
  const fixes = (p) => (p.fixed.length ? p.fixed.slice(0, 5).map((v) => code(v, 40)).join(" / ") : "no fixed version yet");
  const where = (p) => `**${shipsOf(p).label}**: ${shipsOf(p).text}.`;
  return [
    `- ${label}${pairs.map(([id, rating]) => pairText(id, rating, a)).join(", ")}${cves.length ? ` (${cves.join(", ")})` : ""}: ${code(summaryOf(pairs[0][0], a), 300, "no summary")}`,
    ...own.slice(0, 10).map((p) => `  - ${code(p.pkg, 120)} → fixed in ${fixes(p)}. ${where(p)}`),
    ...(own.length > 10 ? [`  - and ${own.length - 10} more versions`] : []),
  ].join("\n");
}

const hashOf = (id) => createHash("sha256").update(id).digest("hex").slice(0, 16);

/** [hash, rating] entries as a marker's `seen`: one per hash (the first), at most SEEN_MAX (the first), sorted. */
const seenFrom = (entries) => {
  const kept = new Map();
  for (const [hash, rating] of entries) if (!kept.has(hash) && kept.size < SEEN_MAX && LETTER[rating]) kept.set(hash, rating);
  return [...kept].map(([hash, rating]) => `${hash}${LETTER[rating]}`).sort().join("");
};

/** A marker's `seen` read back: Map hash -> rating. */
const recordOf = (seen) => new Map((seen.match(/.{17}/g) ?? []).map((entry) => [entry.slice(0, 16), RATING[entry[16]]]));

/** Throws unless `report` is what `bin/t3 advisories` writes. */
export function readReport(report) {
  if (!report || typeof report !== "object" || !CHANNELS.has(report.channel) || typeof report.release !== "string" || !Array.isArray(report.open)) {
    throw new Error("not an advisory report from bin/t3 advisories");
  }
  if (!Array.isArray(report.gaps) || !report.gaps.every((gap) => typeof gap === "string")) throw new Error("the advisory report doesn't say what it couldn't cover (gaps)");
  for (const a of report.open) {
    const ok =
      typeof a?.id === "string" &&
      typeof a.severity === "string" &&
      Array.isArray(a.packages) &&
      a.packages.length > 0 &&
      a.packages.every((p) => typeof p?.pkg === "string" && p.pkg.length <= 300 && p.pkg.lastIndexOf("@") > 0 && Array.isArray(p.fixed) && p.fixed.every((v) => typeof v === "string"));
    if (!ok) throw new Error(`the advisory report has a malformed advisory ${code(a?.id, 60)}`);
  }
  return report;
}

// ---------------------------------------------------------------- issues ----

/** Open issues this automation owns (its bot opened them, and they carry its marker), each with its `meta`. */
export function ownedIssues(issues, { bot = BOT } = {}) {
  return issues
    .filter((issue) => issue.user?.login === bot && issue.user?.type === "Bot")
    .map((issue) => ({ ...issue, meta: readMarker(issue.body) }))
    .filter((issue) => issue.meta);
}

/** The marker of the bot's latest lifecycle comment on issue `number` (what the owner was last told), or null. */
async function lastWord(gh, number, bot) {
  const comments = await gh.comments(number);
  for (let i = comments.length - 1; i >= 0; i--) {
    if (comments[i].user?.login !== bot) continue;
    for (const [meta] of markersIn(comments[i].body)) if (LIFECYCLE.has(meta.kind)) return { kind: meta.kind, seen: seenOf(meta), n: Number.isSafeInteger(meta.n) && meta.n > 0 ? meta.n : 0 };
  }
  return null;
}

/**
 * Posts lifecycle comment `comment` (compose's result; its marker numbered `n`,
 * one past the latest's) on issue `number`. A request whose response was lost
 * counts as posted when the latest lifecycle comment is that one.
 */
async function say(gh, number, { body, meta }, bot) {
  const landed = async () => {
    const last = await lastWord(gh, number, bot);
    return last?.kind === meta.kind && last.n === meta.n ? last : null;
  };
  await gh.comment(number, body, { landed });
}

/** Posts `text` with `meta`'s marker, unless a comment with that marker is already there (a retried run, or a retried request). */
async function commentOnce(gh, number, meta, text, bot) {
  const marker = markerOf(meta);
  const landed = async () => (await gh.comments(number)).find((c) => c.user?.login === bot && [...outsideCode(c.body)].some(([, line]) => line.trimEnd() === marker)) ?? null;
  if (!(await landed())) await gh.comment(number, compose({ head: [text], meta }).body, { landed });
}

/** Opens an issue whose body carries `meta`'s marker; a retried request first looks for it by that marker (never an older, undelimited one's). */
function createOnce(gh, fields, meta, bot) {
  const same = (issue) => ["kind", "channel", "package"].every((key) => issue.meta[key] === meta[key]) && delimited(issue);
  const landed = async () => ownedIssues(await gh.openIssues(), { bot }).find(same) ?? null;
  return gh.createIssue(fields, { landed });
}

/** Closes `issues` (older, undelimited ones) for `by`, which takes over from them: a package issue's with a comment linking to it; any other kind's (`quietly`) with nothing said. */
async function supersede(issues, by, gh, bot, { quietly = false } = {}) {
  for (const issue of issues) {
    if (!quietly) await commentOnce(gh, issue.number, { kind: "superseded", by: by.number }, `Superseded by #${by.number}, which tracks this from now on; this issue is closed as it was.`, bot);
    await gh.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
  }
}

/** The oldest of `issues`, closing any others as its duplicates, with a link to it (`quietly`: with nothing said, for the list that's never commented on). */
async function keepOne(issues, gh, bot, { quietly = false } = {}) {
  const [kept, ...extra] = [...issues].sort((a, b) => a.number - b.number);
  for (const issue of extra) {
    if (!quietly) await commentOnce(gh, issue.number, { kind: "duplicate", of: kept.number }, `Closing as a duplicate of #${kept.number}, which tracks this.`, bot);
    await gh.updateIssue(issue.number, { state: "closed", state_reason: "not_planned" });
  }
  return kept ?? null;
}

/** `issues` (one kind's) as { fresh: the oldest delimited one, closing any others as its duplicates; legacy: the rest, never rewritten }. */
async function sortOut(issues, gh, bot, { quietly = false } = {}) {
  return { fresh: await keepOne(issues.filter(delimited), gh, bot, { quietly }), legacy: issues.filter((issue) => !delimited(issue)) };
}

/** Writes `body` and `title` to `issue` unless it reads so already (GitHub may hand a body back with CRLFs). */
async function rewrite(gh, issue, title, body) {
  if (String(issue.body ?? "").replace(/\r\n/g, "\n") !== body || issue.title !== title) await gh.updateIssue(issue.number, { title, body });
}

const notesOf = (issue) => readIssue(issue?.body)?.notes ?? null;

const groupBy = (items, key) => {
  const map = new Map();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
};

/**
 * Which advisory sources the check read ("OSV.dev, ..."; "" for a report that
 * doesn't say). Not when: that changes every run, and the issue would be edited
 * every hour for it; the run's log and report say.
 */
const checkedAgainst = (report) =>
  (Array.isArray(report.sources) ? report.sources : [])
    .filter((s) => typeof s?.source === "string")
    .slice(0, 5)
    .map((s) => (Array.isArray(s.repositories) && s.repositories.length ? `${code(s.source, 60)} (${s.repositories.slice(0, 10).map((r) => code(r, 100)).join(", ")})` : code(s.source, 60)))
    .join(", ");

/** The pin and the sources, for every advisory text. */
const pinned = (report) => [
  `Pinned ${report.channel} release on main: ${code(report.release, 80)}${typeof report.sha === "string" && /^[0-9a-f]{40}$/.test(report.sha) ? ` (\`${report.sha.slice(0, 10)}\`)` : ""}.`,
  ...(checkedAgainst(report) ? [`Checked against ${checkedAgainst(report)}.`] : []),
];

/** The line saying a list was cut to fit; reconcileAdvisories logs everything naming each package, and the run is linked when it's known. */
const cut = (report) => (n) => `- …and ${n} more advisories, left out to fit GitHub's limit; ${report.run ? `[this run's log](${report.run})` : "this run's log"} lists every one.`;

// -------------------------------------------------------- package issues ----

const rollingTitle = (channel) => `[security] Moderate and low advisories (${channel})`;

/** Package `name`'s issue text from this run's findings (`entry`): compose's result. */
const packageText = (report, name, entry, meta, notes, complete) =>
  compose({
    head: [
      `Where it ships: **${[SHIPS, MAYBE, TOOLING][packageRank(entry)]}** (each version below says why; the labels are defined at the end).`,
      "",
      `Advisories naming ${code(name, 120)} at its pinned ${report.channel} version, from every source the check read (${entry.pairs.size} advisory id${entry.pairs.size === 1 ? "" : "s"}), those that ship first:`,
      ...(complete ? [] : ["", "This check didn't cover everything (see the coverage issue): the next one that does brings this list up to date."]),
      "",
    ],
    units: entry.entries.map((e) => unitFor(e)),
    more: cut(report),
    foot: [
      "",
      ...pinned(report),
      "",
      "When an upstream release fixes this, the evaluator proposes it within the hour, skipping the dependency",
      "age gate for the fixing version if its publisher and provenance check out; each Mac re-checks the pin",
      "itself before installing it. If upstream has no fix, adding an override (lib/overrides.json) needs a",
      "commit you sign. This text is redone by each check that covers everything; notes added above or below it are kept.",
      "",
      ...SHIPS_DEFINED,
    ],
    meta,
    notes,
    reserve: UNSENT_ROOM,
  });

/**
 * A change comment's entries for a package (`entry`, null when nothing names
 * it), each with what it does to `record` once received (`set` [hash, rating],
 * `drop` [hashes]) and the alerting pair it names (`told`): first `owed` (an
 * earlier run's unsent pairs no received text named, that this run has no news
 * of: on record only when this check, which didn't cover everything, doesn't
 * name the id at all), then `news` (alerting pairs new to the record or rated anew),
 * then what's on record and no longer alerts: rated lower now, or no longer
 * named by a check that covered everything (one that didn't can't tell).
 */
function changeItems(entry, pairs, record, owed, news, complete) {
  const of = (id) => entry?.of.get(id);
  const line = (label, id, rating, tail = "") => `- ${label}${pairText(id, rating, of(id))}: ${code(summaryOf(id, of(id)), 300, "no summary")}${tail}`;
  const named = new Map([...pairs].map(([id, rating]) => [hashOf(id), [id, rating]]));
  const lower = [...record].filter(([hash]) => named.has(hash) && !isAlerting(named.get(hash)[1])).map(([hash, was]) => [...named.get(hash), was]).sort(listed);
  const gone = complete ? [...record.keys()].filter((hash) => !named.has(hash)) : [];
  return [
    ...owed.map(([id, rating]) => {
      const now = pairs.has(id) ? `rated ${pairs.get(id)} now` : complete ? "not named now" : null;
      return { text: `- Seen by an earlier check, whose comment didn't go out: ${pairText(id, rating, of(id))}${now ? ` (${now})` : ""}`, told: [id, rating], ...(now ? {} : { set: [hashOf(id), rating] }) };
    }),
    ...news.map(([id, rating]) => {
      const was = record.get(hashOf(id));
      return { text: line(was ? "Now " : "New: ", id, rating, was ? ` (was ${was})` : ""), told: [id, rating], set: [hashOf(id), rating] };
    }),
    ...lower.map(([id, rating, was]) => ({ text: line("Now ", id, rating, ` (was ${was})`), drop: [hashOf(id)] })),
    ...(gone.length ? [{ text: `- No longer named: ${gone.length} high, critical or unrated advisor${gone.length === 1 ? "y" : "ies"} this issue named before.`, drop: gone }] : []),
  ];
}

/** The comment saying what changed for package `name`: `items` (changeItems'). `again`: the latest comment said the issue closes. */
const changeText = (report, name, items, again, complete) => ({
  head: [
    again
      ? `${code(name, 120)} has high, critical or unrated advisories in ${code(report.release, 80)} again, after the comment above said this issue closes:`
      : `What names ${code(name, 120)} in ${code(report.release, 80)} changed:`,
    "",
  ],
  units: items.map((item) => item.text),
  more: cut(report),
  foot: ["", complete ? "The issue lists everything naming it now." : "This check didn't cover everything; the issue's list is brought up to date by the next one that does."],
});

/**
 * Brings package `name`'s issue in line with this run's findings (`entry`,
 * null when nothing names it); the whole rule set. `issue` is its delimited
 * issue; `legacy`, older ones, whose bodies are never rewritten: closed for
 * `issue`, or, without one, for a new one opened while something alerts (on a
 * check that covers everything and finds nothing alerting, closed saying why;
 * else left as they are). Returns "none", "opened", "changed" (and said so),
 * "kept" or "closed".
 */
async function reconcilePackage({ report, name, entry, issue, legacy, complete }, gh, bot) {
  const title = titleOf(`[security] ${name} (${report.channel})`);
  const pairs = entry?.pairs ?? new Map();
  const alerting = entry?.alerting ?? new Map();
  // Nothing alerting, by a check that covers everything: closed, saying why unless the latest word says so already.
  const close = async (target) => {
    const now = [...pairs].sort(listed);
    const [kind, text, reason] = !now.length
      ? ["fixed", `Fixed: ${code(report.release, 80)} no longer has any advisory for ${code(name, 120)} in any source.`, "completed"]
      : [
          "no-longer-alerting",
          `No longer high or critical: now rated ${[...new Set(now.map(([, rating]) => rating))].join(" and ")} (${now.slice(0, 10).map(([id]) => code(id, 100)).join(", ")}${now.length > 10 ? ` and ${now.length - 10} more` : ""}); tracked in the moderate/low issue, ${code(rollingTitle(report.channel), 80)}. ${code(name, 120)} in ${code(report.release, 80)} still has ${now.length === 1 ? "it" : "them"}: this isn't a fix. A new issue opens if one is rated high, critical or unrated again.`,
          "not_planned",
        ];
    const last = await lastWord(gh, target.number, bot);
    if (last?.kind !== kind) await say(gh, target.number, compose({ head: [text], meta: { kind, n: (last?.n ?? 0) + 1 } }), bot);
    await gh.updateIssue(target.number, { state: "closed", state_reason: reason });
    return "closed";
  };
  if (!issue) {
    const old = await keepOne(legacy, gh, bot);
    if (!alerting.size) return old && complete ? close(old) : old ? "kept" : "none";
    // Opening it is the notification: what alerts among the entries its text shows goes on record.
    const opened = (shown) => ({ kind: "package", channel: report.channel, package: name, seen: seenFrom(entry.entries.slice(0, shown).flatMap((e) => e.pairs).map(([id, rating]) => [hashOf(id), rating])) });
    const { body } = packageText(report, name, entry, opened, null, complete);
    const created = await createOnce(gh, { title, labels: ["security"], body }, { kind: "package", channel: report.channel, package: name }, bot);
    if (old) await supersede([old], created, gh, bot);
    return "opened";
  }
  if (legacy.length) await supersede(legacy, issue, gh, bot);
  if (!alerting.size && complete) return close(issue);
  const last = await lastWord(gh, issue.number, bot);
  const record = recordOf(last ? last.seen : issue.meta.seen);
  // What earlier runs were to say (`unsent`) that no received text has named (what's on record has been), and
  // what's new: said as it is now where this run has news of the id, else as the earlier check saw it.
  const pending = (issue.meta.unsent ?? []).map((entry) => [entry.slice(1), RATING[entry[0]]]).filter(([id, rating]) => record.get(hashOf(id)) !== rating);
  const news = [...alerting].filter(([id, rating]) => record.get(hashOf(id)) !== rating).sort(listed);
  const owed = pending.filter(([id]) => !news.some(([other]) => other === id));
  let body = issue.body;
  // The marker alone rewritten, keeping `unsent`.
  const mark = async (unsent) => {
    const next = readIssue(body).remark({ ...issue.meta, unsent: unsent.length ? unsent : undefined });
    if (next === body) return;
    if (next.length > LIMIT) throw new Error(`its notes leave no room for its marker within GitHub's ${LIMIT}-character limit, so it's left as it is; shorten them`);
    await gh.updateIssue(issue.number, { body: next });
    body = next;
  };
  let outcome = "kept";
  // What leaves `unsent`: the ids a received comment named.
  let said = new Set();
  if (owed.length || news.length) {
    const items = changeItems(entry, pairs, record, owed, news, complete);
    // The record once it's received: what was on record, as the entries shown change it. What alerts now is
    // kept first, should SEEN_MAX cut it: a full record changes only by a new rating.
    const current = new Set([...alerting.keys()].map(hashOf));
    const after = (shown) => {
      const next = new Map(record);
      for (const { set, drop = [] } of items.slice(0, shown)) {
        for (const hash of drop) next.delete(hash);
        if (set) next.set(...set);
      }
      return seenFrom([...next].sort(([x], [y]) => current.has(y) - current.has(x)));
    };
    const comment = compose({ ...changeText(report, name, items, last !== null && last.kind !== "notify", complete), max: MAX_TOLD, meta: (shown) => ({ kind: "notify", n: (last?.n ?? 0) + 1, seen: after(shown) }) });
    // One with nothing owed that wouldn't change a full record would be said again every run.
    if (owed.length || comment.meta.seen !== seenFrom(record)) {
      await mark(toUnsent([...pending, ...news]));
      await say(gh, issue.number, comment, bot);
      said = new Set(items.slice(0, comment.shown).flatMap(({ told }) => (told ? [told[0]] : [])));
      outcome = "changed";
    }
  }
  const unsent = toUnsent([...pending, ...news].filter(([id]) => !said.has(id)));
  if (complete) await rewrite(gh, { ...issue, body }, title, packageText(report, name, entry, { ...issue.meta, unsent: unsent.length ? unsent : undefined }, notesOf(issue), true).body);
  else await mark(unsent);
  return outcome;
}

/**
 * The one list of packages named only by moderate and low advisories, from
 * this run's findings: redone each run, never commented on (an edit doesn't
 * notify), closed once a complete check finds none. A check that didn't cover
 * everything says so in it, and never closes it. An older, undelimited list is
 * closed, with nothing said, once a new one takes over (or a complete check finds none).
 */
async function reconcileQuiet({ report, findings, issues, complete }, gh, bot) {
  const { channel } = report;
  const quiet = [...findings].filter(([, entry]) => !entry.alerting.size).sort(([x, e], [y, f]) => packageRank(e) - packageRank(f) || byId(x, y));
  const { fresh: rolling, legacy } = await sortOut(issues, gh, bot, { quietly: true });
  const title = rollingTitle(channel);
  if (quiet.length) {
    const ids = quiet.reduce((n, [, entry]) => n + entry.pairs.size, 0);
    const { body } = compose({
      head: [
        `Packages in the pinned ${channel} release named only by moderate or low advisories: ${quiet.length} package${quiet.length === 1 ? "" : "s"}, ${ids} advisory id${ids === 1 ? "" : "s"}. This list is redone each hour and never commented on; a package gets its own issue, which notifies, once an advisory naming it is rated high, critical or unrated. Those that ship in the app come first.`,
        ...(complete ? [] : ["", "This hour's check didn't cover everything (see the coverage issue): what it couldn't read may be missing here."]),
        "",
      ],
      units: quiet.flatMap(([name, entry]) => entry.entries.map((e) => unitFor(e, `${code(name, 120)}: `))),
      more: cut(report),
      foot: ["", ...pinned(report), "", "Notes added above or below this text are kept; the rest is redone each hour.", "", ...SHIPS_DEFINED],
      meta: { kind: "rolling", channel },
      notes: notesOf(rolling),
    });
    const list = rolling ?? (await createOnce(gh, { title, labels: ["security"], body }, { kind: "rolling", channel }, bot));
    if (rolling) await rewrite(gh, rolling, title, body);
    await supersede(legacy, list, gh, bot, { quietly: true });
  } else if (complete) {
    for (const issue of [...(rolling ? [rolling] : []), ...legacy]) await gh.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
  }
  return quiet.length;
}

/**
 * The issue saying what the check couldn't cover: edited in place, closed once
 * it covers everything. An older, undelimited one is closed, with nothing said,
 * once a new one takes over, or as it is once the check covers everything.
 */
async function reconcileCoverage({ report, owned, complete }, gh, bot) {
  const { channel } = report;
  const { fresh: coverage, legacy } = await sortOut(owned.filter((issue) => issue.meta.kind === "coverage"), gh, bot);
  const title = `[security] Advisory coverage incomplete (${channel})`;
  if (!complete) {
    const { body } = compose({
      head: [`The advisory check of the pinned ${channel} release couldn't cover everything a build of it installs, so advisories there may go unreported. Until it can, no package issue closes or has its list redone:`, ""],
      units: report.gaps.map((gap) => `- ${code(gap, 500)}`),
      foot: ["", `Pinned ${channel} release on main: ${code(report.release, 80)}. This issue is edited in place and closes itself once the check covers everything.`],
      meta: { kind: "coverage", channel },
      notes: notesOf(coverage),
    });
    const issue = coverage ?? (await createOnce(gh, { title, labels: ["security"], body }, { kind: "coverage", channel }, bot));
    if (coverage) await rewrite(gh, coverage, title, body);
    await supersede(legacy, issue, gh, bot, { quietly: true });
  } else {
    for (const issue of [...(coverage ? [coverage] : []), ...legacy]) {
      await commentOnce(gh, issue.number, { kind: "fixed", release: report.release }, `The check covers everything a build of ${code(report.release, 80)} installs again.`, bot);
      await gh.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
    }
  }
}

/**
 * Reconciles the channel's security issues with `report` (bin/t3
 * advisories, against the pin on main). `gh`: githubClient (github.mjs).
 * `run`: this run's page (security-issues.mjs), whose log lists everything.
 */
export async function reconcileAdvisories(input, gh, { bot = BOT, log = console.log, run = null } = {}) {
  const report = { ...readReport(input), run: typeof run === "string" && RUN.test(run) ? run : null };
  const { channel } = report;
  // What a part the check couldn't read may hold is unknown: nothing is closed on it.
  const complete = report.gaps.length === 0;
  await gh.ensureLabel("security", "B60205", "Advisory affecting the pinned release");
  const owned = ownedIssues(await gh.openIssues(), { bot }).filter((issue) => issue.meta.channel === channel);
  const findings = packageFindings(report);
  // Every advisory naming each package, whatever an issue has room for: what a cut list points at. One JSON
  // line each, so no line break or workflow command from outside text can start a line.
  for (const [name, entry] of [...findings].sort(([x], [y]) => byId(x, y))) log(`${channel}: ${JSON.stringify(name)} is named by ${JSON.stringify([...entry.pairs].sort(listed))}`);

  // Each part on its own: one that fails (a request GitHub refuses, a rate limit that outlasts the retries,
  // notes that leave no room) doesn't keep the others from being brought up to date; the run fails at the end.
  const failed = [];
  const apart = async (what, step) => {
    try {
      return await step();
    } catch (error) {
      failed.push(`${what}: ${error.message}`);
      return null;
    }
  };
  const packageIssues = groupBy(owned.filter((issue) => issue.meta.kind === "package"), (issue) => issue.meta.package);
  const did = { opened: 0, changed: 0, kept: 0, closed: 0, none: 0 };
  for (const name of [...new Set([...findings.keys(), ...packageIssues.keys()])].sort()) {
    const outcome = await apart(`package ${JSON.stringify(name)}`, async () => {
      const { fresh, legacy } = await sortOut(packageIssues.get(name) ?? [], gh, bot);
      return reconcilePackage({ report, name, entry: findings.get(name) ?? null, issue: fresh, legacy, complete }, gh, bot);
    });
    if (outcome) did[outcome]++;
  }
  const quiet = (await apart("the moderate and low list", () => reconcileQuiet({ report, findings, issues: owned.filter((issue) => issue.meta.kind === "rolling"), complete }, gh, bot))) ?? 0;
  await apart("the coverage issue", () => reconcileCoverage({ report, owned, complete }, gh, bot));
  log(`${channel}: ${findings.size - quiet} package(s) with high, critical or unrated advisories (issues ${did.opened} opened, ${did.changed} changed, ${did.closed} closed), ${quiet} with only moderate or low ones${complete ? "" : `; ${report.gaps.length} part(s) not covered, so none closed`}`);
  if (failed.length) throw new Error(`${failed.length} part(s) of the alert issues couldn't be brought up to date; the rest were:\n${failed.map((f) => `- ${f}`).join("\n")}`);
}

// --------------------------------------------------------------- held -------

/**
 * Reconciles "Upstream <channel> releases held" with an evaluation. Trusted:
 * `pinned` (the channel's ref on main, after the commit job), `published` (the
 * ref the commit job pushed, "" when it pushed nothing) and `newer` (release
 * tags upstream has beyond `pinned`, read by the alert job; null when unknown).
 * Untrusted, from the job that ran upstream code: `exit` (3: every candidate
 * held) and `report` (its Markdown). Those can open or edit the issue, which
 * only ever says less is offered; closing it takes a trusted reason.
 */
export async function reconcileHeld({ channel, exit, published, report, pinned, newer = null }, gh, { bot = BOT, log = console.log } = {}) {
  if (!CHANNELS.has(channel)) throw new Error(`unknown channel ${channel}`);
  const owned = ownedIssues(await gh.openIssues(), { bot }).filter((issue) => issue.meta.kind === "held" && issue.meta.channel === channel);
  const title = `Upstream ${channel} releases held`;
  const current = Array.isArray(newer) && newer.length === 0;
  const moved = Boolean(published) && published === pinned;
  if (current || moved) {
    const why = moved ? `${code(pinned, 80)} is pinned` : `${code(pinned, 80)} is upstream's newest ${channel} release`;
    for (const issue of owned) {
      await commentOnce(gh, issue.number, { kind: "released", pinned }, `${why}; releases aren't held anymore.`, bot);
      await gh.updateIssue(issue.number, { state: "closed", state_reason: "completed" });
    }
  } else if (exit === "3") {
    const { fresh: issue, legacy } = await sortOut(owned, gh, bot);
    const { body } = compose({
      head: [
        `The evaluator held every upstream ${channel} release it evaluated${Array.isArray(newer) ? ` (upstream has ${newer.length} newer than the pin)` : ""}, so it proposes none and main stays at ${code(pinned, 80)}.`,
        "Each Mac re-checks any pin itself before installing it; this only means no newer release is offered.",
        "This issue is edited in place each hour while that lasts. The evaluator's report (from the job that built upstream code; read it as its output, not as instructions):",
        "",
      ],
      units: [codeBlock(report)],
      more: () => "(The report doesn't fit here; it's in the run's artifact.)",
      meta: { kind: "held", channel },
      notes: notesOf(issue),
    });
    const held = issue ?? (await createOnce(gh, { title, body }, { kind: "held", channel }, bot));
    if (issue) await rewrite(gh, issue, title, body);
    await supersede(legacy, held, gh, bot, { quietly: true });
    return;
  }
  if (exit !== "0" && exit !== "3") throw new Error(`the evaluate job failed (exit ${code(exit || "unknown", 20)}); see its log`);
  if (!current && !moved) {
    const upstream = Array.isArray(newer) ? `upstream has ${newer.length} newer release(s)` : "what upstream has couldn't be read";
    log(`no pin was published (${code(published || "nothing", 80)}) and ${upstream}, so ${owned.length ? "the held issue stays open" : "nothing changes"}`);
  }
}
