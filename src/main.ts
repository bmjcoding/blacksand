// Entry point: ./blacksand runs this with Node, which strips the types, and a
// single binary (tools/build-sea.ts) starts here too.
//
// Root is refused before any command's module loads: until apply installs a
// root-owned blacksand, root must never run code its user can replace. The
// commands come in by a dynamic import, after the check, because a static
// import's modules run before any line of this file does. ./blacksand checks
// too, before it starts Node.

import { EXIT, errorEnvelope } from "./core/envelope.ts";

/** Prints `text` as --json asked: an error envelope, or a line on stderr. */
function fail(code: string, text: string) {
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(errorEnvelope(code, text), null, 2)}\n`);
  else process.stderr.write(`blacksand: ${text}\n`);
  process.exitCode = EXIT.refused;
}

if (process.getuid?.() === 0 || process.geteuid?.() === 0) {
  fail("root", "refusing to run as root until a root-owned blacksand is installed");
} else {
  try {
    const { runCli } = await import("./cli.ts");
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    fail("failed", error instanceof Error ? error.message : String(error));
  }
}
