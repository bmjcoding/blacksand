// Agent adapters: what runs in the sandbox for `--agent NAME`. Each renders a
// fixed agent.sh; the prompt arrives on stdin and the model in BLACKSAND_MODEL,
// so nothing the caller types is ever spliced into a command line. Each agent
// talks to its model through the run's proxy with the run token as its API
// key: the proxy swaps in the real credential, which never enters the sandbox.
//
// The rule: agents run with full access inside the sandbox; the sandbox is
// the boundary. No inner sandbox, no approval prompts, no harness permission
// modes: the Pod (gVisor, the node's egress floor, non-root, no
// service-account token, no provider key) is what holds the agent, and
// test/full-access.test.ts checks both halves for every adapter.

import { HOME_MOUNT, TOOLS_MOUNT } from "./manifests.ts";
import { assertModel, PORTS, type RouteKind } from "./policy.ts";

const TOOLS_PATH = `export PATH="${TOOLS_MOUNT}/bin:$PATH"`;

export type AgentName = "fake" | "claude" | "codex";

export interface AgentContext {
  proxyIp: string;
}

export interface Agent {
  name: AgentName;
  /** The model route it needs. */
  route: RouteKind;
  /** agent.sh, run in the repository with the prompt on stdin. */
  script: string;
  /** Extra input files, by name. */
  files(ctx: AgentContext): Record<string, string>;
  /** What the agent's binary must be called on the image's PATH, for the docs and the preflight. */
  binary: string;
  /** How the agent's harness is set to run (full access, no approvals, its effort), as the script and config render it. Recorded in the run record. */
  settings: Readonly<Record<string, string>>;
  /** The model when the caller names none. */
  defaultModel?: string;
}

const modelUrl = (ctx: AgentContext, route: RouteKind) => `http://${ctx.proxyIp}:${PORTS.model}/${route}`;

const fake: Agent = {
  name: "fake",
  route: "anthropic",
  binary: "node",
  script: "exec node /run/blacksand/inputs/fake-agent.ts\n",
  files: () => ({}), // fake-agent.ts is added by the runner, from sandbox/
  settings: {}, // no harness: nothing to switch off
};

// Claude Code in print mode, pointed at the proxy's Anthropic route. Its cloud
// modes are switched off so it uses the plain Messages API the route speaks;
// non-essential traffic (telemetry, error reports, update checks) is off, and
// the proxy would refuse it anyway. Permissions are bypassed: the sandbox is
// the boundary. Effort is CLAUDE_CODE_EFFORT_LEVEL: in Claude Code 2.1.309 it
// takes precedence over --effort, the effortLevel setting and the model's
// default, and holds for its sub-agents too.
const CLAUDE = { permission_mode: "bypassPermissions", effort_level: "medium" } as const;
const claude: Agent = {
  name: "claude",
  route: "anthropic",
  binary: "claude",
  settings: CLAUDE,
  defaultModel: "claude-sonnet-5-5",
  script: [
    TOOLS_PATH,
    "unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_MANTLE ANTHROPIC_AUTH_TOKEN",
    'export ANTHROPIC_BASE_URL="$BLACKSAND_MODEL_URL" ANTHROPIC_API_KEY="$BLACKSAND_RUN_TOKEN"',
    // Every model Claude Code would pick for itself (background, sub-agents) is the granted one, which the proxy checks.
    'export ANTHROPIC_MODEL="$BLACKSAND_MODEL" ANTHROPIC_SMALL_FAST_MODEL="$BLACKSAND_MODEL" ANTHROPIC_DEFAULT_HAIKU_MODEL="$BLACKSAND_MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$BLACKSAND_MODEL" ANTHROPIC_DEFAULT_OPUS_MODEL="$BLACKSAND_MODEL" CLAUDE_CODE_SUBAGENT_MODEL="$BLACKSAND_MODEL"',
    `export CLAUDE_CODE_EFFORT_LEVEL=${CLAUDE.effort_level}`,
    "export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1",
    `exec claude -p --output-format json --permission-mode ${CLAUDE.permission_mode} --model "$BLACKSAND_MODEL"`,
    "",
  ].join("\n"),
  files: () => ({}),
};

