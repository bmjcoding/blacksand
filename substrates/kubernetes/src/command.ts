// blacksand k8s: the Kubernetes substrate's commands.
//   blacksand k8s node-setup   (prints the root script that installs the egress floor on a k3s node)
//   blacksand k8s setup        (an admin, once per cluster, on its runner; also deletes expired runs and provisions the receipts root)
//   blacksand k8s run …        (one task in a fresh Sandbox; prints its blacksand.run/1 record with --json)
//   blacksand k8s status --key K   (the key's receipt: completed, claimed or unclaimed)

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import { usageError, type Command, type Context } from "../../../src/core/command.ts";
import { EXIT, errorEnvelope } from "../../../src/core/envelope.ts";
import { agentNamed } from "./agents.ts";
import { kubectlPrefix, must, processKubectl } from "./kubectl.ts";
import { list, setupObjects } from "./manifests.ts";
import { FLOOR_ID, nodeSetupScript } from "./node.ts";
import { DEFAULT_LIMITS, parseAllow, parseRoute } from "./policy.ts";
import { provisionReceipts, ReceiptError, receiptDir, receiptsRoot, receiptStatus } from "./receipt.ts";
import { MAX_MODEL_REQUESTS, processRunDeps, reconcile, runOnce, type RunSpec } from "./run.ts";

/** Images pinned by digest (multi-arch indexes). Node 24.22.2: bookworm has git for the agent; alpine is enough for the proxy. */
export const IMAGES = {
  agent: "docker.io/library/node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413",
  proxy: "docker.io/library/node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85",
} as const;

const USAGE = [
  "blacksand k8s node-setup",
  "blacksand k8s setup [--receipts DIR]",
  "blacksand k8s run --repo PATH|URL (--prompt TEXT | --prompt-file FILE) --agent fake|claude|codex [--model ID]",
  "    --route KIND=URL@SECRET [--grant-model ID …] [--allow HOST:PORT …] [--allow-private HOST:PORT …] (--out DIR | --key KEY)",
  "    [--image IMAGE@sha256:…] [--tools-image IMAGE@sha256:…] [--proxy-image IMAGE@sha256:…] [--timeout SECONDS]",
  "    [--max-model-requests N] [--receipts DIR] [--replay-only] [--json]",
  "blacksand k8s run --agent command --argv JSON [--input PATH=FILE …] [--route KIND=URL@SECRET --model ID [--grant-model ID …]]",
  "    [--allow HOST:PORT …] (--out DIR | --key KEY) [--image IMAGE@sha256:…] [--timeout SECONDS] [--receipts DIR] [--replay-only] [--json]",
  "blacksand k8s status --key KEY [--receipts DIR] [--json]",
  "  defaults: codex gpt-6.1-sol, claude claude-sonnet-5-5, both at medium effort; fake needs --model; --max-model-requests 2000.",
  "  --key KEY: the output directory is KEY's receipt under --receipts (default $BLACKSAND_RECEIPTS, else",
  "    $XDG_STATE_HOME/blacksand/k8s-receipts); the same key never launches twice. One runner per cluster.",
  "  --replay-only: requires --key; read a matching completed receipt, never claim or launch a run.",
].join("\n");

const kubectl = () => processKubectl(kubectlPrefix(process.env.BLACKSAND_KUBECTL));

async function setup(args: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { receipts: { type: "string" } } });
  // The receipts root, made durably once here: a run never creates it.
  const receipts = provisionReceipts(values.receipts ?? receiptsRoot());
  const k = kubectl();
  const objects = setupObjects();
  await must(k, ["apply", "-f", "-"], { stdin: JSON.stringify(list(objects)) });
  const reconciled = await reconcile(k, Date.now());
  const applied = objects.map((o) => `${String(o.kind)}/${String((o.metadata as { name: string }).name)}`);
  const report = [
    `applied ${applied.length} objects for egress floor ${FLOOR_ID}; deleted ${reconciled.deleted.length} expired run(s); receipts root ${receipts}`,
    ...reconciled.undated.map((id) => `left alone, no deadline recorded: run ${id}`),
    ...reconciled.foreign.map((o) => `left alone, not created by blacksand: ${o}`),
  ];
  ctx.io.out(ctx.json ? `${JSON.stringify({ applied, floor: FLOOR_ID, reconciled, receipts }, null, 2)}\n` : `${report.join("\n")}\n`);
  return EXIT.ok;
}

function usage(ctx: Context): number {
  ctx.io.err(`usage:\n${USAGE}\n`);
  return EXIT.usage;
}

