import assert from "node:assert/strict";
import { test } from "node:test";

import { DEADLINE, LABEL, NS, TRIPWIRE_SCRIPT, assertPinned, proxyObjects, runNames, sandboxObjects, setupObjects } from "../src/manifests.ts";
import { FLOOR, FLOOR_FILES, FLOOR_ID, nodeSetupScript } from "../src/node.ts";
import { parseRoute } from "../src/policy.ts";
import { AGENT_IMAGE } from "./fake-cluster.ts";

type Any = Record<string, any>;

const names = runNames("abcdef012345");
const route = parseRoute("anthropic=https://api.anthropic.com@anthropic-key");
const tripwire = { image: AGENT_IMAGE, canary: { host: "10.43.0.10", port: 53 } };
const base = { names, image: AGENT_IMAGE, toolsImage: null, tripwire, inputs: { prompt: "p" }, env: { HOME: "/home/agent" }, deadlineSeconds: 900, shutdownTime: "2026-11-01T01:00:00.000Z", deadline: 1793500000 };
const sandbox = sandboxObjects(base) as Any[];
const proxy = proxyObjects({ names, image: AGENT_IMAGE, files: { "proxy.ts": "", "config.json": "{}" }, route, deadlineSeconds: 900, deadline: 1793500000 }) as Any[];
const byKind = (objects: Any[], kind: string) => objects.find((o) => o.kind === kind) as Any;

test("run names have no hyphens, so EKS's policy agent can't group two runs together", () => {
  assert.deepEqual(names, { id: "abcdef012345", sandbox: "sabcdef012345", proxy: "pabcdef012345" });
  assert.throws(() => runNames("run-1"), /12 hex/);
  for (const o of [...sandbox, ...proxy]) assert.ok(!o.metadata.name.includes("-"), o.metadata.name);
});

test("an image is accepted only when pinned by digest", () => {
  assert.equal(assertPinned(AGENT_IMAGE), AGENT_IMAGE);
  for (const image of ["node:24", "docker.io/library/node:24", "docker.io/library/node:24@sha256:abc", "node@sha256:" + "a".repeat(64)]) assert.throws(() => assertPinned(image), /pinned/, image);
});

test("sandbox and proxy Pods run under the floor's RuntimeClasses, which schedule only onto nodes with this floor", () => {
  assert.equal(byKind(sandbox, "Sandbox").spec.podTemplate.spec.runtimeClassName, FLOOR.runtimes.sandbox);
  assert.equal(byKind(proxy, "Pod").spec.runtimeClassName, FLOOR.runtimes.proxy);
  const classes = (setupObjects() as Any[]).filter((o) => o.kind === "RuntimeClass");
  assert.deepEqual(classes.map((c) => [c.metadata.name, c.handler, c.scheduling.nodeSelector]), [
    [FLOOR.runtimes.sandbox, FLOOR.runtimes.sandbox, { [FLOOR.label]: FLOOR_ID }],
    [FLOOR.runtimes.proxy, FLOOR.runtimes.proxy, { [FLOOR.label]: FLOOR_ID }],
  ]);
});

test("the floor drops everything from the sandbox bridge but TCP 3128 and 8080 to the proxy range, and nothing reaches the node", () => {
  const nft = FLOOR_FILES["/etc/blacksand/egress-floor.nft"] ?? "";
  const forward = nft.slice(nft.indexOf("chain forward"), nft.indexOf("chain input"));
  assert.deepEqual(forward.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("iifname") || l.startsWith("oifname")), [
    `iifname "${FLOOR.sandboxBridge}" ip daddr ${FLOOR.proxyRange} tcp dport { 3128, 8080 } accept`,
    `iifname "${FLOOR.sandboxBridge}" counter drop`,
    `oifname "${FLOOR.sandboxBridge}" ct state established,related accept`,
    `oifname "${FLOOR.sandboxBridge}" counter drop`,
  ]);
  assert.match(nft, new RegExp(`chain input \\{[^}]*iifname "${FLOOR.sandboxBridge}" counter drop`));
  assert.match(nft, /table bridge blacksand \{[^]*meta ibrname "bsbx0" counter drop/, "no sandbox-to-sandbox frames on the bridge");
  assert.match(FLOOR_FILES["/etc/cni/blacksand/sandbox/10-blacksand.conflist"] ?? "", /"ipMasq": false/, "no NAT out of the sandbox range");
  assert.match(FLOOR_FILES["/etc/systemd/system/blacksand-egress-floor.service"] ?? "", /RequiredBy=k3s\.service/, "k3s doesn't start without it");
});

test("the node script installs exactly the floor's files and labels the node with their digest", () => {
  const script = nodeSetupScript();
  for (const [file, content] of Object.entries(FLOOR_FILES)) assert.ok(script.includes(`cat > '${file}' <<'BLACKSAND_EOF'\n${content}BLACKSAND_EOF\n`), file);
  assert.match(script, new RegExp(`label --overwrite "\\$node" ${FLOOR.label}=${FLOOR_ID}`));
  assert.match(FLOOR_ID, /^[0-9a-f]{16}$/);
});

