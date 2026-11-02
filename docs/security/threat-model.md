# Threat model

> **Applies to:** the `blacksand` command and the Kubernetes environment.
> blacksand-t3 has its own [threat model](../../tooling/blacksand-t3/docs/security/threat-model.md).

This page says what Blacksand protects today, from whom, which code enforces each
control, and which test checks it. It describes only what's built. It also lists what
Blacksand doesn't protect against.

## What it protects

1. **The machine that runs the agents.** That's its kernel, its files, and the keys and
   credentials of the person who runs Blacksand.
2. **Credentials.** Model API keys and cloud credentials, which stay out of the sandbox.
3. **Everything on the network the agent wasn't granted.** That includes cluster DNS,
   the node, other Pods and Services, and private addresses.
4. **The results of a run.** The patch, the files a command produced, and the run
   record.
5. **Knowing what code you run.** `blacksand verify` says whether a clone is code the
   owner signed.

## Who it defends against

| Adversary | Starting position |
|---|---|
| A hostile or hijacked agent | runs any code inside its sandbox, with full access there. A prompt injection in something it reads counts as this. |
| A hostile repository or input | the task's repository, including its `.git`, or a command's input files |
| Someone with write access to the GitHub repository | can push commits, but doesn't hold the owner's signing key |
| A compromised evaluator key | can sign commits as the CI evaluator |

Blacksand assumes a prompt injection can succeed. Its controls limit what the agent can
reach and keep afterwards, whatever the agent was told to do.

## Controls

Kubernetes source paths are relative to `substrates/kubernetes/`, and its test files
are in `substrates/kubernetes/test/`. Paths that start with `src/trust/` or
`tooling/` are relative to the repository root.

| Threat | Control | Enforced in | Checked by |
|---|---|---|---|
| The agent reaches a host it wasn't granted | Three layers: the node's egress floor, a default-drop nftables rule set; NetworkPolicy; and the proxy, which needs the run token. Through the proxy, a CONNECT tunnel needs an exact host and port on the allowlist, and a name that resolves to a private address is refused unless granted as private. A model request needs the run's configured route and operation, and a granted model. | `src/node.ts`, `src/manifests.ts`, `sandbox/proxy.ts` | `manifests.test.ts`, `proxy.test.ts`, `policy.test.ts`, `journey.deep.test.ts` |
| The agent reads a credential | No key is mounted in the sandbox, by volume or environment. The proxy adds the key to each model request it allows. | `src/manifests.ts`, `sandbox/proxy.ts` | `full-access.test.ts`, `proxy.test.ts` |
| The agent sends the key somewhere else | The backend URL is the configured origin and the operation's own path, whatever the request named. Only listed headers reach the backend. A key that starts with another provider's known prefix is refused before the request leaves. Other key formats aren't recognised. | `sandbox/proxy.ts` | `proxy.test.ts` |
| The agent uses the model provider to act for it | The proxy checks and rebuilds each request body. It refuses provider-run tools, web and file search, MCP servers, remote files, background work, and OpenAI response storage (`store: true`). Prompt caching is allowed. | `sandbox/proxy.ts` | `body.test.ts` |
| The agent runs up cost or holds connections | A request budget; limits on concurrent requests, body and response sizes, and tunnels; and an expiry, after which the proxy refuses the token and seals itself | `sandbox/proxy.ts` | `proxy.test.ts`, `proxy-load.deep.test.ts` |
| The agent attacks the host kernel or escalates | gVisor; non-root containers with every capability dropped and no privilege escalation; no service-account token, hostPath volume, or host network, PID or IPC namespace | `src/manifests.ts` | `manifests.test.ts`, `full-access.test.ts` |
| One run reads another run's state | Each run gets a new Sandbox and Pod, with empty volumes | `src/manifests.ts`, `src/run.ts` | `journey.deep.test.ts` |
| The agent falsifies its patch | The patch is made outside the cluster, by a git the agent never touched, from the original base and an export of the workspace. Rewriting the sandbox's `.git` can't change the base. A new ignore rule can't hide a change to a file the base tracks. New files that match an ignore rule are left out of the patch. | `src/collect.ts` | `collect.test.ts` |
| A command's arguments run as shell code | The argv travels as data and runs through `exec`. No shell parses it. | `src/agents.ts`, `src/command.ts` | `command-run.test.ts` |
| A task launches twice after a crash | With a key, the runner claims the task in the receipts root on disk before it touches the cluster. A key claimed in that root never launches again. | `src/receipt.ts` | `receipt.test.ts` |
| A record claims more than happened | A record can't say "complete" without the evidence that earns it. The agent, proxy and tools images must be pinned by digest. | `src/record.ts` | `record.test.ts` |
| A lost runner leaves a sandbox running | Pod deadlines, the proxy's expiry, the Sandbox's shutdown time, and cleanup on the next `setup` or `run`. Cleanup deletes only objects it can tell are a run's, each by its UID. | `src/lifecycle.ts`, `src/run.ts` | `run.test.ts`, `journey.deep.test.ts` |
| You run a clone that isn't the owner's signed code | When you run it, `blacksand verify` checks that every commit is signed by a key in its first parent's `.allowed_signers`. The first commit is checked against its own list. This check doesn't stop the CLI from running. blacksand-t3's updater has its own check before it builds. | `src/trust/history.ts`, `src/trust/check.ts` | `tooling/blacksand-t3/test/commit-trust.deep.test.mjs` |
| A compromised evaluator key changes code | An evaluator commit may change only the pin file, only forward | `src/trust/evaluator.ts` | `src/trust/trust.test.ts`, `tooling/blacksand-t3/test/commit-trust.deep.test.mjs` |
| Files on disk aren't the verified commit's | `blacksand verify` compares every tracked file with the commit, by bytes and executable mode, and flags extra files that aren't ignored. Ignored files are listed but not checked. | `src/trust/worktree.ts` | `src/trust/trust.test.ts` |
| Git settings or the environment change what the check reads | Git runs with none of the environment's settings, agents or prompts, and sees no replaced or grafted commits | `src/trust/git.ts` | `src/trust/trust.test.ts` |

