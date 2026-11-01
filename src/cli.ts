// blacksand's command line: global options, then a command and its arguments.
//   blacksand [--json] <command> [args]    blacksand help [command]    blacksand <command> --help
// --json and --help may also follow the command, except for a package's own CLI
// (`blacksand t3 …`), which gets everything after its name untouched.

import { COMMANDS } from "./commands/index.ts";
import { processContext, usageError, type Command, type Context } from "./core/command.ts";
import { EXIT, SCHEMA, blacksandInfo, type HelpEnvelope } from "./core/envelope.ts";

const GLOBAL = new Set(["--json", "--help", "-h"]);

function helpText(commands: readonly Command[]): string {
  const width = Math.max(...commands.map((c) => c.name.length));
  return [
    "usage: blacksand [--json] <command> [args]",
    "",
    ...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    "blacksand help <command>, or blacksand <command> --help, for its usage.",
    "Exit codes: 0 passed, 1 drift, 2 usage, 3 held, 4 refused.",
  ].join("\n");
}

function help(ctx: Context, command: Command | undefined): number {
  const listed = command ? [command] : COMMANDS;
  const envelope: HelpEnvelope = { schema: SCHEMA.help, blacksand: blacksandInfo(), commands: listed.map(({ name, summary, usage }) => ({ name, summary, usage })) };
  const text = command ? `usage: ${command.usage}\n\n${command.summary}` : helpText(COMMANDS);
  ctx.io.out(ctx.json ? `${JSON.stringify(envelope, null, 2)}\n` : `${text}\n`);
  return EXIT.ok;
}

/** Runs one command line; returns its exit code. `contextFor`: what commands are given (tests pass fakes). */
export async function runCli(argv: readonly string[], contextFor: (json: boolean) => Context = processContext): Promise<number> {
  let at = 0;
  while (at < argv.length && GLOBAL.has(argv[at] ?? "")) at++;
  const leading = argv.slice(0, at);
  let name = argv[at];
  let rest = argv.slice(at + 1);
  let wantsHelp = leading.includes("--help") || leading.includes("-h");
  if (name === "help") {
    wantsHelp = true;
    name = rest[0];
    rest = rest.slice(1);
  }
  const command = COMMANDS.find((c) => c.name === name);
  // An unknown command still honours a trailing --json, so its error comes back as JSON.
  if (!command && rest.includes("--json")) leading.push("--json");
  if (command && !command.passthrough) {
    wantsHelp ||= rest.includes("--help") || rest.includes("-h");
    if (rest.includes("--json")) leading.push("--json");
    rest = rest.filter((arg) => !GLOBAL.has(arg));
  }
  const ctx = contextFor(leading.includes("--json"));
  if (name !== undefined && !command) return usageError(ctx, `${name.startsWith("-") ? "unknown option" : "unknown command"} ${name} (blacksand help lists the commands)`);
  if (wantsHelp) return help(ctx, command);
  if (!command) return usageError(ctx, `no command given\n${helpText(COMMANDS)}`);
  if (command.passthrough && leading.length) return usageError(ctx, `put options for blacksand ${command.name} after its name: blacksand ${command.name} ${leading.join(" ")} …`);
  return command.run(rest, ctx);
}