test("the sandbox Pod runs as a non-root user, with nothing to escalate to and a deadline of its own", () => {
  const pod = byKind(sandbox, "Sandbox").spec.podTemplate.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.activeDeadlineSeconds, 900);
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  const [container] = pod.containers;
  assert.deepEqual(container.securityContext, {
    runAsNonRoot: true,
    runAsUser: 1000,
    runAsGroup: 1000,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  });
});

test("the tripwire only reports: it always exits 0, sees no inputs, and runs no agent code", () => {
  const [init] = byKind(sandbox, "Sandbox").spec.podTemplate.spec.initContainers;
  assert.equal(init.name, "tripwire");
  assert.equal(init.image, tripwire.image);
  assert.equal(init.volumeMounts, undefined);
  assert.doesNotMatch(TRIPWIRE_SCRIPT, /exit\(1\)|exitCode/);
});

test("the sandbox writes only to its own empty workspace, scratch and HOME; its inputs are read-only", () => {
  const pod = byKind(sandbox, "Sandbox").spec.podTemplate.spec;
  assert.deepEqual(pod.volumes.map((v: Any) => [v.name, Object.keys(v).find((k) => k !== "name")]), [["workspace", "emptyDir"], ["scratch", "emptyDir"], ["home", "emptyDir"], ["inputs", "configMap"]]);
  assert.deepEqual(pod.containers[0].volumeMounts, [
    { name: "workspace", mountPath: "/workspace" },
    { name: "scratch", mountPath: "/tmp" },
    { name: "home", mountPath: "/home/agent" },
    { name: "inputs", mountPath: "/run/blacksand/inputs", readOnly: true },
  ]);
});

test("a tools image is mounted read-only, by digest, and only when given", () => {
  const tools = "blacksand.local/agent-tools@sha256:" + "1".repeat(64);
  const withTools = byKind(sandboxObjects({ ...base, toolsImage: tools }) as Any[], "Sandbox").spec.podTemplate.spec;
  assert.deepEqual(withTools.volumes.at(-1), { name: "tools", image: { reference: tools, pullPolicy: "IfNotPresent" } });
  assert.deepEqual(withTools.containers[0].volumeMounts.at(-1), { name: "tools", mountPath: "/opt/agent-tools", readOnly: true });
  assert.throws(() => sandboxObjects({ ...base, toolsImage: "blacksand.local/agent-tools:latest" }), /pinned/);
  assert.ok(!JSON.stringify(sandbox).includes("agent-tools"));
});

test("no Secret reaches the sandbox: no secret volume, no env from a Secret", () => {
  const text = JSON.stringify(sandbox);
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("valueFrom"));
  assert.ok(!text.includes("anthropic-key"));
});

test("the proxy Pod holds its route's credential read-only, and has a deadline and a storage limit", () => {
  const pod = byKind(proxy, "Pod").spec;
  assert.deepEqual(pod.volumes[1], { name: "secret-anthropic", secret: { secretName: "anthropic-key", defaultMode: 0o400, items: [{ key: "key", path: "key" }] } });
  assert.deepEqual(pod.containers[0].volumeMounts[1], { name: "secret-anthropic", mountPath: "/secrets/anthropic", readOnly: true });
  assert.equal(pod.activeDeadlineSeconds, 900);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.containers[0].resources.limits["ephemeral-storage"], "64Mi");
});

test("the sandbox may reach only its own run's proxy, and the proxy accepts only its own run's sandbox", () => {
  assert.deepEqual(byKind(sandbox, "NetworkPolicy").spec.egress, [
    {
      to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.egress } }, podSelector: { matchLabels: { [LABEL.run]: "abcdef012345", [LABEL.role]: "proxy" } } }],
      ports: [{ protocol: "TCP", port: 3128 }, { protocol: "TCP", port: 8080 }],
    },
  ]);
  assert.deepEqual(byKind(proxy, "NetworkPolicy").spec.ingress[0].from, [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": NS.runs } }, podSelector: { matchLabels: { [LABEL.run]: "abcdef012345", [LABEL.role]: "sandbox" } } }]);
});

test("every object a run creates carries the run label and its deadline, so teardown and reconciliation find all of it", () => {
  for (const o of [...sandbox, ...proxy]) {
    assert.equal(o.metadata.labels[LABEL.run], "abcdef012345", `${o.kind}/${o.metadata.name}`);
    assert.equal(o.metadata.annotations[DEADLINE], "1793500000", `${o.kind}/${o.metadata.name}`);
  }
  assert.equal(byKind(sandbox, "Sandbox").spec.podTemplate.metadata.labels[LABEL.run], "abcdef012345");
  assert.equal(byKind(sandbox, "Sandbox").spec.shutdownPolicy, "Delete");
});

test("setup puts both namespaces under the restricted Pod Security level, with default-deny", () => {
  const objects = setupObjects() as Any[];
  const namespaces = objects.filter((o) => o.kind === "Namespace");
  assert.deepEqual(namespaces.map((n) => n.metadata.name), [NS.runs, NS.egress]);
  for (const n of namespaces) assert.equal(n.metadata.labels["pod-security.kubernetes.io/enforce"], "restricted");
  assert.deepEqual(objects.filter((o) => o.kind === "NetworkPolicy").map((p) => [p.metadata.namespace, p.spec.policyTypes]), [
    [NS.runs, ["Ingress", "Egress"]],
    [NS.egress, ["Ingress"]],
  ]);
});
