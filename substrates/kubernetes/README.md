# substrate-k8s: coding agents in per-run Kubernetes sandboxes

`blacksand k8s run` runs one coding-agent task in a new, isolated Sandbox, then tears
the Sandbox down. You get:

- the patch;
- the agent's output;
- every connection the agent tried to make;
- a run record (`blacksand.run/1`) that says what ran, where, and under which policy.

The cluster needs:

- [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1beta1;
- gVisor;
- a NetworkPolicy controller that enforces policies;
- this component's egress floor on every node that runs sandboxes. The floor is a
  default-deny nftables rule set, described under [Setup](#setup).

It runs on k3s today. EKS support comes later.

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

1. **Preflight.** Blacksand deletes runs past their deadline, which is what a lost
   runner leaves behind. It deletes only objects it can tell belong to a run, by kind,
   name, role and owner, and each one by its UID. Anything else that carries a run
   label, it reports and leaves alone. It checks that both RuntimeClasses require the
   egress floor, and that a node has the floor. It refuses to run beside a
   NetworkPolicy it didn't create, because NetworkPolicies combine: another policy
   could allow traffic this one denies.
2. **Bundle.** Outside the cluster, Blacksand makes a git bundle of the repository's
   HEAD. Given a URL, it first makes a bare clone, also outside. The sandbox never needs
   to reach the git host.
3. **Proxy.** The proxy runs in its own Pod, on its own network. It gets the run's
   allowlist, one model route, the grant of models the run may use, the limits and an
   expiry. Only this run's sandbox may connect to it, and only with the run token.
4. **Sandbox.** The sandbox gets the proxy's address and nothing else. The node's floor
   applies from the sandbox's first instruction. A tripwire tries cluster DNS once. If
   the lookup works, the floor is missing, and the tripwire stops the run.
5. **Clone and agent.** The sandbox clones the bundle. `agent.sh` runs with the prompt
   on stdin.
6. **Freeze, export, seal.** Blacksand kills every agent process. It exports the
   workspace's files as a tar, without `.git`. Hard links are dereferenced, so every
   name carries its bytes. Then it seals the proxy, which closes the proxy's audit log.
7. **Teardown.** Teardown always runs, after a cancellation too. If the runner is lost,
   four backstops remain: both Pods' `activeDeadlineSeconds`, the proxy's own expiry,
   the Sandbox's `shutdownTime`, and the next `setup` or `run`, which deletes expired
   runs.
8. **Patch and record.** Outside the cluster, a git the agent never touched makes the
   patch, from the original base and the export. Blacksand checks the whole audit log:
   every entry numbered, the log sealed, and every request ended.

## Agents have full access inside the sandbox

The sandbox is the security boundary, so agents run without an inner sandbox or
approval prompts:

- Codex runs with `sandbox_mode = "danger-full-access"` and
  `approval_policy = "never"`.
- Claude Code runs with `--permission-mode bypassPermissions`.

The run record keeps each agent's settings under `agent.settings`.

Codex's own sandbox, bubblewrap, needs user namespaces. A gVisor Pod doesn't grant them,
and granting them would weaken the Pod.

Full access is safe only because every sandbox Pod is locked down:

- It uses the sandbox RuntimeClass, gVisor, which schedules only onto nodes labelled
  with this egress floor.
- Every container runs as non-root, with privilege escalation off and every capability
  dropped.
- The Pod has no service-account token, no hostPath volume, and no host network, PID
  or IPC namespace.
- No provider key is mounted, by volume or by environment. The key exists only in the
  proxy's Pod.

`test/full-access.test.ts` checks both halves for every registered adapter. A new
adapter without full access fails it, and so does a change to any of these settings.

## Setup

Once per node, as root on that node, save the setup script, read it, then run it:

```sh
./blacksand k8s node-setup > node-setup.sh
less node-setup.sh
sudo sh node-setup.sh
```

The script:

- gives sandbox and proxy Pods their own networks, through containerd's per-runtime CNI
  config;
- installs the nftables floor;
- makes k3s require the floor at boot;
- labels the node with the floor's digest.

**Single-node only for now.** The label is ordinary node metadata, so anyone who
administers the cluster can set it, not only root on the node. Several nodes, or EKS,
need a protected `node-restriction.kubernetes.io/` label.

Then, once per cluster, as an admin:

```sh
export BLACKSAND_KUBECTL='["kubectl","--context","lab"]'   # or a prefix that reaches the cluster
./blacksand k8s setup        # namespaces, RuntimeClasses, default-deny; deletes expired runs
```

Model credentials are Secrets in the `blacksand-egress` namespace, each with one key
named `key`. Paste the value on stdin, so it never appears in a command line or your
shell history:

```sh
kubectl create secret generic anthropic-key -n blacksand-egress --from-file=key=/dev/stdin
# paste the key, then Enter and Ctrl-D
```

The agent binaries come from the tools image, built by `images/agent-tools.sh`. It
installs Claude Code and Codex from their upstream releases, pinned by checksum, in one
reproducible layer. The script checks only the checksums. Whoever reviews a change to a
pin authenticates it with PGP or Sigstore, as the script's header says.

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

The defaults:

- Codex runs `gpt-6.1-sol` with `model_reasoning_effort = "medium"`, set in its
  `config.toml`.
- Claude Code runs `claude-sonnet-5-5` with `CLAUDE_CODE_EFFORT_LEVEL=medium`. In Claude
  Code 2.1.309, that variable overrides `--effort`, the `effortLevel` setting and the
  model's default, for sub-agents too.

| Option | Meaning |
|---|---|
| `--agent fake\|claude\|codex` | The adapter. `fake` is for tests: it edits a file, makes allowed and denied calls, and attacks the proxy and its own git. |
| `--route KIND=URL@SECRET` | The model route. `anthropic` uses the Messages API and sends the credential as `x-api-key`. `openai` uses the Responses API and sends it as `Authorization: Bearer`. The URL is an origin, with an optional path prefix. |
| `--model ID`, `--grant-model ID …` | The agent's model, and any other models the run may name. The proxy refuses every other model. The default is `gpt-6.1-sol` for codex and `claude-sonnet-5-5` for claude. `fake` needs one. |
| `--allow HOST:PORT` | One exact entry in the CONNECT allowlist. Wildcards and IP literals aren't accepted. A name that resolves to a private address is refused unless you give it with `--allow-private`. |
| `--image`, `--tools-image`, `--proxy-image` | Images, each pinned by digest. The agent and proxy default to Node 24.22.2 images: Debian bookworm for the agent, because it has git, and Alpine for the proxy. Claude and Codex need a tools image, or an `--image` that has their binary. |
| `--timeout SECONDS` | The agent's time limit, 1800 by default. Everything in the run expires 300 seconds after it. |
| `--max-model-requests N` | The proxy's request budget for the run: 2000 by default, at most 100000. Past it, the proxy refuses model requests. |
| `--key KEY` | Your own ID for the run, copied into the record. |

Exit code 0 means the run completed with all its evidence, the agent exited 0, and
Blacksand verified the cleanup. Anything else exits 4. Ctrl-C cancels the run. Teardown
still runs, and the record says `cancelled`.

## What it protects against

- **The host kernel, mostly.** gVisor intercepts the agent's syscalls.
- **Other runs' files.** Each run gets new, empty volumes, and a new Sandbox and Pod.
- **Model and cloud credentials.** Only the proxy holds them. It uses them for one
  operation, for the granted models, and only until the run expires.
- **Provider-side work for the run.** The proxy checks and rebuilds the request body
  before it reads the key. The body may carry only local tools, wherever the request
  offers them: functions, custom tools, namespaces of those, and client-run tool search.
  The proxy refuses web search, file search, MCP servers, remote files or URLs, other
  responses or conversations, background work and retention. It also refuses any beta
  feature Claude Code doesn't use.
- **Network access beyond the allowlist.** This covers DNS, IPv4 and IPv6, the node, and
  other Pods and Services, from a Pod's first instruction. Three layers enforce it: the
  node floor, then NetworkPolicy, then the run token at the proxy.
- **A falsified patch.** Blacksand makes the patch outside the cluster, from the
  original base.

It doesn't protect against:

- data that leaves to an allowlisted host, or in the prompt and context sent to the
  model provider;
- a gVisor or kernel escape;
- a compromised node or cluster admin;
- anyone who can read the Sandbox. It holds the run token, which works only against
  this run's proxy, and only until the run expires.

Before you rely on it:

- The patch is the agent's output, so review it before you apply it.
- A local cluster is development evidence. Isolation claims for EKS need their own
  tests on a real EKS cluster.
- The node floor here is single-node and specific to k3s. On EKS, the same floor comes
  from the node image and VPC CNI strict mode.

## Tests

Fast (`npm test`):

- manifests and the node floor's files;
- policy and the run record checks;
- the full-access rule, and the Pod lockdown it relies on, for every adapter;
- the CLI's defaults;
- the proxy, with real sockets on loopback: SSRF attempts, grants, limits, audit
  pairing and sealing, expiry;
- the trusted collector against a real repository, including the replace-object attack;
- the run orchestration against a scripted kubectl.

Deep:

- `test/proxy-load.deep.test.ts` sends a 200-request burst against the limits.
- `test/journey.deep.test.ts` runs against a real cluster. It covers the floor alone,
  without NetworkPolicy, against a matched control. It also covers the fake agent's
  attacks, clean repeat runs and a lost runner. With `BLACKSAND_K8S_TOOLS_IMAGE` set,
  it runs the real Claude Code and Codex at their default models against a fake model
  backend. Codex edits with apply_patch, then runs a probe that may reach only its
  proxy. The file's header lists the environment it needs.

## Long-lived mode

`src/longlived.ts` is the interface for an always-on agent: create, attach, and stop,
on a persistent volume. It isn't implemented yet.
