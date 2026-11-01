// blacksand t3 …: the t3 package's own CLI (tooling/t3code/bin/t3), with
// every argument after `t3` passed through, its own --json (event lines, not
// an envelope) included. It runs from a clone (the package keeps its state
// there and builds with Node), so a single binary refuses it.

import { isSea } from "node:sea";
import { fileURLToPath } from "node:url";

import type { Command } from "../core/command.ts";
import { EXIT } from "../core/envelope.ts";

export const T3_CLI = fileURLToPath(new URL("../../tooling/t3code/bin/t3", import.meta.url));

export const t3: Command = {
  name: "t3",
  summary: "the T3 package's commands: update, check, drift, preview, rollback, evaluate, …",
  usage: "blacksand t3 <command> [options]",
  passthrough: true,
  async run(args, ctx) {
    // In a single binary, process.execPath is blacksand itself, not Node, and there's no tooling/t3code beside it.
    if (isSea()) {
      ctx.io.err("blacksand: blacksand t3 runs from a clone of the repository (its ./blacksand), not from this single binary\n");
      return EXIT.refused;
    }
    const { status } = ctx.run(process.execPath, [T3_CLI, ...args]);
    return status ?? EXIT.refused;
  },
};
