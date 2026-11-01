# substrate-k8s: coding agents in per-run Kubernetes sandboxes

`blacksand k8s run` runs one coding-agent task in a fresh, isolated Sandbox and
tears it down. You get the patch, the agent's output, every connection it tried to
make, and a run record (`blacksand.run/1`) saying what ran, where, and under which
policy. It needs a cluster with
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1beta1, gVisor,
an enforcing NetworkPolicy controller, and this package's egress floor on the
nodes that run sandboxes: k3s locally today, EKS later.

## What a run is

```
caller (blacksand, outside the cluster)
  │ kubectl only: argv, manifests and the repository bundle on stdin, its own kubeconfig
  ▼
blacksand-egress namespace                   blacksand-runs namespace
  Pod p<id> (proxy network): the run's proxy  ◄─  Sandbox s<id> (sandbox network, gVisor, UID 1000)
   - CONNECT: run token, then allowlist  3128      ├ init: tripwire (reports; stops the run if it gets out)
   - one model operation, granted models 8080      ├ /workspace, /tmp, /home/agent: empty, this run only
     and local tools only, body rebuilt;           ├ /run/blacksand/inputs: prompt, steps, read-only
     the key is added here
   - sealed, numbered audit; expires              └ /opt/agent-tools: agent binaries, read-only image
  │
  ▼                     node egress floor: the sandbox network reaches only TCP 3128/8080 on the proxy network
allowlisted hosts · the model backend           NetworkPolicy: only its own proxy; no DNS
```

1. **Preflight**: deletes runs past their deadline (what a lost runner left: only
   objects it can tell are a run's, by kind, name, role and owner, each by its UID;
   anything else wearing a run label is reported and left alone); checks
   both RuntimeClasses require this egress floor and a node has it; refuses to run
   beside a NetworkPolicy blacksand didn't create (policies add up).
2. **Bundle**: the repository's HEAD as a git bundle, made outside. A URL is cloned
   bare first, outside; the sandbox never needs the git host.
3. **Proxy**: its own Pod and network, with the run's allowlist, one model route,
   the grant (which models), limits, and an expiry. Only this run's sandbox may
   connect to it, and only with the run token.
4. **Sandbox**: given the proxy's address and nothing else. The node's floor holds it
   from its first instruction; the tripwire tries cluster DNS once and stops the run
   if it gets through (that would mean no floor).
5. **Clone, agent**: the bundle cloned inside; `agent.sh` runs with the prompt on stdin.
6. **Freeze, export, seal**: every agent process killed; the workspace's files (no
   `.git`, hard links dereferenced so every name carries its bytes) exported as a
   tar; the proxy sealed, so its audit closes.
7. **Teardown**, always, cancellation included. Backstops if the runner is lost:
   both Pods' `activeDeadlineSeconds`, the proxy's own expiry, the Sandbox's
   `shutdownTime`, and the next `setup` or `run`, which deletes expired runs.
8. **Patch and record**, outside the cluster: the patch is made by git the agent
   never touched, from the original base and the export; the audit is checked
   whole (numbered, sealed, every request ended).

## Agents run with full access inside the sandbox; the sandbox is the boundary

No inner sandbox, no approval prompts, no harness permission modes: Codex runs
with `sandbox_mode = "danger-full-access"` and `approval_policy = "never"`,
Claude Code with `--permission-mode bypassPermissions`, each recorded under
`agent.settings` in the run record. (Codex's own sandbox, bubblewrap, would need
user namespaces, which a gVisor Pod doesn't grant; granting them would loosen
the Pod.) That's safe only because every sandbox Pod is locked down:

- the sandbox RuntimeClass (gVisor), which schedules only onto nodes carrying
  this egress floor's label;
