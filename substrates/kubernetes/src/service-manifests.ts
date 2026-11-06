// Admin-owned service packaging. Separate labels/lifecycle from run cleanup;
// no sandbox RuntimeClass, Kubernetes authority or client-side upstream secret.
import { isIP } from "node:net";
import { assertPinned, UID } from "./manifests.ts";

type Obj = Record<string, unknown>;
export const SERVICE_LABEL = "run.blacksand.service";
export interface ServiceManifestInput {
  name: string;
  namespace: string;
  image: string;
  client: { namespace: string; labels: Record<string, string> };
  port: number;
  config: string;
  code: { "proxy.ts": string; "service.ts": string; "service-policy.ts": string; "policy.ts": string; "audit.ts": string };
  /** Existing admin-provisioned volumes. No Secret data is emitted. */
  secrets: { name: string; mount: string }[];
  controlConfigMap: string;
  auditClaim: string;
  /** Exact resolved upstream IPs; admins update these when DNS changes. */
  destinations: { cidr: string; port: number }[];
  resolver: { namespace: string; labels: Record<string, string> };
}
export function serviceObjects(p: ServiceManifestInput): Obj[] {
  const name = /^[a-z][a-z0-9-]{0,62}$/;
  const port = (v: number) => Number.isInteger(v) && v >= 1024 && v <= 65535;
  if (![p.name, p.namespace, p.client.namespace, p.controlConfigMap, p.auditClaim, p.resolver.namespace].every((n) => name.test(n)) || !port(p.port) || !Object.keys(p.client.labels).length || !Object.keys(p.resolver.labels).length || p.destinations.some((d) => !port(d.port) || !isIP(d.cidr.split("/")[0] ?? "") || !/^(?:[0-9.]+\/32|[0-9a-f:]+\/128)$/.test(d.cidr)) || p.secrets.some((s) => !name.test(s.name) || !/^\/credentials\/[a-z][a-z0-9-]*$/.test(s.mount)) || new Set(p.secrets.map((s) => s.mount)).size !== p.secrets.length) throw new Error("invalid service manifests");
  const labels = { [SERVICE_LABEL]: p.name };
  const meta = { name: p.name, namespace: p.namespace, labels };
  const security = { runAsNonRoot: true, runAsUser: UID, runAsGroup: UID, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } };
  return [
    { apiVersion: "v1", kind: "Namespace", metadata: { name: p.namespace, labels: { "pod-security.kubernetes.io/enforce": "restricted", "pod-security.kubernetes.io/enforce-version": "latest" } } },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta, automountServiceAccountToken: false },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta, data: { ...p.code, "config.json": p.config } },
    {
      apiVersion: "apps/v1", kind: "Deployment", metadata: meta,
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
        serviceAccountName: p.name, automountServiceAccountToken: false, enableServiceLinks: false, terminationGracePeriodSeconds: 10,
        securityContext: { runAsNonRoot: true, runAsUser: UID, runAsGroup: UID, fsGroup: UID, seccompProfile: { type: "RuntimeDefault" } },
        initContainers: [{ name: "prepare-audit", image: assertPinned(p.image), command: ["node", "/app/src/service.ts", "prepare", "/app/config.json"], securityContext: security,
          resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { cpu: "1", memory: "128Mi" } },
          volumeMounts: [{ name: "code", mountPath: "/app", readOnly: true }, { name: "audit", mountPath: "/audit" }],
        }],
        containers: [{ name: "proxy", image: assertPinned(p.image), command: ["timeout", "-s", "TERM", "-k", "10", "930", "node", "/app/src/service.ts", "serve", "/app/config.json"], securityContext: security,
          ports: [{ name: "https", containerPort: p.port }], readinessProbe: { exec: { command: ["node", "-e", "const s=require('node:net').connect({host:'127.0.0.1',port:Number(process.argv[1])},()=>{s.destroy();process.exit(0)});s.setTimeout(1000,()=>process.exit(1));s.on('error',()=>process.exit(1));", String(p.port)] }, periodSeconds: 1, timeoutSeconds: 2 },
          resources: { requests: { cpu: "100m", memory: "64Mi", "ephemeral-storage": "8Mi" }, limits: { cpu: "1", memory: "256Mi", "ephemeral-storage": "32Mi" } },
          volumeMounts: [{ name: "code", mountPath: "/app", readOnly: true }, { name: "control", mountPath: "/control", readOnly: true }, { name: "audit", mountPath: "/audit" }, ...p.secrets.map((s, i) => ({ name: `secret-${i}`, mountPath: s.mount, readOnly: true }))],
        }],
        volumes: [{ name: "code", configMap: { name: p.name, items: Object.keys(p.code).map((key) => ({ key, path: key === "proxy.ts" ? `sandbox/${key}` : `src/${key}` })).concat([{ key: "config.json", path: "config.json" }]) } }, { name: "control", configMap: { name: p.controlConfigMap } }, { name: "audit", persistentVolumeClaim: { claimName: p.auditClaim } }, ...p.secrets.map((s, i) => ({ name: `secret-${i}`, secret: { secretName: s.name, defaultMode: 0o440 } }))],
      } } },
    },
    { apiVersion: "v1", kind: "Service", metadata: meta, spec: { selector: labels, ports: [{ name: "https", port: p.port, targetPort: "https" }] } },
    { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: meta, spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress", "Egress"],
      ingress: [{ from: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": p.client.namespace } }, podSelector: { matchLabels: p.client.labels } }], ports: [{ protocol: "TCP", port: p.port }] }],
      egress: [ ...p.destinations.map((d) => ({ to: [{ ipBlock: { cidr: d.cidr } }], ports: [{ protocol: "TCP", port: d.port }] })), { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": p.resolver.namespace } }, podSelector: { matchLabels: p.resolver.labels } }], ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] } ],
    } },
  ];
}
