// The bounds of a commit the evaluator signs. Its key runs unattended in CI
// (evaluate.yml), so it could be stolen; what it signs is only ever a proposal to
// move the pin forward, which each machine checks again (check.ts gates).

import { REGULAR } from "./git.ts";
import { addedApprovals, backwardMove, channelsOf, compareRefs, validatePin, type Pin } from "./pin.ts";

/** The current evaluator principal; historical parent lists keep their original label. */
export const EVALUATOR = "blacksand-evaluator";

/** Both exact labels stay pin-only across an owner-signed rename. Other listed principals are owners. */
export const isEvaluator = (principal: string | undefined): boolean => principal === EVALUATOR || principal === "t3blackout-evaluator";

export interface EvaluatorCommit {
  /** How many parents it has. */
  parents: number;
  /** The paths it changes over its first parent. */
  files: readonly string[];
  /** The pin file's repository path, in its first parent's layout. */
  pinFile: string;
  /** The pin file's text after it, and before it (in its first parent); null when absent. */
  after: string | null;
  before: string | null;
  /** The pin file's tree-entry modes, after and before (100644 a regular file, 120000 a symlink). */
  afterMode: string | null;
  beforeMode: string | null;
}

function parsePin(text: string | null): Pin {
  return validatePin(JSON.parse(text ?? "null"));
}

const why = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Why an evaluator-signed commit is out of bounds, or null when it only moves the
 * pin forward: one parent; the pin file and nothing else changed, and a regular
 * file before and after (a symlink's text is the name of what it points at, so a
 * checkout wouldn't read the pin verified here); a valid pin after it and before
 * it (the first pin, and a channel's first, have nothing trusted to be measured
 * against, so the owner signs those); no channel moved back or dropped, no
 * reviewed tool or lock removed; and a new tool approval only alongside a
 * channel moving forward.
 */
export function evaluatorShape({ parents, files, pinFile, after, before, afterMode, beforeMode }: EvaluatorCommit): string | null {
  if (parents !== 1) return "is a merge or a root commit";
  if (files.length !== 1 || files[0] !== pinFile) return `changes ${files.join(", ") || "nothing"}, not just ${pinFile}`;
  if (after !== null && afterMode !== REGULAR) return `makes ${pinFile} mode ${afterMode}; it must stay a regular file (${REGULAR})`;
  if (before !== null && beforeMode !== REGULAR) return `follows a ${pinFile} of mode ${beforeMode}, not a regular file (${REGULAR})`;
  let next: Pin;
  try {
    next = parsePin(after);
  } catch (error) {
    return `leaves ${why(error)}`;
  }
  if (before === null) return `creates ${pinFile}; its first version needs a commit you sign`;
  let previous: Pin;
  try {
    previous = parsePin(before);
  } catch (error) {
    return `follows an invalid ${pinFile} (${why(error)})`;
  }
  const backward = backwardMove(previous, next);
  if (backward) return backward;
  const added = channelsOf(next)
    .map(([channel]) => channel)
    .filter((channel) => !previous.channels[channel]);
  if (added.length) return `adds a ${added.join(", ")} pin; a channel's first pin needs a commit you sign`;
  const approved = [...addedApprovals(previous, next)];
  const moved = channelsOf(next).some(([channel, entry]) => compareRefs(entry.ref, previous.channels[channel]?.ref ?? "") > 0);
  if (approved.length && !moved) return `approves device tools ${approved.join(", ")} without moving a channel forward`;
  return null;
}
