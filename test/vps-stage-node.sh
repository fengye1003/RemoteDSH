#!/bin/bash
# Stage a Node runtime next to the RemoteDSH agent on this machine so the FULL
# flavor can run .mjs without anything installed system-wide.
#
#   stage-node.sh [target-dir]
#
# The agent looks for <dir>/node/node (or node.exe on Windows) first, falling back
# to a `node` on PATH. Staging here keeps that promise true for this host.

set -euo pipefail

TARGET="${1:-/root/rdsh-out}"
NODE_VERSION="${NODE_VERSION:-v22.20.0}"
NODE_DIR="$TARGET/node"

mkdir -p "$NODE_DIR"

if [ -x "$NODE_DIR/node" ]; then
  echo "already staged: $("$NODE_DIR/node" --version)"
  exit 0
fi

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 2 ;;
esac

FOLDER="node-$NODE_VERSION-linux-$NODE_ARCH"
URL="https://nodejs.org/dist/$NODE_VERSION/$FOLDER.tar.xz"

echo "downloading $URL"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL --max-time 600 "$URL" -o "$tmp/node.tar.xz"
tar -xJf "$tmp/node.tar.xz" -C "$tmp"

cp "$tmp/$FOLDER/bin/node" "$NODE_DIR/node"
chmod 755 "$NODE_DIR/node"
[ -f "$tmp/$FOLDER/LICENSE" ] && cp "$tmp/$FOLDER/LICENSE" "$NODE_DIR/LICENSE"

echo "staged $("$NODE_DIR/node" --version) -> $NODE_DIR/node"
echo "size: $(du -h "$NODE_DIR/node" | cut -f1)"
echo "STAGE-NODE-DONE"
