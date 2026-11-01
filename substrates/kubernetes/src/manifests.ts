// The Kubernetes objects for the substrate and for each run, as plain data.
// Nothing here talks to a cluster, so the tests compare these objects directly.
//
// Per run, with id `<hex>` (hyphen-free names: EKS's policy agent groups Pods
// by name up to the last hyphen):
//   egress namespace: ConfigMap and Pod `p<hex>` (the proxy, holding the route
//     credential), and a NetworkPolicy letting only this run's sandbox in.
//   runs namespace: NetworkPolicy `s<hex>` letting the sandbox reach only its
//     proxy, ConfigMap `s<hex>` (the run's inputs, read-only), Sandbox `s<hex>`.
// Every one carries the run label and its deadline, so `setup` and `run` can
// delete whatever a lost runner left behind.

import { FLOOR, FLOOR_ID } from "./node.ts";
import { PORTS, secretMount, type RouteSpec } from "./policy.ts";

export const NS = { runs: "blacksand-runs", egress: "blacksand-egress" } as const;
export const LABEL = { run: "blacksand-run", role: "blacksand-role" } as const;
/** Annotation on every run object: when it's past its life (seconds since the epoch). */
export const DEADLINE = "blacksand-deadline";
export const SANDBOX_API = "agents.x-k8s.io/v1beta1";
export const UID = 1000;

type Obj = Record<string, unknown>;

const DIGEST_PINNED = /^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$/;

export class ManifestError extends Error {}

export function assertPinned(image: string): string {
  if (!DIGEST_PINNED.test(image)) throw new ManifestError(`image ${JSON.stringify(image)} isn't pinned by digest (registry/name@sha256:…)`);
  return image;
}

export interface RunNames {
  id: string;
  sandbox: string;
  proxy: string;
}

export function runNames(id: string): RunNames {
  if (!/^[0-9a-f]{12}$/.test(id)) throw new ManifestError(`run id ${JSON.stringify(id)} isn't 12 hex digits`);
  return { id, sandbox: `s${id}`, proxy: `p${id}` };
}

const labels = (id: string, role: string) => ({ [LABEL.run]: id, [LABEL.role]: role });

/** Every container runs like this: non-root, nothing to escalate to, no writes outside its volumes. */
const containerSecurity = {
  runAsNonRoot: true,
  runAsUser: UID,
  runAsGroup: UID,
  allowPrivilegeEscalation: false,
  readOnlyRootFilesystem: true,
  capabilities: { drop: ["ALL"] },
  seccompProfile: { type: "RuntimeDefault" },
};

const podBasics = {
  automountServiceAccountToken: false,
  enableServiceLinks: false,
  restartPolicy: "Never",
  terminationGracePeriodSeconds: 1,
  securityContext: { runAsNonRoot: true, runAsUser: UID, runAsGroup: UID, fsGroup: UID, seccompProfile: { type: "RuntimeDefault" } },
};

/**
 * Cluster setup, applied once by an admin: the two namespaces under the
 * `restricted` Pod Security level (the API server itself refuses a Pod that
 * could run as root or escalate), default-deny in the runs namespace, no
 * ingress to the egress namespace except what a run allows, and the two
 * RuntimeClasses, which schedule only onto nodes carrying this egress floor.
 */
