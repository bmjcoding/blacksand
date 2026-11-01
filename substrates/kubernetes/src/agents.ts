// Agent adapters: what runs in the sandbox for `--agent NAME`. Each renders a
// fixed agent.sh; the prompt arrives on stdin and the model in BLACKSAND_MODEL,
// so nothing the caller types is ever spliced into a command line. Each agent
// talks to its model through the run's proxy with the run token as its API
// key: the proxy swaps in the real credential, which never enters the sandbox.
// The command adapter runs a fixed argv instead of an agent: each argument is
// a read-only input file, so none of it is ever parsed by a shell either.
//
// The rule: agents run with full access inside the sandbox; the sandbox is
// the boundary. No inner sandbox, no approval prompts, no harness permission
// modes: the Pod (gVisor, the node's egress floor, non-root, no
// service-account token, no provider key) is what holds the agent, and
// test/full-access.test.ts checks both halves for every adapter.

import { HOME_MOUNT, TOOLS_MOUNT } from "./manifests.ts";
import { assertModel, PORTS, type RouteKind } from "./policy.ts";

const TOOLS_PATH = `export PATH="${TOOLS_MOUNT}/bin:$PATH"`;

export type AgentName = "fake" | "claude" | "codex" | "command";

export interface AgentContext {
  proxyIp: string;
}

export interface Agent {
  name: AgentName;
  /** The model route it needs; null: whichever route the caller gives, if any (the command adapter). */
  route: RouteKind | null;
  /** agent.sh, run in the repository with the prompt on stdin (the command adapter: in /workspace, stdin empty). */
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

// A fixed command, no agent and no prompt: for a caller that stages its own
// program as frozen inputs (mounted read-only at /workspace/inputs) and wants
// back the files it writes under /workspace. The runner writes argc and one
// file per argument (argv.0, argv.1, …); this script reads each back whole and
// execs the list, so an argument is only ever data: no eval, no splitting, no
// globbing. The trailing x keeps trailing newlines, which $(…) would strip.
const command: Agent = {
  name: "command",
  route: null,
  binary: "sh",
  settings: {}, // no harness: nothing to switch off
  script: [
    "set -eu",
    "n=$(cat /run/blacksand/inputs/argc)",
    "set --",
    "i=0",
    'while [ "$i" -lt "$n" ]; do',
    '  arg=$(cat "/run/blacksand/inputs/argv.$i"; printf x)',
    '  set -- "$@" "${arg%x}"',
    "  i=$((i + 1))",
    "done",
    'exec "$@"',
    "",
  ].join("\n"),
  files: () => ({}), // argc and argv.N are added by the runner, from the run's argv
};

export const AGENTS: Record<AgentName, Agent> = { fake, claude, codex, command };

export function agentNamed(name: string): Agent {
  const agent = AGENTS[name as AgentName];
  if (!agent || !Object.hasOwn(AGENTS, name)) throw new Error(`unknown agent ${JSON.stringify(name)}: one of ${Object.keys(AGENTS).join(", ")}`);
  return agent;
}

/** The environment every agent gets: the proxy for HTTPS (the run token as its password), the model route if the run has one, a HOME of its own, a git identity. */
export function agentEnv(route: RouteKind | null, ctx: AgentContext, model: string | null, token: string, extra: Record<string, string> = {}): Record<string, string> {
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
    ...(route && model !== null ? { BLACKSAND_MODEL_URL: modelUrl(ctx, route), BLACKSAND_MODEL: assertModel(model) } : {}),
    BLACKSAND_RUN_TOKEN: token,
    GIT_AUTHOR_NAME: "blacksand agent",
    GIT_AUTHOR_EMAIL: "agent@blacksand.invalid",
    GIT_COMMITTER_NAME: "blacksand agent",
    GIT_COMMITTER_EMAIL: "agent@blacksand.invalid",
    GIT_TERMINAL_PROMPT: "0",
    ...extra,
  };
}
