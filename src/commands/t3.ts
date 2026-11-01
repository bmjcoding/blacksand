// blacksand t3 …: the t3 package's own CLI (packages/t3/bin/t3), with
// every argument after `t3` passed through, its own --json (event lines, not
// an envelope) included.

import { fileURLToPath } from "node:url";

import type { Command } from "../core/command.ts";
import { EXIT } from "../core/envelope.ts";

export const T3_CLI = fileURLToPath(new URL("../../packages/t3/bin/t3", import.meta.url));

export const t3: Command = {
  name: "t3",
  summary: "the T3 package's commands: update, check, drift, preview, rollback, evaluate, …",
  usage: "blacksand t3 <command> [options]",
  passthrough: true,
  async run(args, ctx) {
    const { status } = ctx.run(process.execPath, [T3_CLI, ...args]);
    return status ?? EXIT.refused;
  },
};