/** A command's argv, given as one JSON list of strings, so no argument is ever split, and none can be taken for one of blacksand's options. */
function parseArgv(text: string): string[] | null {
  try {
    const argv: unknown = JSON.parse(text);
    return Array.isArray(argv) && argv.length && argv.every((a) => typeof a === "string") ? (argv as string[]) : null;
  } catch {
    return null;
  }
}

/** `--input PATH=FILE …` as input files by path, read now. A map with no prototype, so every name (`__proto__` included) is an entry. */
function parseInputs(values: readonly string[]): Record<string, Buffer> | string {
  const inputs: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  for (const value of values) {
    const at = value.indexOf("=");
    const name = value.slice(0, at);
    if (at < 1 || !value.slice(at + 1)) return `--input ${JSON.stringify(value)}: needs PATH=FILE`;
    if (Object.hasOwn(inputs, name)) return `--input ${name} is given twice`;
    inputs[name] = fs.readFileSync(value.slice(at + 1));
  }
  return inputs;
}

/** `k8s run`'s arguments as a RunSpec, or the usage error to print (null: just the usage). Touches no cluster. */
export function runSpec(args: readonly string[], env: NodeJS.ProcessEnv = process.env): RunSpec | { error: string | null } {
  const { values } = parseArgs({
    args: [...args],
    options: {
      repo: { type: "string" },
      prompt: { type: "string" },
      "prompt-file": { type: "string" },
      agent: { type: "string" },
      model: { type: "string" },
      route: { type: "string", multiple: true, default: [] },
      allow: { type: "string", multiple: true, default: [] },
      "allow-private": { type: "string", multiple: true, default: [] },
      out: { type: "string" },
      image: { type: "string" },
      "tools-image": { type: "string" },
      "proxy-image": { type: "string", default: IMAGES.proxy },
      "grant-model": { type: "string", multiple: true, default: [] },
      "max-model-requests": { type: "string", default: String(DEFAULT_LIMITS.requests_total) },
      timeout: { type: "string", default: "1800" },
      key: { type: "string" },
      "replay-only": { type: "boolean" },
      receipts: { type: "string" },
      argv: { type: "string" },
      input: { type: "string", multiple: true, default: [] },
      "fake-denied": { type: "string", default: "example.org:443" },
      "fake-direct": { type: "string", multiple: true, default: ["1.1.1.1:443"] },
    },
  });
  const { repo, agent: agentName, key } = values;
  if (values["replay-only"] && key === undefined) return { error: "--replay-only needs --key" };
  if (values.out !== undefined && key !== undefined) return { error: "--key names the run's output directory (its receipt): give --key or --out, not both" };
  if (!agentName || (values.out === undefined && key === undefined)) return { error: null };
  if (values.receipts !== undefined && key === undefined) return { error: "--receipts needs --key" };
  const out = key !== undefined ? receiptDir(values.receipts ?? receiptsRoot(env), key) : (values.out as string);
  const agent = agentNamed(agentName);
  const isCommand = agent.name === "command";
  const argv = values.argv === undefined ? null : parseArgv(values.argv);
  if (isCommand) {
    if (repo !== undefined || values.prompt !== undefined || values["prompt-file"] !== undefined) return { error: "--agent command takes --argv and --input, not --repo or a prompt" };
    if (!argv) return { error: "--agent command needs --argv, a JSON list of one or more strings" };
    if (values.route.length > 1) return { error: "--agent command takes at most one --route" };
    if (!values.route.length && (values.model !== undefined || values["grant-model"].length)) return { error: "--model and --grant-model need a --route" };
  } else {
    if (values.argv !== undefined || values.input.length) return { error: "only --agent command takes --argv and --input" };
    if (!repo || (values.prompt === undefined) === (values["prompt-file"] === undefined)) return { error: null };
  }
  const inputs = parseInputs(values.input);
  if (typeof inputs === "string") return { error: inputs };
  const model = values.model ?? agent.defaultModel ?? null;
  if (!model && (!isCommand || values.route.length)) return { error: `--agent ${agent.name} needs --model ID` };
  const budget = Number(values["max-model-requests"]);
  if (!/^[0-9]+$/.test(values["max-model-requests"]) || budget < 1 || budget > MAX_MODEL_REQUESTS) return { error: `--max-model-requests must be a whole number from 1 to ${MAX_MODEL_REQUESTS}` };
  if (agent.name !== "fake" && !isCommand && !values.image && !values["tools-image"]) {
    throw new Error(`--agent ${agent.name} needs --tools-image (an image with bin/${agent.binary}, built by images/agent-tools.sh) or an --image that has it, pinned by digest`);
  }
  const allow = [...values.allow.map((a) => parseAllow(a)), ...values["allow-private"].map((a) => parseAllow(a, true))];
  return {
    repo: repo ?? null,
    prompt: isCommand ? "" : (values.prompt ?? fs.readFileSync(values["prompt-file"] ?? "", "utf8")),
    agent: agent.name,
    model,
    models: model ? [model, ...values["grant-model"]] : [],
    routes: values.route.map(parseRoute),
    allow,
    image: values.image ?? IMAGES.agent,
    toolsImage: values["tools-image"] ?? null,
    proxyImage: values["proxy-image"],
    timeoutSeconds: Number(values.timeout),
    maxModelRequests: budget,
    key: key ?? null,
    ...(values["replay-only"] ? { replayOnly: true } : {}),
    out,
    ...(isCommand && argv ? { command: { argv, inputs } } : {}),
    ...(agent.name === "fake" ? { fake: { allowed: allow[0] ? `${allow[0].host}:${allow[0].port}` : "", denied: values["fake-denied"], direct: values["fake-direct"] } } : {}),
  };
}

