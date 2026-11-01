// blacksand k8s: the Kubernetes substrate's commands.
//   blacksand k8s node-setup   (prints the root script that installs the egress floor on a k3s node)
//   blacksand k8s setup        (an admin, once per cluster; also deletes expired runs)
//   blacksand k8s run …        (one task in a fresh Sandbox; prints its blacksand.run/1 record with --json)

import * as fs from "node:fs";
import { parseArgs } from "node:util";

import { usageError, type Command, type Context } from "../../../src/core/command.ts";
import { EXIT } from "../../../src/core/envelope.ts";
import { agentNamed } from "./agents.ts";
import { kubectlPrefix, must, processKubectl } from "./kubectl.ts";
import { list, setupObjects } from "./manifests.ts";
import { FLOOR_ID, nodeSetupScript } from "./node.ts";
import { DEFAULT_LIMITS, parseAllow, parseRoute } from "./policy.ts";
import { MAX_MODEL_REQUESTS, processRunDeps, reconcile, runOnce, type RunSpec } from "./run.ts";

/** Images pinned by digest (multi-arch indexes). Node 24.22.2: bookworm has git for the agent; alpine is enough for the proxy. */
export const IMAGES = {
  agent: "docker.io/library/node@sha256:e7add2a490bb17d97b485b8641bd88455fff7839ade0f5eba493c3508124d413",
  proxy: "docker.io/library/node@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85",
} as const;

const USAGE = [
  "blacksand k8s node-setup",
  "blacksand k8s setup",
  "blacksand k8s run --repo PATH|URL (--prompt TEXT | --prompt-file FILE) --agent fake|claude|codex [--model ID]",
  "    --route KIND=URL@SECRET [--grant-model ID …] [--allow HOST:PORT …] [--allow-private HOST:PORT …] --out DIR",
  "    [--image IMAGE@sha256:…] [--tools-image IMAGE@sha256:…] [--proxy-image IMAGE@sha256:…] [--timeout SECONDS]",
  "    [--max-model-requests N] [--key KEY] [--json]",
  "  defaults: codex gpt-6.1-sol, claude claude-sonnet-5-5, both at medium effort; fake needs --model; --max-model-requests 2000.",
].join("\n");

const kubectl = () => processKubectl(kubectlPrefix(process.env.BLACKSAND_KUBECTL));

async function setup(args: readonly string[], ctx: Context): Promise<number> {
  if (args.length) return usage(ctx);
  const k = kubectl();
  const objects = setupObjects();
  await must(k, ["apply", "-f", "-"], { stdin: JSON.stringify(list(objects)) });
  const reconciled = await reconcile(k, Date.now());
  const applied = objects.map((o) => `${String(o.kind)}/${String((o.metadata as { name: string }).name)}`);
  const report = [
    `applied ${applied.length} objects for egress floor ${FLOOR_ID}; deleted ${reconciled.deleted.length} expired run(s)`,
    ...reconciled.undated.map((id) => `left alone, no deadline recorded: run ${id}`),
    ...reconciled.foreign.map((o) => `left alone, not created by blacksand: ${o}`),
  ];
  ctx.io.out(ctx.json ? `${JSON.stringify({ applied, floor: FLOOR_ID, reconciled }, null, 2)}\n` : `${report.join("\n")}\n`);
  return EXIT.ok;
}

function usage(ctx: Context): number {
  ctx.io.err(`usage:\n${USAGE}\n`);
  return EXIT.usage;
}

/** `k8s run`'s arguments as a RunSpec, or the usage error to print (null: just the usage). Touches no cluster. */
export function runSpec(args: readonly string[]): RunSpec | { error: string | null } {
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
      "fake-denied": { type: "string", default: "example.org:443" },
      "fake-direct": { type: "string", multiple: true, default: ["1.1.1.1:443"] },
    },
  });
  const { repo, agent: agentName, out } = values;
  if (!repo || !agentName || !out || (values.prompt === undefined) === (values["prompt-file"] === undefined)) return { error: null };
  const agent = agentNamed(agentName);
  const model = values.model ?? agent.defaultModel;
  if (!model) return { error: `--agent ${agent.name} needs --model ID` };
  const budget = Number(values["max-model-requests"]);
  if (!/^[0-9]+$/.test(values["max-model-requests"]) || budget < 1 || budget > MAX_MODEL_REQUESTS) return { error: `--max-model-requests must be a whole number from 1 to ${MAX_MODEL_REQUESTS}` };
  if (agent.name !== "fake" && !values.image && !values["tools-image"]) {
    throw new Error(`--agent ${agent.name} needs --tools-image (an image with bin/${agent.binary}, built by images/agent-tools.sh) or an --image that has it, pinned by digest`);
  }
  const allow = [...values.allow.map((a) => parseAllow(a)), ...values["allow-private"].map((a) => parseAllow(a, true))];
  return {
    repo,
    prompt: values.prompt ?? fs.readFileSync(values["prompt-file"] ?? "", "utf8"),
    agent: agent.name,
    model,
    models: [model, ...values["grant-model"]],
    routes: values.route.map(parseRoute),
    allow,
    image: values.image ?? IMAGES.agent,
    toolsImage: values["tools-image"] ?? null,
    proxyImage: values["proxy-image"],
    timeoutSeconds: Number(values.timeout),
    maxModelRequests: budget,
    key: values.key ?? null,
    out,
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
    const record = await runOnce(spec, processRunDeps(kubectl(), (text) => ctx.io.err(`${text}\n`), abort.signal));
    const passed = record.run.complete && record.agent.exit_status === 0 && record.cleanup.status === "verified-absent";
    if (ctx.json) ctx.io.out(`${JSON.stringify(record, null, 2)}\n`);
    else {
      ctx.io.out(
        [
          `run ${record.run.id}: ${record.run.status}${record.run.complete ? "" : " (incomplete)"}${record.run.error ? `: ${record.run.error}` : ""}`,
          `agent ${record.agent.name} exited ${record.agent.exit_status ?? "-"}; patch: ${record.result.patch_files ?? 0} files`,
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

export const k8s: Command = {
  name: "k8s",
  summary: "run coding agents in per-run Kubernetes sandboxes (agent-sandbox, gVisor, proxy-only egress)",
  usage: USAGE,
  async run(args, ctx) {
    const [verb, ...rest] = args;
    if (verb === "node-setup") return rest.length ? usage(ctx) : (ctx.io.out(nodeSetupScript()), EXIT.ok);
    if (verb === "setup") return setup(rest, ctx);
    if (verb === "run") return run(rest, ctx);
    ctx.io.err(`usage:\n${USAGE}\n`);
    return EXIT.usage;
  },
};