- non-root, no privilege escalation, every capability dropped, in every container;
- no service-account token, no hostPath volume, no host network, PID or IPC namespace;
- no provider key mounted: no Secret by volume or environment (the key is only
  in the proxy's Pod).

`test/full-access.test.ts` checks both halves for every registered adapter: a new
adapter without full access, or a change to any of these, fails it.

## Setup

Once per node, as root on it (prints a script; read it, then run it):

```sh
./blacksand k8s node-setup | sudo sh
```

It gives sandbox and proxy Pods their own networks (containerd's per-runtime CNI
config), installs the nftables floor, makes k3s require it at boot, and labels the
node with the floor's digest. **Single-node only for now.** The label is ordinary
node metadata, so it trusts whoever administers the cluster, not only root on the
node; several nodes, or EKS, need a protected `node-restriction.kubernetes.io/`
label. Then once per cluster, as an admin:

```sh
export BLACKSAND_KUBECTL='["kubectl","--context","lab"]'   # or a prefix that reaches the cluster
./blacksand k8s setup        # namespaces, RuntimeClasses, default-deny; deletes expired runs
```

Model credentials are Secrets in `blacksand-egress`, one key named `key`. Type or
paste the value on stdin so it never appears in a command line or shell history:

```sh
kubectl create secret generic anthropic-key -n blacksand-egress --from-file=key=/dev/stdin
# paste the key, then Enter and Ctrl-D
```

Agent binaries come from the tools image (`images/agent-tools.sh`): Claude Code and
Codex from their upstream releases, checksum-pinned, in one reproducible layer. The
script checks checksums only; each pin is authenticated (PGP, Sigstore) by whoever
reviews a change to it, as its header says.

## Running

```sh
./blacksand k8s run --repo ~/code/project --prompt-file task.md \
  --agent codex \
  --route openai=https://api.openai.com@openai-key \
  --tools-image blacksand.local/agent-tools@sha256:… \
  --allow registry.npmjs.org:443 --max-model-requests 200 \
  --out runs/2026-11-01-task --json

./blacksand k8s run --repo ~/code/project --prompt-file task.md \
  --agent claude \
  --route anthropic=https://api.anthropic.com@anthropic-key \
  --tools-image blacksand.local/agent-tools@sha256:… \
  --out runs/2026-11-01-task-claude --json
```

Defaults: Codex runs `gpt-6.1-sol` at `model_reasoning_effort = "medium"` (in its
config.toml); Claude Code runs `claude-sonnet-5-5` at `CLAUDE_CODE_EFFORT_LEVEL=medium`
(in Claude Code 2.1.309 that variable wins over `--effort`, the `effortLevel` setting
and the model's default, sub-agents included).

| Option | Meaning |
|---|---|
| `--agent fake\|claude\|codex` | The adapter. `fake` is for tests: it edits a file, makes allowed and denied calls, and attacks the proxy and its own git. |
| `--route KIND=URL@SECRET` | The model route: `anthropic` (Messages, credential as `x-api-key`) or `openai` (Responses, `Authorization: Bearer`). The URL is an origin and an optional path prefix. |
| `--model ID`, `--grant-model ID …` | The agent's model (default: `gpt-6.1-sol` for codex, `claude-sonnet-5-5` for claude; fake needs one), and any others the run may name. The proxy refuses every other model. |
| `--allow HOST:PORT` | An exact CONNECT allowlist entry. No wildcards or IP literals; names that resolve to private addresses are refused unless given with `--allow-private`. |
| `--image`, `--tools-image`, `--proxy-image` | Images, each pinned by digest. The defaults are Node 24.22.2 images (bookworm has git for the agent). |
| `--timeout SECONDS` | The agent's limit (default 1800); everything of the run expires 300 s after it. |
| `--max-model-requests N` | The proxy's request budget for the run (default 2000, at most 100000); past it, model requests are refused. |
| `--key KEY` | The caller's own id for the run, copied into the record. |

Exit 0 means the run completed with all its evidence, the agent exited 0, and
cleanup was verified; anything else exits 4. Ctrl-C cancels: teardown still runs,
and the record says `cancelled`.

## What it protects against, and what it doesn't

- **Protects:**
  - **the host kernel, mostly**: gVisor intercepts the agent's syscalls;
  - **other runs' files**: fresh empty volumes, a new Sandbox and Pod each time;
  - **model and cloud credentials**: only the proxy holds them, and only for one
    operation, the granted models, and until the run expires;
  - **provider-side work for the run**: the request body is checked and rebuilt
    before the key is read. It may carry only local tools (functions, custom tools,
    namespaces of those, client-run tool search), wherever the request offers them. Web search, file search, MCP servers, remote files or
    URLs, other responses or conversations, background work and retention are
    refused, and so is any beta feature Claude Code doesn't use;
  - **network access beyond the allowlist**: DNS, IPv4 and IPv6, the node, other
    Pods and Services, from a Pod's first instruction (the node floor, then
    NetworkPolicy, then the run token at the proxy);
  - **a falsified patch**: it's made outside from the original base.
- **Doesn't:**
  - data leaving to an allowlisted host, or in the prompt and context sent to the
    model provider itself;
  - a gVisor or kernel escape;
  - a compromised node or cluster admin;
  - anyone who can read the Sandbox (it holds the per-run token, which works only
    against this run's proxy, until the run expires).
- **Also:** the patch is the agent's output, so review it before applying. A local
  cluster is development evidence; isolation claims for EKS need their own native
  gate. The node floor here is single-node and k3s-specific; on EKS the same floor
  comes from the node image and VPC CNI strict mode.

## Tests

- Fast (`npm test`):
  - manifests and the node floor's files;
  - policy and the run record checks;
  - the full-access rule and the Pod lockdown it rests on, for every adapter;
  - the CLI's defaults;
  - the proxy, with real sockets on loopback (SSRF attempts, grants, limits, audit
    pairing and sealing, expiry);
  - the trusted collector against a real repository, including the replace-object attack;
  - the run orchestration against a scripted kubectl.
- Deep:
  - `test/proxy-load.deep.test.ts`: a 200-request burst against the limits;
  - `test/journey.deep.test.ts`: a real cluster. The floor alone with no
    NetworkPolicy and a matched control, the fake agent's attacks, clean repeat
    runs, a lost runner, and with `BLACKSAND_K8S_TOOLS_IMAGE` the real Claude Code
    and Codex at their default models against a fake model backend (Codex edits with
    apply_patch, then runs a probe that may reach only its proxy). Its header lists
    the environment it needs.

## Long-lived mode

`src/longlived.ts` is the interface for an always-on agent (create, attach, stop on a
persistent volume). It isn't implemented.
