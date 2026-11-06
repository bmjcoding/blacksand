import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServiceConfig } from "../src/service-policy.ts";
import { serviceObjects, SERVICE_LABEL } from "../src/service-manifests.ts";

export const config = () => ({ schema: "run.blacksand.service-proxy/1", service: "eevie", listen: { host: "127.0.0.1", port: 8443, authority: "proxy.test:8443", cert_file: "/credentials/tls/cert", key_file: "/credentials/tls/key" }, control_file: "/control/epoch.json", audit_dir: "/audit", max_segments: 8, limits: { request_seconds: 10 }, models: [], endpoints: [{ name: "plugin", url: "https://plugin.test/", private: true, ca_file: null, auth: { kind: "bearer", token_file: "/credentials/plugin/token", audience: "urn:plugin", issuer: "https://issuer.test/", subject: "eevie", scopes: ["plugin.call"] }, operations: [{ id: "call", method: "POST", path: "/v1/call", body: { fields: ["actor", "case"], required: ["actor", "case"], values: { actor: ["expert-1"] }, prefixes: {} } }] }] });

test("service config is closed, exact, HTTPS-only, bounded and separate from run defaults", () => {
  const c = parseServiceConfig(config());
  assert.equal(c.models.length, 0);
  assert.equal(c.endpoints[0]!.operations[0]!.query, false);
  const mutations = [
    (v: any) => { v.extra = true; }, (v: any) => { v.endpoints[0].url = "http://plugin.test/"; },
    (v: any) => { v.endpoints[0].url = "https://plugin.test/a/../"; }, (v: any) => { v.endpoints[0].url = "https://user:secret@plugin.test/"; },
    (v: any) => { v.endpoints[0].operations[0].path = "/v1/**"; }, (v: any) => { v.endpoints[0].operations[0].query = true; },
    (v: any) => { v.endpoints[0].operations.push(v.endpoints[0].operations[0]); }, (v: any) => { v.endpoints[0].auth.kind = "public"; },
    (v: any) => { v.limits.request_seconds = 121; }, (v: any) => { v.limits.audit_bytes = 100; }, (v: any) => { v.control_file = "relative"; },
    (v: any) => { v.endpoints[0].auth.scopes = []; }, (v: any) => { v.models = [{ name: "openai", url: "https://model.test/", private: false, ca_file: null, secret_file: "/key", models: [] }]; },
  ];
  for (const change of mutations) { const v = config(); change(v); assert.throws(() => parseServiceConfig(v)); }
});

test("service manifests isolate lifecycle, authority, audit and exact combined ingress peers", () => {
  const p = { name: "eevie-proxy", namespace: "blacksand-services", image: `registry.test/proxy@sha256:${"a".repeat(64)}`, client: { namespace: "eevie", labels: { "app.kubernetes.io/name": "eevie" } }, port: 8443, config: "{}", code: { "proxy.ts": "", "service.ts": "", "service-policy.ts": "", "policy.ts": "", "audit.ts": "" }, secrets: [{ name: "tls", mount: "/credentials/tls" }], controlConfigMap: "eevie-epoch", auditClaim: "eevie-audit", destinations: [{ cidr: "10.1.2.3/32", port: 8444 }], resolver: { namespace: "kube-system", labels: { "k8s-app": "kube-dns" } } };
  const objects = serviceObjects(p) as any[];
  const deployment = objects.find((o) => o.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  assert.equal(deployment.spec.strategy.type, "Recreate");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.runtimeClassName, undefined);
  assert.equal(pod.containers[0].env, undefined);
  assert.deepEqual(pod.containers[0].command.slice(0, 7), ["timeout", "-s", "TERM", "-k", "10", "930", "node"]);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(pod.volumes.find((v: any) => v.name === "audit").persistentVolumeClaim.claimName, "eevie-audit");
  const policy = objects.find((o) => o.kind === "NetworkPolicy");
  assert.deepEqual(policy.spec.ingress[0].from, [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "eevie" } }, podSelector: { matchLabels: p.client.labels } }]);
  assert.deepEqual(policy.spec.podSelector, { matchLabels: { [SERVICE_LABEL]: "eevie-proxy" } });
  assert.ok(!JSON.stringify(objects).includes("blacksand-run"));
  assert.ok(!objects.some((o) => /Role|RoleBinding/.test(o.kind)));
  assert.throws(() => serviceObjects({ ...p, client: { namespace: "eevie", labels: {} } }));
  assert.throws(() => serviceObjects({ ...p, destinations: [{ cidr: "0.0.0.0/0", port: 443 }] }));
});
