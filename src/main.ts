// Entry point: ./blacksand runs this with Node, which strips the types.

import { runCli } from "./cli.ts";
import { EXIT, errorEnvelope } from "./core/envelope.ts";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  const text = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(errorEnvelope("failed", text), null, 2)}\n`);
  else process.stderr.write(`blacksand: ${text}\n`);
  process.exitCode = EXIT.refused;
}
