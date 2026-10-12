#!/bin/bash
# Build the Linux (linux-x64) NativeAOT agent on this machine.
set -euo pipefail

cd /root/rdsh-src
rm -rf bin obj

export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1
export DOTNET_ROOT=/root/.dotnet
export PATH="/root/.dotnet:$PATH"

echo "=== toolchain ==="
echo "dotnet: $(dotnet --version 2>/dev/null || echo missing)"
if command -v clang >/dev/null 2>&1; then
  echo "clang : $(clang --version | head -1)"
else
  echo "clang : missing (ILCompiler falls back to gcc on linux)"
fi
gcc --version | head -1 | sed 's/^/gcc   : /'

echo
echo "=== publish linux-x64 (NativeAOT, full flavor) ==="
dotnet publish rdsh.csproj \
  -c Release \
  -r linux-x64 \
  -p:EmbedNode=true \
  -o /root/rdsh-out 2>&1 | tail -30

echo
echo "=== result ==="
ls -la /root/rdsh-out 2>/dev/null || echo "NO OUTPUT DIRECTORY"
if [ -f /root/rdsh-out/rdsh ]; then
  echo "size: $(du -h /root/rdsh-out/rdsh | cut -f1)"
  file /root/rdsh-out/rdsh 2>/dev/null || true
  /root/rdsh-out/rdsh --help 2>&1 | head -5 || echo "(could not run it here)"
fi
echo
echo "BUILD-DONE"