export function setupObjects(): Obj[] {
  const namespace = (name: string): Obj => ({
    apiVersion: "v1",
    kind: "Namespace",
    metadata: { name, labels: { "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "latest" } },
  });
  const deny = (ns: string, types: string[]): Obj => ({
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: { name: "default-deny", namespace: ns },
    spec: { podSelector: {}, policyTypes: types },
  });
  const runtime = (name: string): Obj => ({ apiVersion: "node.k8s.io/v1", kind: "RuntimeClass", metadata: { name }, handler: name, scheduling: { nodeSelector: { [FLOOR.label]: FLOOR_ID } } });
  return [namespace(NS.runs), namespace(NS.egress), runtime(FLOOR.runtimes.sandbox), runtime(FLOOR.runtimes.proxy), deny(NS.runs, ["Ingress", "Egress"]), deny(NS.egress, ["Ingress"])];
}

export interface ProxyInput {
  names: RunNames;
  image: string;
  /** The proxy's source and its config, as files. */
  files: { "proxy.ts": string; "config.json": string };
  route: RouteSpec;
  /** The Pod's own lifetime, enforced by the kubelet whatever happens to the runner. */
  deadlineSeconds: number;
  /** Seconds since the epoch, for reconciliation. */
  deadline: number;
}

export function proxyObjects({ names, image, files, route, deadlineSeconds, deadline }: ProxyInput): Obj[] {
  const meta = (name: string) => ({ name, namespace: NS.egress, labels: labels(names.id, "proxy"), annotations: { [DEADLINE]: String(deadline) } });
  const secret = `secret-${route.kind}`;
  return [
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta(names.proxy), data: files },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: meta(names.proxy),
      spec: {
        ...podBasics,
        runtimeClassName: FLOOR.runtimes.proxy,
        activeDeadlineSeconds: deadlineSeconds,
        terminationGracePeriodSeconds: 5,
        containers: [
          {
            name: "proxy",
            image: assertPinned(image),
            command: ["node", "/proxy/proxy.ts", "/proxy/config.json"],
            securityContext: containerSecurity,
            resources: { requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "16Mi" }, limits: { cpu: "1", memory: "256Mi", "ephemeral-storage": "64Mi" } },
            readinessProbe: { tcpSocket: { port: PORTS.model }, periodSeconds: 1 },
            volumeMounts: [
              { name: "proxy", mountPath: "/proxy", readOnly: true },
              { name: secret, mountPath: secretMount(route.kind), readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "proxy", configMap: { name: names.proxy, defaultMode: 0o444 } },
          { name: secret, secret: { secretName: route.secret, defaultMode: 0o400, items: [{ key: "key", path: "key" }] } },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta(names.proxy),
      spec: {
        podSelector: { matchLabels: labels(names.id, "proxy") },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.runs } }, podSelector: { matchLabels: labels(names.id, "sandbox") } }],
            ports: [{ protocol: "TCP", port: PORTS.connect }, { protocol: "TCP", port: PORTS.model }],
          },
        ],
      },
    },
  ];
}

/**
 * The egress tripwire: the sandbox Pod's init container tries one direct
 * connection to the canary (cluster DNS over TCP, reachable from any Pod the
 * floor doesn't hold) and reports what happened. It always exits 0 and
 * authorises nothing: a refused or timed-out canary proves nothing, but a
 * canary it *reaches* proves the floor isn't in effect, and the run stops.
 */
export const TRIPWIRE_SCRIPT = [
  'const net = require("node:net");',
  "const [host, port] = [process.env.CANARY_HOST, Number(process.env.CANARY_PORT)];",
  "const report = (reached, error) => { console.log(JSON.stringify({ canary: `${host}:${port}`, reached, error })); process.exit(0); };",
  "const s = net.connect({ host, port, timeout: 2000 });",
  's.on("connect", () => (s.destroy(), report(true, null)));',
  's.on("timeout", () => (s.destroy(), report(false, "timeout")));',
  's.on("error", (e) => report(false, e.code ?? "error"));',
].join("\n");

export const TOOLS_MOUNT = "/opt/agent-tools";
/** The agent's HOME: its own empty volume, like /tmp and the workspace. */
export const HOME_MOUNT = "/home/agent";

