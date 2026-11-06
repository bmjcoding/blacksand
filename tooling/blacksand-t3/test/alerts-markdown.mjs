// What the alert job writes to GitHub issues (ci/reconcile.mjs), read
// with a real CommonMark and GitHub Flavored Markdown parser (marked 15.0.12,
// vendored under test/vendor/marked), not with patterns. GitHub renders links,
// autolinks, images, HTML, link definitions, mentions and formatting from that
// tree, so the checks look for them there, outside code.
import { Lexer } from "./vendor/marked/marked.esm.js";

/** The links the alert job builds itself, from an advisory id and its source. */
const OUR_LINKS = [
  /^https:\/\/osv\.dev\/vulnerability\/[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/,
  /^https:\/\/github\.com\/advisories\/GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/,
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/security\/advisories\/GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/,
  /^https:\/\/github\.com\/electron\/electron\/releases\/tag\/v\d+\.\d+\.\d+$/,
  // This run's page, where its log lists what a cut list leaves out.
  /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/,
];
const RATINGS = new Set(["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"]);
/** Where a version ships, as the alert job labels it (ci/reconcile.mjs shipsOf): our words, bold like a rating. */
export const SHIPS_LABELS = new Set(["Ships in the app", "Ships (couldn't rule it out)", "Build tooling only"]);
/** The automation's hidden lines: an issue's or comment's marker, and the line an issue's own text starts with. */
const MARKER_BLOCK = /^<!-- blacksand (\{[^\n]*\}|text) -->\n*$/;

export const parse = (markdown) => new Lexer({ gfm: true }).lex(markdown);

/** Every token of `markdown`, with the types of the tokens it sits in. */
function tokensOf(markdown) {
  const out = [];
  const visit = (tokens, path) => {
    for (const t of tokens ?? []) {
      out.push({ t, path });
      const inner = [...(t.tokens ?? []), ...(t.items ?? []), ...(t.header ?? []).flatMap((cell) => cell.tokens ?? []), ...(t.rows ?? []).flat().flatMap((cell) => cell.tokens ?? [])];
      visit(inner, [...path, t.type]);
    }
  };
  visit(parse(markdown), []);
  return out;
}

/**
 * Why `markdown` isn't inert, as a list (empty: it is). Outside code spans
 * and blocks, there must be no link but ours, no image, HTML (but the
 * automation's own hidden lines, blocks of their own), link definition, mention, or
 * any formatting but **RATING** and a **ships label**; and `canary`, a string planted in every value
 * from outside, appears only inside code. `codeBlocks`: a fenced block is
 * expected (the held issue's report). `layout`: our headings and tables are
 * expected (the metrics issue's); what's in them is held to the same rules.
 */
export function problems(markdown, { canary = null, codeBlocks = false, issueRefs = false, layout = false } = {}) {
  const found = [];
  const leaf = (s) => typeof s === "string" && canary && s.includes(canary);
  for (const { t, path } of tokensOf(markdown)) {
    switch (t.type) {
      case "codespan":
        break;
      case "code":
        if (!codeBlocks || t.codeBlockStyle === "indented") found.push(`a code block: ${JSON.stringify(t.raw.slice(0, 80))}`);
        break;
      case "link":
        if (!OUR_LINKS.some((ours) => ours.test(t.href))) found.push(`a link to ${t.href}`);
        if (leaf(t.href) || leaf(t.title)) found.push(`outside text in a link: ${t.href}`);
        break;
      case "html":
        if (!MARKER_BLOCK.test(t.raw) || path.length) found.push(`HTML: ${JSON.stringify(t.raw.slice(0, 80))}`);
        break;
      case "strong":
        if (!(t.tokens?.length === 1 && t.tokens[0].type === "text" && (RATINGS.has(t.tokens[0].text) || SHIPS_LABELS.has(t.tokens[0].text.replace(/&#39;/g, "'"))))) found.push(`bold text: ${JSON.stringify(t.raw.slice(0, 80))}`);
        break;
      case "text":
        if (t.tokens?.length) break; // its children are looked at
        if (leaf(t.text)) found.push(`outside text as Markdown: ${JSON.stringify(t.text.slice(0, 120))}`);
        if (/(^|[^\w`])@[A-Za-z0-9]/.test(t.text)) found.push(`a mention: ${JSON.stringify(t.text.slice(0, 120))}`);
        if (!issueRefs && /(^|\W)#\d/.test(t.text)) found.push(`an issue reference: ${JSON.stringify(t.text.slice(0, 120))}`);
        break;
      case "heading":
      case "table":
        if (!layout) found.push(`${t.type}: ${JSON.stringify(String(t.raw).slice(0, 80))}`);
        break;
      case "paragraph":
      case "list":
      case "list_item":
      case "space":
        break;
      default:
        // image, tag (inline HTML), def, escape, em, del, br, heading, table, blockquote, hr, ...
        found.push(`${t.type}: ${JSON.stringify(String(t.raw).slice(0, 80))}`);
    }
  }
  return found;
}

/**
 * The (advisory id, rating) pairs `markdown` states, read from the parsed
 * tree: each **RATING** followed by a space and an id, linked or in code.
 * Map id -> rating.
 */
export function statedPairs(markdown) {
  const pairs = new Map();
  for (const { t } of tokensOf(markdown)) pairsIn(t.tokens ?? [], pairs);
  return pairs;
}

/**
 * The pairs among sibling inline tokens `kids`, into `pairs`. marked leaves a
 * `**RATING**` that follows a code span with a backtick in it as text (", **LOW** "),
 * so a text token ending that way counts too.
 */
function pairsIn(kids, pairs = new Map()) {
  for (let i = 0; i + 1 < kids.length; i++) {
    const [rating, gap, id] = kids.slice(i, i + 3);
    const strong = rating.type === "strong" && rating.tokens?.length === 1 && RATINGS.has(rating.tokens[0].text) && gap?.type === "text" && gap.text === " " ? rating.tokens[0].text : null;
    const plain = rating.type === "text" ? /\*\*([A-Z]+)\*\* $/.exec(rating.text)?.[1] : null;
    const [said, target] = strong ? [strong, id] : RATINGS.has(plain) ? [plain, gap] : [null, null];
    const text = target?.type === "link" || target?.type === "codespan" ? target.text : null;
    if (said && text !== null) pairs.set(text, said);
  }
  return pairs;
}

/**
 * The moderate and low list's entries, read from the parsed tree: each
 * top-level item starting with a package in code, then ": " and its pairs.
 * Map package -> Map id -> rating.
 */
export function listedPackages(markdown) {
  const out = new Map();
  for (const t of parse(markdown).filter((t) => t.type === "list")) {
    for (const item of t.items) {
      const inline = item.tokens?.[0]?.tokens ?? [];
      if (inline[0]?.type !== "codespan" || inline[1]?.type !== "text" || inline[1].text !== ": ") continue;
      out.set(inline[0].text, pairsIn(inline, out.get(inline[0].text) ?? new Map()));
    }
  }
  return out;
}
