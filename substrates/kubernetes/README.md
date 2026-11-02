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

The `command` adapter runs a fixed command instead of an agent, and returns the files
it wrote. With a caller's `--key`, the output directory is a durable receipt, so one
key never launches twice.

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
   on stdin. A command run makes no bundle and clones nothing. Its argv runs in
   `/workspace`, with stdin empty.
6. **Freeze, export, seal.** Blacksand kills every agent process. It exports the
   workspace's files as a tar, without `.git`. Hard links are dereferenced, so every
   name carries its bytes. Then it seals the proxy, which closes the proxy's audit log.
7. **Teardown.** Teardown always runs, after a cancellation too. If the runner is lost,
   four backstops remain: both Pods' `activeDeadlineSeconds`, the proxy's own expiry,
   the Sandbox's `shutdownTime`, and the next `setup` or `run`, which deletes expired
   runs.
8. **Patch and record.** Outside the cluster, a git the agent never touched makes the
   patch, from the original base and the export. Blacksand checks the whole audit log:
   every entry numbered, the log sealed, and every request ended. For a command run,
   Blacksand instead copies the files out of the export, each with its digest.

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
The `command` adapter is registered like the others, so the test checks its Pod's
lockdown too.

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
administers the cluster can set it, not only root on the node. The floor also uses
node-local networking and k3s-specific configuration. Several nodes, or EKS, need more
than a protected `node-restriction.kubernetes.io/` label, so they aren't supported yet.

Then, once per cluster, as an admin:

```sh
export BLACKSAND_KUBECTL='["kubectl","--context","lab"]'   # or a prefix that reaches the cluster
./blacksand k8s setup        # namespaces, RuntimeClasses, default-deny; deletes expired runs;
                             # provisions the receipts root (--receipts DIR) on this runner
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
| `--agent fake\|claude\|codex\|command` | The adapter. `fake` is for tests: it edits a file, makes allowed and denied calls, and attacks the proxy and its own git. `command` runs `--argv` with `--input` files. See [The command adapter](#the-command-adapter). |
| `--route KIND=URL@SECRET` | The model route. `anthropic` uses the Messages API and sends the credential as `x-api-key`. `openai` uses the Responses API and sends it as `Authorization: Bearer`. The URL is an origin, with an optional path prefix. |
| `--model ID`, `--grant-model ID …` | The agent's model, and any other models the run may name. The proxy refuses every other model. The default is `gpt-6.1-sol` for codex and `claude-sonnet-5-5` for claude. `fake` needs one. |
| `--allow HOST:PORT` | One exact entry in the CONNECT allowlist. Wildcards and IP literals aren't accepted. A name that resolves to a private address is refused unless you give it with `--allow-private`. |
| `--image`, `--tools-image`, `--proxy-image` | Images, each pinned by digest. The agent and proxy default to Node 24.22.2 images: Debian bookworm for the agent, because it has git, and Alpine for the proxy. Claude and Codex need a tools image, or an `--image` that has their binary. |
| `--timeout SECONDS` | The agent's time limit, 1800 by default. Everything in the run expires 300 seconds after it. |
| `--max-model-requests N` | The proxy's request budget for the run: 2000 by default, at most 100000. Past it, the proxy refuses model requests. |
| `--key KEY` | Your own ID for the run, copied into the record. The output directory becomes the key's receipt. See [Receipts](#receipts-one-launch-per-key). Use it instead of `--out`. |
| `--receipts DIR` | Where receipts live. The default is `$BLACKSAND_RECEIPTS`, else `$XDG_STATE_HOME/blacksand/k8s-receipts`. |

Exit code 0 means the run completed with all its evidence, the agent exited 0, and
Blacksand verified the cleanup. Anything else exits 4. Ctrl-C cancels the run. Teardown
still runs, and the record says `cancelled`.

## The command adapter

```sh
./blacksand k8s run --agent command \
  --argv '["python3","-I","inputs/refunds/attempt.py"]' \
  --input refunds/attempt.py=stage/refunds/attempt.py --input case.json=stage/case.json \
  --image registry.example/attempt-runtime@sha256:… \
  --key attempt/case-7/repeat-2 --json
