// Native-test fixtures in a real cluster: the fake model backend (its own Pod,
// Secret and ingress policy in the egress namespace, reachable only from run
// proxies), and the cluster reached through BLACKSAND_KUBECTL.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";

import { getJson, kubectlPrefix, must, processKubectl, type Kubectl } from "../../src/kubectl.ts";
import { LABEL, NS, UID, list } from "../../src/manifests.ts";
import { FLOOR } from "../../src/node.ts";

export const FAKE_MODEL = { name: "fakemodel", secret: "fake-model-key" } as const;

export const labKubectl = (): Kubectl => processKubectl(kubectlPrefix(process.env.BLACKSAND_KUBECTL));

/** Deploys the fake model backend with a fresh key; returns its URL and the key (the test checks it never reaches a sandbox). */
export async function deployFakeModel(kubectl: Kubectl, image: string): Promise<{ upstream: string; ipv6: string; key: string }> {
  const key = `fake-${randomBytes(24).toString("hex")}`;
  const labels = { [LABEL.role]: "fake-model" };
  const meta = { name: FAKE_MODEL.name, namespace: NS.egress, labels };
  const security = { runAsNonRoot: true, runAsUser: UID, runAsGroup: UID, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } };
  const objects = [
    { apiVersion: "v1", kind: "Secret", metadata: { ...meta, name: FAKE_MODEL.secret }, stringData: { key } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta, data: { "fake-model.ts": fs.readFileSync(new URL("fake-model.ts", import.meta.url), "utf8") } },
    {
      apiVersion: "v1",
      kind: "Pod",
      metadata: meta,
      spec: {
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        restartPolicy: "Never",
        terminationGracePeriodSeconds: 1,
        securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
        containers: [
          {
            name: "model",
            image,
            command: ["node", "/code/fake-model.ts", "/key/key"],
            // The fake logs each request's headers and body, so tests can see exactly what an agent sends.
            env: [{ name: "FAKE_MODEL_BODIES", value: "1" }],
            securityContext: security,
            readinessProbe: { tcpSocket: { port: 8080 }, periodSeconds: 1 },
            volumeMounts: [
              { name: "code", mountPath: "/code", readOnly: true },
              { name: "key", mountPath: "/key", readOnly: true },
            ],
          },
        ],
        volumes: [
          { name: "code", configMap: { name: FAKE_MODEL.name } },
          { name: "key", secret: { secretName: FAKE_MODEL.secret } },
        ],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta,
      spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: { matchLabels: { [LABEL.role]: "proxy" } } }], ports: [{ protocol: "TCP", port: 8080 }] }] },
    },
  ];
  await removeFakeModel(kubectl);
  await must(kubectl, ["create", "-f", "-"], { stdin: JSON.stringify(list(objects)) });
  await must(kubectl, ["wait", "--for=condition=Ready", `pod/${FAKE_MODEL.name}`, "-n", NS.egress, "--timeout=180s"], { timeoutMs: 190_000 });
  const pod = await getJson<{ status: { podIPs: { ip: string }[] } }>(kubectl, ["get", "pod", FAKE_MODEL.name, "-n", NS.egress]);
  const ip = pod.status.podIPs.map((p) => p.ip).find((a) => !a.includes(":"));
  const ipv6 = pod.status.podIPs.map((p) => p.ip).find((a) => a.includes(":")) ?? "";
  return { upstream: `http://${ip}:8080`, ipv6, key };
}

export async function removeFakeModel(kubectl: Kubectl): Promise<void> {
  await must(kubectl, ["delete", "pod,configmap,secret,networkpolicy", "-n", NS.egress, "-l", `${LABEL.role}=fake-model`, "--ignore-not-found", "--wait=true", "--timeout=60s"], { timeoutMs: 70_000 });
}

export interface ProbeResult {
  target: string;
  /** Connections that opened, out of `tries`. */
  connected: number;
  tries: number;
  /** How long after the process started the first one opened, if any did. */
  first_ms: number | null;
  last_error: string | null;
}

export interface ProbeOptions {
  name: string;
  namespace: string;
  image: string;
  targets: string[];
  /** Runs it on this RuntimeClass (the floor's, to test the floor). */
  runtimeClass?: string;
  labels?: Record<string, string>;
  /** How long it keeps trying every target, from its first instruction (every 20 ms). */
  durationMs: number;
}

/**
 * A Pod that tries every target over and over from its very first
 * instruction, then reports. On the floor's RuntimeClass with no
 * NetworkPolicy anywhere near it, it measures the floor alone; on the plain
 * runtime it's the control that shows each target is there to be reached.
 */
