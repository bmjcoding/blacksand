// Exact native lexical contexts, not package approval or a runtime egress claim.
// See docs/building/native-scan-contexts.md for source ownership and limits.
import { createHash } from "node:crypto";
import * as fs from "node:fs";

const CONTEXTS = JSON.parse(fs.readFileSync(new URL("./native-scan-contexts.json", import.meta.url), "utf8"));

/**
 * Scan text with only recorded benign occurrences masked, or the original text
 * when any identity differs. `identity` comes from fetchPackage's verified
 * registry tarball, never from the directory name or shipped package.json.
 * The full member hash binds every offset and context; nothing is written back.
 */
export function nativeScanText(bytes, member, identity) {
  const text = bytes.toString("latin1");
  const entry = identity && CONTEXTS.find((e) => e.name === identity.name && e.version === identity.version && e.integrity === identity.integrity && e.path === member);
  if (!entry || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return text;
  const spans = Object.entries(entry.matches).flatMap(([match, offsets]) => offsets.map((offset) => ({ match, offset })));
  // A bad table entry must retain the old detector's findings too.
  if (spans.some(({ match, offset }) => text.slice(offset, offset + match.length).toLowerCase() !== match)) return text;
  const masked = Buffer.from(bytes);
  for (const { match, offset } of spans) masked.fill(0x20, offset, offset + match.length);
  return masked.toString("latin1");
}
