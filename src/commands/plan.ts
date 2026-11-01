// blacksand plan: the steps that would bring this machine to its config
// (blacksand.plan/1). Unprivileged and read-only: it observes, compares and
// prints; nothing is applied. Exit 0 when the machine matches its config, 1
// (drift) when there are steps or checked differences, 4 when there's no
// config to compare against or it can't be read.

import { emit, usageError, type Command } from "../core/command.ts";
import { EXIT, SCHEMA, blacksandInfo, errorEnvelope } from "../core/envelope.ts";
import { ConfigError, parseMachineConfig } from "../core/machine.ts";
import type { Plan } from "../core/plan.ts";
import { observedDigest, planSteps, sha256, wantedOf } from "../core/planner.ts";
import { resourcesOf } from "../core/resource.ts";
import { systemHost } from "../platform/host.ts";
import { observe } from "../platform/index.ts";

export const configPath = (home: string) => `${home}/.config/blacksand/machine.json`;

function text(plan: Plan, config: string): string {
  const lines = plan.steps.map((s) => `  ${{ create: "+", update: "~", remove: "-", unknown: "?" }[s.action]} ${s.id}${s.widens_access ? " (widens access)" : ""}: ${s.summary}`);
  const warnings = plan.warnings.map((w) => `  ! ${w.code}: ${w.text}`);
  return [
    plan.steps.length
      ? `plan for ${plan.machine.id} (${config}), ${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}:`
      : plan.warnings.length
        ? `no steps for ${config}, but ${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"} to read:`
        : `no steps: this machine matches ${config}`,
    ...lines.sort((a, b) => Number(b.includes("(widens access)")) - Number(a.includes("(widens access)"))),
    ...(warnings.length ? ["warnings:", ...warnings] : []),
    `observed ${plan.observed_sha256.slice(0, 16)}…; nothing was applied`,
  ].join("\n");
}

export const plan: Command = {
  name: "plan",
  summary: "propose the steps that bring this machine to its config (applies nothing)",
  usage: "blacksand plan [--config FILE] [--json]",
  async run(args, ctx) {
    let file: string | undefined;
    if (args.length === 2 && args[0] === "--config" && args[1]) file = args[1];
    else if (args.length) return usageError(ctx, `usage: ${this.usage}`);
    const host = ctx.host ?? systemHost();
    const config = file ?? configPath(host.home);
    const read = host.read(config);

    if (!read.ok && read.why === "missing" && file === undefined) {
      const envelope: Plan = {
        schema: SCHEMA.plan,
        blacksand: blacksandInfo(),
        machine: { id: null, role: null, platform: host.platform },
        config_sha256: null,
        observed_sha256: observedDigest(host.platform, resourcesOf(observe(host))),
        steps: [],
        warnings: [{ code: "plan/no-config", text: `no machine config at ${config}, so there's nothing to compare with: blacksand status shows what was observed` }],
      };
      return emit(ctx, envelope, `no plan: ${envelope.warnings[0]?.text}`, EXIT.refused);
    }

    let parsed;
    try {
      if (!read.ok) throw new ConfigError(`${config} can't be read (${read.why})`);
      parsed = parseMachineConfig(JSON.parse(read.bytes.toString("utf8")));
    } catch (error) {
      if (!(error instanceof ConfigError || error instanceof SyntaxError)) throw error;
      const why = error instanceof SyntaxError ? `${config} isn't JSON: ${error.message}` : error.message;
      return emit(ctx, errorEnvelope("plan/config", why), `no plan: ${why}`, EXIT.refused);
    }

    const planned = planSteps(parsed, observe(host, wantedOf(parsed)));
    const envelope: Plan = {
      schema: SCHEMA.plan,
      blacksand: blacksandInfo(),
      machine: { id: parsed.machine.id, role: parsed.machine.role, platform: host.platform },
      config_sha256: sha256(read.bytes),
      observed_sha256: observedDigest(host.platform, planned.observed),
      steps: planned.steps,
      warnings: planned.warnings,
    };
    const drift = planned.steps.length > 0 || planned.warnings.some((w) => /^(?:drift|unknown)\//.test(w.code));
    return emit(ctx, envelope, text(envelope, config), drift ? EXIT.drift : EXIT.ok);
  },
};
