// The egress floor: a node's own default-drop for sandbox Pods, in place
// before any Pod starts, whatever the NetworkPolicy controller is doing.
//
// Sandbox Pods (RuntimeClass blacksand-sandbox: gVisor) and proxy Pods
// (blacksand-proxy: runc) each get their own network on the node, through
// containerd's per-runtime CNI config: a bridge and an address range of their
// own. Static nftables rules then let traffic from the sandbox bridge reach
// only TCP 3128 and 8080 on the proxy range, and nothing on the node itself;
// IPv6, other Pods, Services, DNS, the API server and the internet are
// dropped. NetworkPolicy still narrows a sandbox to its own proxy, and the
// run token stops a sandbox using any other run's proxy, but neither is what
// holds a new Pod in its first instants: the floor is.
//
// `blacksand k8s node-setup` prints the root script that installs it on a k3s
// node, labels the node with the floor's digest, and makes k3s require it at
// boot. The RuntimeClasses schedule only onto nodes with that label.
//
// Limits: single-node only for now: single-node ranges (no routing for these
// bridges between nodes) and k3s's containerd paths. The digest label is
// ordinary node metadata: root on the node sets it here, but anyone who
// administers the cluster (or acts as the node) could set it too, so it
// trusts the cluster's administrators, not only the node's root. With several
// nodes, or on EKS, use a protected node-restriction.kubernetes.io/ label
// (NodeRestriction keeps kubelets from setting those) and the node image and
// VPC CNI strict mode for the floor itself.

import { canonical, PORTS, sha256 } from "./policy.ts";

export const FLOOR = {
  sandboxBridge: "bsbx0",
  sandboxRange: "10.247.0.0/24",
  proxyBridge: "bprx0",
  proxyRange: "10.247.1.0/24",
  label: "blacksand-egress-floor",
  runtimes: { sandbox: "blacksand-sandbox", proxy: "blacksand-proxy" },
} as const;

const conflist = (name: string, bridge: string, subnet: string, ipMasq: boolean) =>
  `${JSON.stringify({
    cniVersion: "1.0.0",
    name,
    plugins: [{ type: "bridge", bridge, isGateway: true, ipMasq, hairpinMode: false, ipam: { type: "host-local", ranges: [[{ subnet }]], routes: [{ dst: "0.0.0.0/0" }] } }],
  }, null, 2)}\n`;

const CONTAINERD = `version = 3
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.${FLOOR.runtimes.sandbox}]
  runtime_type = "io.containerd.runsc.v1"
  cni_conf_dir = "/etc/cni/blacksand/sandbox"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.${FLOOR.runtimes.sandbox}.options]
  BinaryName = "/usr/local/bin/runsc"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.${FLOOR.runtimes.sandbox}.options.RunscConfig]
  platform = "systrap"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.${FLOOR.runtimes.proxy}]
  runtime_type = "io.containerd.runc.v2"
  cni_conf_dir = "/etc/cni/blacksand/proxy"
[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.${FLOOR.runtimes.proxy}.options]
  SystemdCgroup = true
`;

const NFT = `# The egress floor for sandbox Pods. Replaces itself when loaded again.
table inet blacksand
delete table inet blacksand
table bridge blacksand
delete table bridge blacksand
table inet blacksand {
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "${FLOOR.sandboxBridge}" ip daddr ${FLOOR.proxyRange} tcp dport { ${PORTS.connect}, ${PORTS.model} } accept
    iifname "${FLOOR.sandboxBridge}" counter drop
    oifname "${FLOOR.sandboxBridge}" ct state established,related accept
    oifname "${FLOOR.sandboxBridge}" counter drop
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "${FLOOR.sandboxBridge}" counter drop
  }
}
table bridge blacksand {
  chain forward {
    type filter hook forward priority -10; policy accept;
    meta ibrname "${FLOOR.sandboxBridge}" counter drop
  }
}
`;

const UNIT = `[Unit]
Description=blacksand egress floor for sandbox Pods
DefaultDependencies=no
Before=k3s.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/blacksand/egress-floor.nft
[Install]
WantedBy=multi-user.target
RequiredBy=k3s.service
`;

/** Every file the floor puts on a node, by path. */
export const FLOOR_FILES: Record<string, string> = {
  "/etc/cni/blacksand/sandbox/10-blacksand.conflist": conflist("blacksand-sandbox", FLOOR.sandboxBridge, FLOOR.sandboxRange, false),
  "/etc/cni/blacksand/proxy/10-blacksand.conflist": conflist("blacksand-proxy", FLOOR.proxyBridge, FLOOR.proxyRange, true),
  "/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/blacksand.toml": CONTAINERD,
  "/etc/blacksand/egress-floor.nft": NFT,
  "/etc/systemd/system/blacksand-egress-floor.service": UNIT,
};

/** The node label's value: a digest of exactly these files, so a node with another version of the floor gets no sandbox. */
export const FLOOR_ID = sha256(canonical(FLOOR_FILES)).slice(0, 16);

/** The root script that installs the floor on a k3s node. Its output is reviewable text; nothing here runs it. */
export function nodeSetupScript(): string {
  const files = Object.entries(FLOOR_FILES).map(([path, content]) => {
    const dir = path.slice(0, path.lastIndexOf("/"));
    return `mkdir -p '${dir}'\ncat > '${path}' <<'BLACKSAND_EOF'\n${content}BLACKSAND_EOF\n`;
  });
  return [
    "#!/bin/sh",
    `# blacksand egress floor ${FLOOR_ID}: run as root on a k3s node (blacksand k8s node-setup | sudo sh).`,
    "set -eu",
    "umask 022",
    ...files,
    "nft -c -f /etc/blacksand/egress-floor.nft",
    "systemctl daemon-reload",
    "systemctl enable blacksand-egress-floor.service",
    "systemctl restart blacksand-egress-floor.service",
    "systemctl restart k3s",
    'node=$(k3s kubectl get nodes -l "kubernetes.io/hostname=$(hostname)" -o name)',
    'k3s kubectl wait --for=condition=Ready "$node" --timeout=180s',
    `k3s kubectl label --overwrite "$node" ${FLOOR.label}=${FLOOR_ID}`,
    `echo "egress floor ${FLOOR_ID} installed on $node"`,
    "",
  ].join("\n");
}
