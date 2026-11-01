#!/bin/sh
# Builds the agent-tools image: Claude Code and Codex for linux/arm64, from
# their upstream releases, checksum-pinned, in one layer with nothing else. A run
# mounts it read-only (an image volume at /opt/agent-tools) on top of the
# agent image, so the agent's root filesystem stays the pinned base image.
#
#   sh agent-tools.sh OUT_DIR      writes OUT_DIR/agent-tools.oci.tar and prints its manifest digest
#
# Then, on a k3s node (an import names the image by tag only; the kubelet
# looks an image up by the digest a Pod names, so add that name too):
#   sudo k3s ctr -n k8s.io images import OUT_DIR/agent-tools.oci.tar
#   sudo k3s ctr -n k8s.io images tag blacksand.local/agent-tools:TAG blacksand.local/agent-tools@sha256:DIGEST
#   sudo k3s ctr -n k8s.io images label blacksand.local/agent-tools@sha256:DIGEST io.cri-containerd.image=managed
# and run with --tools-image blacksand.local/agent-tools@sha256:DIGEST. On EKS, push it to a
# private registry instead and use the digest the registry reports.
#
# What this script checks: every download against a SHA-256 pinned below. It
# does no signature checking of its own, so the pins carry the trust, and a
# pin is only changed in a commit whose approver first authenticates it:
# - Claude Code: the release's manifest.json, verified with
#   `gpg --verify manifest.json.sig manifest.json` against the release key whose
#   fingerprint Anthropic's setup docs publish; the pin is the manifest's
#   linux-arm64 checksum.
# - Codex: each asset verified with
#   `cosign verify-blob --bundle ASSET.sigstore --certificate-identity
#   https://github.com/openai/codex/.github/workflows/rust-release.yml@refs/tags/TAG
#   --certificate-oidc-issuer https://token.actions.githubusercontent.com ASSET`,
#   which checks the certificate chain and transparency log too; the pin is the
#   archive's SHA-256 (GitHub publishes the same digest).
# Needs: curl, sha256sum, tar (GNU), gzip. Linux only.
set -eu

CLAUDE_VERSION=2.1.309
CLAUDE_SHA256=9796dd26899337f687739a0b39a7353b639f062a3436a7b941fcf19a1b757a9b
CODEX_TAG=rust-v0.165.0
# Per Codex asset: its name and the SHA-256 of its archive.
CODEX="codex 6522e056d0be7f531da915c9a81ae05bc70811b782542499cc0a9776d3abf5d3
codex-code-mode-host 400956c325a2118768029f235958b7d2fd2ea4e59c5466d336fb4fb7f0e94b61
bwrap ffde98edd6345ee09486d5c0afca041bc21f18926d09c730a3089de56cdbbf19"
NAME=blacksand.local/agent-tools

out=${1:?usage: agent-tools.sh OUT_DIR}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$out" "$work/root/bin" "$work/oci/blobs/sha256"

check() { # FILE SHA256
  actual=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$actual" = "$2" ] || { echo "agent-tools: $1 is $actual, expected $2" >&2; exit 1; }
}

echo "Claude Code $CLAUDE_VERSION" >&2
curl -fsSL --proto '=https' "https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION/linux-arm64/claude" -o "$work/root/bin/claude"
check "$work/root/bin/claude" "$CLAUDE_SHA256"

echo "Codex $CODEX_TAG" >&2
release="https://github.com/openai/codex/releases/download/$CODEX_TAG"
codex_asset() { # NAME ARCHIVE_SHA256
  asset="$1-aarch64-unknown-linux-musl"
  curl -fsSL --proto '=https' "$release/$asset.tar.gz" -o "$work/$1.tar.gz"
  check "$work/$1.tar.gz" "$2"
  tar -xzf "$work/$1.tar.gz" -C "$work" "$asset"
  mv "$work/$asset" "$work/root/bin/$1"
}
while read -r name archive; do codex_asset "$name" "$archive"; done <<EOF
$CODEX
EOF

chmod 0555 "$work/root/bin/"*
chmod 0755 "$work/root/bin"

# One reproducible layer: sorted names, fixed times and owners, no gzip timestamp.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=posix --pax-option=delete=atime,delete=ctime -C "$work/root" -cf "$work/layer.tar" bin
diff_id=$(sha256sum "$work/layer.tar" | cut -d' ' -f1)
gzip -n -9 "$work/layer.tar"
blob() { # FILE -> moves it into the layout, prints "digest size"
  digest=$(sha256sum "$1" | cut -d' ' -f1)
  size=$(wc -c < "$1" | tr -d ' ')
  mv "$1" "$work/oci/blobs/sha256/$digest"
  echo "$digest $size"
}
read -r layer layer_size <<EOF
$(blob "$work/layer.tar.gz")
EOF
printf '{"architecture":"arm64","os":"linux","config":{"Labels":{"claude-code":"%s","codex":"%s"}},"rootfs":{"type":"layers","diff_ids":["sha256:%s"]}}' "$CLAUDE_VERSION" "$CODEX_TAG" "$diff_id" > "$work/config.json"
read -r config config_size <<EOF
$(blob "$work/config.json")
EOF
printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"sha256:%s","size":%s},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"sha256:%s","size":%s}]}' "$config" "$config_size" "$layer" "$layer_size" > "$work/manifest.json"
read -r manifest manifest_size <<EOF
$(blob "$work/manifest.json")
EOF
tag="claude-$CLAUDE_VERSION-codex-${CODEX_TAG#rust-v}"
printf '{"schemaVersion":2,"manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"sha256:%s","size":%s,"platform":{"architecture":"arm64","os":"linux"},"annotations":{"org.opencontainers.image.ref.name":"%s:%s"}}]}' "$manifest" "$manifest_size" "$NAME" "$tag" > "$work/oci/index.json"
printf '{"imageLayoutVersion":"1.0.0"}' > "$work/oci/oci-layout"
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$work/oci" -cf "$out/agent-tools.oci.tar" oci-layout index.json blobs
echo "$NAME@sha256:$manifest"