## What it doesn't protect against

- **Data the agent sends where it's allowed to.** That covers an allowlisted host, and the
  prompt and context the model provider receives.
- **The model backend you configure.** It receives the credential and every request.
  A route may use plain HTTP, which sends both unencrypted.
- **A gVisor or kernel escape.**
- **A compromised node, cluster admin, or runner machine.**
- **Anyone who can read the Sandbox.** It holds the run token, which works only against
  that run's proxy, and only until the run expires.
- **The agent's own output.** The patch is what the agent wrote. Review it before you
  apply it.
- **A clone you didn't anchor.** `blacksand verify` trusts the clone's first commit,
  which names its own key. Put the clone at a commit you trust before you rely on the
  check ([cloning](../../tooling/blacksand-t3/docs/install/clone.md)). Nothing yet keeps that
  key outside the clone. The standalone binary has no anchor at all, so its `verify`
  refuses.
- **The machine's applied state.** Nothing applies a configuration yet. `blacksand
  verify` reports its checks, then always ends "not verified" and exits 4.

## Limits of what's built

- The egress floor works on one k3s node only. It uses node-local networking and
  k3s-specific configuration, and the node label it relies on is ordinary metadata that
  a cluster admin can set. Several nodes and EKS aren't supported.
- Receipts prevent a second launch only within one receipts root. Keep that root on
  durable disk across retries. Separate roots, on one runner or several, don't
  coordinate.
- Long-lived agents aren't built.
- Tests on a local cluster are development evidence. Claims for EKS need their own
  tests on a real EKS cluster.

## Each component's own details

- blacksand-t3: [threat model](../../tooling/blacksand-t3/docs/security/threat-model.md)
- The Kubernetes environment:
  [what it protects against](../../substrates/kubernetes/README.md#what-it-protects-against)
