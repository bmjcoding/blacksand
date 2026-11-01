// A runner process for the receipt tests: one command run under a key,
// against its own scripted cluster, so several can race for one receipt.
//   node receipt-runner.ts SPEC.json EXPORT.tar race START_AT_MS   waits for START_AT_MS, then runs;
//                                                                 prints {outcome, run, code}
//   node receipt-runner.ts SPEC.json EXPORT.tar crash              SIGKILLs itself at its first create,
//                                                                 after the claim and before any record
// SPEC.json is a RunSpec with each input file as base64.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

import { ReceiptError } from "../../src/receipt.ts";
import { hostBundle, runOnce, type RunSpec } from "../../src/run.ts";
import { fakeCluster } from "../fake-cluster.ts";

const [specFile = "", exportTar = "", mode, startAt] = process.argv.slice(2);
const raw = JSON.parse(fs.readFileSync(specFile, "utf8")) as RunSpec & { command: { inputs: Record<string, string> } };
const spec: RunSpec = { ...raw, command: { argv: raw.command.argv, inputs: Object.fromEntries(Object.entries(raw.command.inputs).map(([name, data]) => [name, Buffer.from(data, "base64")])) } };
const cluster = fakeCluster("", exportTar);

while (mode === "race" && Date.now() < Number(startAt)); // every racer starts its claim at the same moment

let created = false;
const kubectl: typeof cluster.kubectl = async (args, options) => {
  if (args[0] === "create") {
    if (mode === "crash") process.kill(process.pid, "SIGKILL");
    created = true;
  }
  // Slow enough that the other racers arrive while the winner's claim has no record yet.
  if (args[0] === "version") await new Promise((resolve) => setTimeout(resolve, 300));
  return cluster.kubectl(args, options);
};

try {
  const record = await runOnce(spec, { kubectl, now: () => Date.now(), randomHex: (bytes) => randomBytes(bytes).toString("hex"), bundle: hostBundle, progress: () => {}, sleep: async () => {} });
  process.stdout.write(JSON.stringify({ outcome: created ? "launched" : "answered", run: record.run.id }));
} catch (error) {
  if (!(error instanceof ReceiptError)) throw error;
  process.stdout.write(JSON.stringify({ outcome: "refused", code: error.code }));
}
