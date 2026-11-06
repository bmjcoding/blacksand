import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { test } from "node:test";
import { serviceObjects } from "../src/service-manifests.ts";

const run = promisify(execFile);
test("service readiness runs inside its Pod and requires a live bounded local listener", async (t) => {
  const server = net.createServer((socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = (server.address() as net.AddressInfo).port;
  const objects = serviceObjects({ name: "proxy", namespace: "services", image: `registry.test/node@sha256:${"a".repeat(64)}`,
    client: { namespace: "clients", labels: { app: "client" } }, port, config: "{}",
    code: { "proxy.ts": "", "service.ts": "", "service-policy.ts": "", "policy.ts": "", "audit.ts": "" },
    secrets: [], controlConfigMap: "control", auditClaim: "audit", destinations: [],
    resolver: { namespace: "kube-system", labels: { "k8s-app": "kube-dns" } },
  }) as any[];
  const probe = objects.find((o) => o.kind === "Deployment").spec.template.spec.containers[0].readinessProbe;
  assert.equal(probe.tcpSocket, undefined); // node-to-Pod traffic need not be admitted
  assert.equal(probe.timeoutSeconds, 2);
  const [command, ...args] = probe.exec.command as string[];
  assert.equal(command, "node");
  assert.equal(args.at(-1), String(port));
  try {
    await run(process.execPath, args, { timeout: 2500 });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assert.rejects(run(process.execPath, args, { timeout: 2500 }));
});