```

- **What runs.** The command runs the argv you give as one JSON list. No shell parses
  it. The runner writes each argument to its own read-only input file (`argv.0`, …).
  The adapter's fixed `agent.sh` reads them back whole and passes the list to `exec`,
  with no `eval`, word splitting or globbing. A command run has no agent, prompt or
  repository. The command runs in `/workspace` as UID 1000, with stdin empty and its
  own empty HOME and `/tmp`.
- **Inputs.** Blacksand mounts each `--input PATH=FILE` read-only, byte for byte, at
  `/workspace/inputs/PATH`. With no inputs, `/workspace/inputs` is still an empty
  read-only mount, so nothing the command writes can land there. PATH must be relative
  and made of plain segments, and no segment may start with a dot. Inputs travel in
  the run's ConfigMap, so together they're limited to 768 KiB and 1000 files.
  Kubernetes projects each file from that ConfigMap, so its name is a symlink into a
  timestamped directory beside it.
- **Output.** The output is every regular file the command leaves under `/workspace`,
  apart from its inputs. Blacksand exports the workspace as a tar, with hard links
  dereferenced, and reads the tar outside the sandbox. The runner copies each file to
  `files/PATH` in the output directory and lists it in `result.files` with its
  SHA-256. It skips symlinks, devices, `..` paths and `.git` paths, never follows
  them, and counts them in `result.skipped_entries`. The run fails on a hard-link
  entry, on more than 10,000 files, or on two paths that would be one file on a
  case-insensitive disk. The runner keeps stdout and stderr as `agent.stdout` and
  `agent.stderr`. A command run makes no patch.
- **The model route is optional.** With no `--route`, the proxy's model listener has
  an empty route table, so it refuses every model request. Blacksand mounts no
  credential in the proxy, and the sandbox's environment names no model. With
  `--route KIND=URL@SECRET --model ID`, the run gets that one route and grant, as an
  agent run does. `--allow` works the same either way.
- **The record.** It says what ran: `command.argv_sha256` (the SHA-256 of
  `JSON.stringify(argv)`), `command.inputs` (each input path's SHA-256), the image as
  requested and as resolved, the Sandbox's and Pod's UIDs, the runtime class, and
  `run.request_sha256`.

## Receipts: one launch per key

With `--key KEY`, the output directory is the key's receipt:
`<receipts>/<sha256(KEY)>`. The receipts root is `--receipts DIR`, else
`$BLACKSAND_RECEIPTS`, else `$XDG_STATE_HOME/blacksand/k8s-receipts`
(`~/.local/state/…`). Keep it on the runner's durable disk. You can't give both
`--key` and `--out`.

**Provision the root once.** Run `k8s setup` on the runner, with the same `--receipts`
or `BLACKSAND_RECEIPTS`. Setup makes each missing directory and syncs its name into
its parent. Only then does it write a `READY` marker in the root. A run never creates
the root, and it refuses a root without `READY`. So every claim sits in a directory
that a crash can't lose, even while another setup is still running or after one died.
Running setup again completes a root that a dead setup left without `READY`.

- **The claim.** The runner claims a key by making the key's directory with a single
  `mkdir`, without checking first. However many runner processes try, exactly one
  makes it. Before the run touches the cluster, the runner writes `claim.json` and
  syncs it to disk. The claim holds the key, the digest of the whole request, the
  run's id and its deadline. The runner writes every file completely. When a write is
  short, it writes the rest.
- **The record.** The runner renames `record.json` into place last, after it syncs
  the files the record names, and before the run reports anything.
- **Nothing deletes a receipt.** Teardown and reconcile act only on cluster objects.

| `k8s status --key KEY [--json]` | Meaning | `k8s run` with the same key |
|---|---|---|
| `completed`, with the record | The run ended, whatever its status. A failed record is final too. | With the same request, it returns the record and launches nothing. With a changed request, it refuses with `request-changed`. |
| `claimed`, with no record | **Unknown.** The runner stopped after its claim and before its record. Never relaunch it. | It refuses with `claimed`, or with `request-changed` if the request changed. |
| `unclaimed` | There's no receipt. | It runs. |

For a claimed key, `status` also reports the claim's deadline, whether this runner's
clock has passed it, and the run's objects still in the cluster. These facts don't
prove that the run can no longer act. A runner process paused after its claim can
still create the run's objects later, and the cluster's clock isn't the runner's. So a
caller can't conclude "not performed" from them.

**One runner per cluster.** Blacksand assumes one runner per cluster. Receipts live on
that runner's disk, so a second runner with its own receipts could launch the same
key. The request digest counts a local repository by its path, not by its commit. The
record's `source.base` says which commit ran.

## What it protects against

- **The host kernel, mostly.** gVisor intercepts the agent's syscalls.
- **Other runs' files.** Each run gets new, empty volumes, and a new Sandbox and Pod.
- **Model and cloud credentials.** Only the proxy holds them. It uses them for one
  operation, for the granted models, and only until the run expires.
- **Provider-side work for the run.** The proxy checks and rebuilds the request body
  before it reads the key. The body may carry only local tools, wherever the request
  offers them: functions, custom tools, namespaces of those, and client-run tool search.
  The proxy refuses web search, file search, MCP servers, remote files or URLs, other
  responses or conversations, background work, and OpenAI response storage
  (`store: true`). It also refuses any beta feature Claude Code doesn't use. Prompt
  caching is allowed, and the provider's own retention policy still applies.
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
- the run orchestration against a scripted kubectl;
- the command adapter: its argv through `sh` and `dash` with hostile arguments, its
  inputs, its file collection (hard links, symlinks, case collisions), and refused specs;
- receipts: six runner processes racing for one key, a runner killed between its claim
  and its record, a setup still running, changed requests, and cleanup that never
  touches a receipt.

Deep:

- `test/proxy-load.deep.test.ts` sends a 200-request burst against the limits.
- `test/journey.deep.test.ts` runs against a real cluster. It covers the floor alone,
  without NetworkPolicy, against a matched control. It also covers the fake agent's
  attacks, clean repeat runs and a lost runner. With `BLACKSAND_K8S_TOOLS_IMAGE` set,
  it runs the real Claude Code and Codex at their default models against a fake model
  backend. Codex edits with apply_patch, then runs a probe that may reach only its
  proxy. It also runs a command under a receipt, with argv as data, read-only inputs, a
  hard link, and no model route. The file's header lists the environment it needs.

## Long-lived mode

`src/longlived.ts` is the interface for an always-on agent: create, attach, and stop,
on a persistent volume. It isn't implemented yet.