export async function probePod(kubectl: Kubectl, o: ProbeOptions): Promise<ProbeResult[]> {
  const script = [
    'const net = require("node:net");',
    `const targets = ${JSON.stringify(o.targets)};`,
    "const start = Date.now();",
    "const results = targets.map((target) => ({ target, connected: 0, tries: 0, first_ms: null, last_error: null }));",
    "const once = (r) => new Promise((resolve) => { const at = r.target.lastIndexOf(':'); const s = net.connect({ host: r.target.slice(0, at), port: Number(r.target.slice(at + 1)), timeout: 1000 }); r.tries++;",
    "  s.on('connect', () => { r.connected++; if (r.first_ms === null) r.first_ms = Date.now() - start; s.destroy(); resolve(); });",
    "  s.on('timeout', () => { r.last_error = 'timeout'; s.destroy(); resolve(); });",
    "  s.on('error', (e) => { r.last_error = e.code || e.message; resolve(); }); });",
    `const loop = async (r) => { while (Date.now() - start < ${o.durationMs}) { await once(r); await new Promise((w) => setTimeout(w, 20)); } };`,
    "Promise.all(results.map(loop)).then(() => console.log(JSON.stringify(results)));",
  ].join("\n");
  const pod = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name: o.name, namespace: o.namespace, labels: { probe: "true", ...o.labels } },
    spec: {
      ...(o.runtimeClass ? { runtimeClassName: o.runtimeClass } : {}),
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 1,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "probe", image: o.image, command: ["node", "-e", script], securityContext: { runAsNonRoot: true, runAsUser: UID, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } } }],
    },
  };
  await must(kubectl, ["delete", "pod", o.name, "-n", o.namespace, "--ignore-not-found", "--wait=true"]);
  await must(kubectl, ["create", "-f", "-"], { stdin: JSON.stringify(pod) });
  try {
    for (let i = 0; ; i++) {
      const { status } = await getJson<{ status: { phase?: string } }>(kubectl, ["get", "pod", o.name, "-n", o.namespace]);
      if (status.phase === "Succeeded") break;
      if (status.phase === "Failed" || i > 600) throw new Error(`probe ${o.name} is ${status.phase ?? "unknown"}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return JSON.parse((await must(kubectl, ["logs", o.name, "-n", o.namespace])).toString()) as ProbeResult[];
  } finally {
    await must(kubectl, ["delete", "pod", o.name, "-n", o.namespace, "--ignore-not-found", "--wait=true"]);
  }
}

/**
 * Listeners for testing the floor alone: one on the proxy network (3128 and
 * 8080, which the floor admits from sandboxes, and 9090, which it doesn't),
 * one on the cluster's ordinary network (IPv4 and IPv6), which no sandbox may reach.
 */
export async function floorTargets(kubectl: Kubectl, namespace: string, image: string): Promise<{ proxyNet: string; plainV4: string; plainV6: string }> {
  const pod = (name: string, runtimeClass: string | null) => ({
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace, labels: { probe: "true" } },
    spec: {
      ...(runtimeClass ? { runtimeClassName: runtimeClass } : {}),
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      restartPolicy: "Never",
      terminationGracePeriodSeconds: 1,
      securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
      containers: [
        {
          name: "listen",
          image,
          command: ["node", "-e", "const n=require('node:net');for(const p of [3128,8080,9090])n.createServer((c)=>{c.on('error',()=>{});c.end()}).listen(p,'::')"],
          readinessProbe: { tcpSocket: { port: 9090 }, periodSeconds: 1 },
          securityContext: { runAsNonRoot: true, runAsUser: UID, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        },
      ],
    },
  });
  await must(kubectl, ["create", "-f", "-"], { stdin: JSON.stringify(list([pod("proxynet", FLOOR.runtimes.proxy), pod("plainnet", null)])) });
  await must(kubectl, ["wait", "--for=condition=Ready", "pod/proxynet", "pod/plainnet", "-n", namespace, "--timeout=120s"], { timeoutMs: 130_000 });
  const ips = async (name: string) => (await getJson<{ status: { podIPs: { ip: string }[] } }>(kubectl, ["get", "pod", name, "-n", namespace])).status.podIPs.map((p) => p.ip);
  const [proxyNet] = await ips("proxynet");
  const plain = await ips("plainnet");
  return { proxyNet: proxyNet ?? "", plainV4: plain.find((ip) => !ip.includes(":")) ?? "", plainV6: plain.find((ip) => ip.includes(":")) ?? "" };
}
