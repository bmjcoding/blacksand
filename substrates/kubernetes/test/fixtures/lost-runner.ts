// A runner that the native test kills mid-run: it starts one run, with a
// short lifetime, and is SIGKILLed once its Sandbox exists, so nothing of
// its own teardown runs.
//   node lost-runner.ts SPEC.json   (BLACKSAND_KUBECTL as for the CLI)

import * as fs from "node:fs";

import { processRunDeps, runOnce, type RunSpec } from "../../src/run.ts";
import { labKubectl } from "./lab.ts";

const spec = JSON.parse(fs.readFileSync(process.argv[2] ?? "", "utf8")) as RunSpec;
await runOnce(spec, processRunDeps(labKubectl(), (text) => process.stderr.write(`${text}\n`)));