export interface SandboxInput {
  names: RunNames;
  image: string;
  /** An image holding the agent's binaries, mounted read-only at TOOLS_MOUNT; null for none. */
  toolsImage: string | null;
  /** The tripwire's image (node) and its canary. */
  tripwire: { image: string; canary: { host: string; port: number } };
  /** Files under /run/blacksand/inputs, read-only to the agent. */
  inputs: Record<string, string>;
  env: Record<string, string>;
  /** The Pod's own deadline, enforced by the kubelet even if the runner is gone. */
  deadlineSeconds: number;
  /** When the controller deletes the Sandbox, a backstop for the runner's own teardown. */
  shutdownTime: string;
  /** Seconds since the epoch, for reconciliation. */
  deadline: number;
}

export function sandboxObjects({ names, image, toolsImage, tripwire, inputs, env, deadlineSeconds, shutdownTime, deadline }: SandboxInput): Obj[] {
  const meta = { name: names.sandbox, namespace: NS.runs, labels: labels(names.id, "sandbox"), annotations: { [DEADLINE]: String(deadline) } };
  return [
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta,
      spec: {
        podSelector: { matchLabels: labels(names.id, "sandbox") },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.egress } }, podSelector: { matchLabels: labels(names.id, "proxy") } }],
            ports: [{ protocol: "TCP", port: PORTS.connect }, { protocol: "TCP", port: PORTS.model }],
          },
        ],
      },
    },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta, data: inputs },
    {
      apiVersion: SANDBOX_API,
      kind: "Sandbox",
      metadata: meta,
      spec: {
        shutdownTime,
        shutdownPolicy: "Delete",
        failedPodPolicy: "Retain",
        podTemplate: {
          // The Pod the controller makes carries the run's deadline too, so it reads as alive for as long as the Sandbox does.
          metadata: { labels: labels(names.id, "sandbox"), annotations: { [DEADLINE]: String(deadline) } },
          spec: {
            ...podBasics,
            runtimeClassName: FLOOR.runtimes.sandbox,
            activeDeadlineSeconds: deadlineSeconds,
            initContainers: [
              {
                name: "tripwire",
                image: assertPinned(tripwire.image),
                command: ["node", "-e", TRIPWIRE_SCRIPT],
                env: [{ name: "CANARY_HOST", value: tripwire.canary.host }, { name: "CANARY_PORT", value: String(tripwire.canary.port) }],
                securityContext: containerSecurity,
                resources: { requests: { cpu: "50m", memory: "32Mi" }, limits: { cpu: "500m", memory: "128Mi" } },
              },
            ],
            containers: [
              {
                name: "agent",
                image: assertPinned(image),
                command: ["sleep", "infinity"],
                workingDir: "/workspace",
                env: Object.entries(env).map(([name, value]) => ({ name, value })),
                securityContext: containerSecurity,
                resources: { requests: { cpu: "500m", memory: "512Mi" }, limits: { cpu: "2", memory: "2Gi", "ephemeral-storage": "6Gi" } },
                volumeMounts: [
                  { name: "workspace", mountPath: "/workspace" },
                  { name: "scratch", mountPath: "/tmp" },
                  { name: "home", mountPath: HOME_MOUNT },
                  { name: "inputs", mountPath: "/run/blacksand/inputs", readOnly: true },
                  ...(toolsImage ? [{ name: "tools", mountPath: TOOLS_MOUNT, readOnly: true }] : []),
                ],
              },
            ],
            volumes: [
              { name: "workspace", emptyDir: { sizeLimit: "4Gi" } },
              { name: "scratch", emptyDir: { sizeLimit: "2Gi" } },
              { name: "home", emptyDir: { sizeLimit: "1Gi" } },
              { name: "inputs", configMap: { name: names.sandbox, defaultMode: 0o444 } },
              ...(toolsImage ? [{ name: "tools", image: { reference: assertPinned(toolsImage), pullPolicy: "IfNotPresent" } }] : []),
            ],
          },
        },
      },
    },
  ];
}

/** A List kubectl can create in one call. */
export const list = (items: Obj[]): Obj => ({ apiVersion: "v1", kind: "List", items });
