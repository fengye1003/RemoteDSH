#!/bin/bash
# Install the .NET 8 SDK on this machine, user-space only (no apt).
#
# Why not apt: this box has no dotnet feed configured and the agent has no need
# for a system-wide install. The official install script is self-contained.
set -euo pipefail

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
DOTNET_ROOT="${DOTNET_ROOT:-/root/.dotnet}"

if [ -x "$DOTNET_ROOT/dotnet" ] && "$DOTNET_ROOT/dotnet" --list-sdks 2>/dev/null | grep -q '^8\.'; then
  echo "SDK already present:"
  "$DOTNET_ROOT/dotnet" --list-sdks
  echo "SDK-READY"
  exit 0
fi

echo "=== downloading dotnet-install.sh ==="
curl -fsSL --max-time 300 https://dot.net/v1/dotnet-install.sh -o /root/dotnet-install.sh
chmod +x /root/dotnet-install.sh

echo "=== installing .NET 8 SDK into $DOTNET_ROOT ==="
/root/dotnet-install.sh --channel 8.0 --install-dir "$DOTNET_ROOT" --no-path 2>&1 | tail -12

echo
echo "=== result ==="
"$DOTNET_ROOT/dotnet" --list-sdks
"$DOTNET_ROOT/dotnet" --list-runtimes | head -5
echo
echo "SDK-READY"
