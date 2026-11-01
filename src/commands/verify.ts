// blacksand verify: whether this machine runs what it should (blacksand.verify/1).
// Read-only, offline. Today it checks what it can: that this clone's HEAD is
// owner-signed code (src/trust: every commit signed by a key its parent's
// .allowed_signers lists, evaluator commits only moving the pin), and that the
// files on disk are that commit's. Comparing the machine with what apply last
// did needs a receipt, which nothing writes before apply exists, so it still
// refuses.

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { emit, usageError, type Command } from "../core/command.ts";
import { EXIT, SCHEMA, blacksandInfo, type Check, type VerifyEnvelope, type Warning } from "../core/envelope.ts";
import { checkHead, type HeadCheck } from "../trust/check.ts";
import { localGit } from "../trust/git.ts";

/** This clone: two folders above this file. */
const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** How many paths a check's text names. */
const SHOWN = 5;

const listed = (paths: readonly string[]) => `${paths.slice(0, SHOWN).join(", ")}${paths.length > SHOWN ? ", …" : ""}`;

/** The checks a HeadCheck makes, and the commit blacksand runs when they pass. */
export function trustChecks({ head, history, tree }: HeadCheck): { checks: Check[]; commit: string | null } {
  const taken = "commits" in history;
  const at = head ? head.slice(0, 10) : "";
  const gated = taken && history.bot.length ? `; ${history.bot.length} evaluator pin commit(s) since ${history.trusted.slice(0, 10)}, which blacksand t3 update gates before it builds` : "";
  const ignored = tree.outside.length ? ` (ignored, so outside the comparison: ${listed(tree.outside)})` : "";
  const checks: Check[] = [
    { id: "trust/history", ok: taken, text: taken ? `${at}: every commit is signed by a key its parent lists, evaluator commits only move the pin${gated}` : history.message },
    {
      id: "trust/working-tree",
      ok: head !== null && tree.refused === null && !tree.differs.length,
      text: tree.refused ?? (tree.differs.length ? `${tree.differs.length} path(s) differ from ${at}, so what runs here isn't only what was verified: ${listed(tree.differs)}` : `every file is ${at}'s${ignored}`),
    },
  ];
  return { checks, commit: checks.every((check) => check.ok) ? head : null };
}

const NO_RECEIPT: Warning = { code: "verify/no-receipt", text: "nothing has been applied on this machine yet, so there's no receipt to compare it with" };

export const verify: Command = {
  name: "verify",
  summary: "check this machine against what was last applied",
  usage: "blacksand verify [--json]",
  async run(args, ctx) {
    if (args.length) return usageError(ctx, `usage: ${this.usage}`);
    const { checks, commit } = trustChecks((ctx.headCheck ?? (() => checkHead(localGit(ROOT))))());
    // No receipt yet: whatever the checks say, the machine itself isn't verified.
    const envelope: VerifyEnvelope = { schema: SCHEMA.verify, blacksand: { ...blacksandInfo(), commit }, result: "refused", checks, warnings: [NO_RECEIPT] };
    const text = [...checks.map((check) => `${check.ok ? "ok  " : "FAIL"} ${check.id}: ${check.text}`), `not verified: ${NO_RECEIPT.text}`].join("\n");
    return emit(ctx, envelope, text, EXIT.refused);
  },
};