async function run(args: readonly string[], ctx: Context): Promise<number> {
  const spec = runSpec(args);
  if ("error" in spec) return spec.error ? usageError(ctx, spec.error) : usage(ctx);
  const { out } = spec;
  const abort = new AbortController();
  const cancel = () => abort.abort(new Error("cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    let record;
    try {
      record = await runOnce(spec, processRunDeps(kubectl(), (text) => ctx.io.err(`${text}\n`), abort.signal));
    } catch (error) {
      // A receipt that refuses the run: claimed with no record (unknown), or claimed for another request.
      if (!(error instanceof ReceiptError)) throw error;
      if (ctx.json) ctx.io.out(`${JSON.stringify(errorEnvelope(error.code, error.message), null, 2)}\n`);
      else ctx.io.err(`blacksand: ${error.message}\n`);
      return EXIT.refused;
    }
    const passed = record.run.complete && record.agent.exit_status === 0 && record.cleanup.status === "verified-absent";
    if (ctx.json) ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
    else {
      ctx.io.out(
        [
          `run ${record.run.id}: ${record.run.status}${record.run.complete ? "" : " (incomplete)"}${record.run.error ? `: ${record.run.error}` : ""}`,
          `agent ${record.agent.name} exited ${record.agent.exit_status ?? "-"}; ${record.command ? `files: ${record.result.files?.length ?? 0}` : `patch: ${record.result.patch_files ?? 0} files`}`,
          `egress: ${record.egress.allowed} allowed, ${record.egress.denied} denied; model calls: ${record.egress.model_calls.length}`,
          `cleanup: ${record.cleanup.status}${record.cleanup.remaining.length ? ` (${record.cleanup.remaining.join(", ")})` : ""}`,
          `record: ${out}/record.json`,
          "",
        ].join("\n"),
      );
    }
    return passed ? EXIT.ok : EXIT.refused;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

async function status(args: readonly string[], ctx: Context): Promise<number> {
  const { values } = parseArgs({ args: [...args], options: { key: { type: "string" }, receipts: { type: "string" } } });
  if (values.key === undefined) return usage(ctx);
  const answer = await receiptStatus(values.receipts ?? receiptsRoot(), values.key, kubectl(), Date.now());
  if (ctx.json) ctx.io.out(`${JSON.stringify(answer, null, 2)}\n`);
  else {
    const a = answer.authority;
    ctx.io.out(
      [
        `key ${JSON.stringify(answer.key)}: ${answer.state}${answer.record ? ` (run ${answer.record.run.id}: ${answer.record.run.status})` : ""}`,
        `receipt: ${answer.receipt}`,
        ...(answer.state === "claimed" ? ["no record: the run's outcome is unknown; it won't be launched again under this key"] : []),
        ...(answer.state === "claimed" && !answer.claim ? ["no claim details: its runner stopped before writing them, before it touched the cluster"] : []),
        ...(a ? [`deadline ${a.deadline} (${a.past_deadline ? "passed" : "not yet"}); objects left: ${a.objects ? a.objects.length + (a.foreign?.length ?? 0) || "none" : `unknown (${a.error})`} (facts, not proof the run can no longer act)`] : []),
        "",
      ].join("\n"),
    );
  }
  return EXIT.ok;
}

export const k8s: Command = {
  name: "k8s",
  summary: "run coding agents in per-run Kubernetes sandboxes (agent-sandbox, gVisor, proxy-only egress)",
  usage: USAGE,
  async run(args, ctx) {
    const [verb, ...rest] = args;
    if (verb === "node-setup") return rest.length ? usage(ctx) : (ctx.io.out(nodeSetupScript()), EXIT.ok);
    if (verb === "setup") return setup(rest, ctx);
    if (verb === "run") return run(rest, ctx);
    if (verb === "status") return status(rest, ctx);
    ctx.io.err(`usage:\n${USAGE}\n`);
    return EXIT.usage;
  },
};