// Codex's non-interactive mode with a custom provider whose base URL is the
// proxy's OpenAI route and whose API key is the run token. Codex's own
// sandbox is off (danger-full-access) and it never asks for approval: the Pod
// is the boundary. Its Linux sandbox (bubblewrap) would need user namespaces,
// which a gVisor Pod doesn't grant, so under workspace-write every
// apply_patch failed; granting them would loosen the Pod. All of it is in
// config.toml, none in flags, its reasoning effort included. Its update checks, analytics and web search (a
// provider-run tool the proxy refuses) are off.
const CODEX = { sandbox_mode: "danger-full-access", approval_policy: "never", model_reasoning_effort: "medium" } as const;
const codex: Agent = {
  name: "codex",
  route: "openai",
  binary: "codex",
  settings: CODEX,
  defaultModel: "gpt-6.1-sol",
  script: [
    TOOLS_PATH,
    'export CODEX_HOME="$HOME/.codex"',
    'mkdir -p "$CODEX_HOME" && cp /run/blacksand/inputs/codex-config.toml "$CODEX_HOME/config.toml"',
    'exec codex exec --skip-git-repo-check --model "$BLACKSAND_MODEL" -',
    "",
  ].join("\n"),
  files: (ctx) => ({
    "codex-config.toml": [
      'model_provider = "blacksand"',
      `approval_policy = "${CODEX.approval_policy}"`,
      `sandbox_mode = "${CODEX.sandbox_mode}"`,
      `model_reasoning_effort = "${CODEX.model_reasoning_effort}"`,
      "check_for_update_on_startup = false",
      // Web search runs on the provider's side, outside the run's allowlist and audit: the proxy refuses it, so Codex mustn't ask.
      'web_search = "disabled"',
      "",
      "[feedback]",
      "enabled = false",
      "",
      "[analytics]",
      "enabled = false",
      "",
      "[model_providers.blacksand]",
      'name = "Blacksand model route"',
      `base_url = "${modelUrl(ctx, "openai")}/v1"`,
      'env_key = "BLACKSAND_RUN_TOKEN"',
      'wire_api = "responses"',
      "",
    ].join("\n"),
  }),
};

export const AGENTS: Record<AgentName, Agent> = { fake, claude, codex };

export function agentNamed(name: string): Agent {
  const agent = AGENTS[name as AgentName];
  if (!agent || !Object.hasOwn(AGENTS, name)) throw new Error(`unknown agent ${JSON.stringify(name)}: one of ${Object.keys(AGENTS).join(", ")}`);
  return agent;
}

/** The environment every agent gets: the proxy for HTTPS (the run token as its password), the model route, a HOME of its own, a git identity. */
export function agentEnv(agent: Agent, ctx: AgentContext, model: string, token: string, extra: Record<string, string> = {}): Record<string, string> {
  const proxy = `http://run:${token}@${ctx.proxyIp}:${PORTS.connect}`;
  return {
    HOME: HOME_MOUNT,
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    NO_PROXY: ctx.proxyIp,
    no_proxy: ctx.proxyIp,
    BLACKSAND_PROXY: ctx.proxyIp,
    BLACKSAND_MODEL_URL: modelUrl(ctx, agent.route),
    BLACKSAND_MODEL: assertModel(model),
    BLACKSAND_RUN_TOKEN: token,
    GIT_AUTHOR_NAME: "blacksand agent",
    GIT_AUTHOR_EMAIL: "agent@blacksand.invalid",
    GIT_COMMITTER_NAME: "blacksand agent",
    GIT_COMMITTER_EMAIL: "agent@blacksand.invalid",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}
