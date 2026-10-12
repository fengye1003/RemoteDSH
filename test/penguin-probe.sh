#!/bin/bash
# Probe penguin for everything the RemoteDSH Linux build needs.
# Read-only: installs nothing, changes nothing.
set -u

echo "=== OS / ARCH ==="
uname -a
. /etc/os-release 2>/dev/null && echo "distro: $PRETTY_NAME"

echo
echo "=== CPU / MEM / DISK ==="
echo "cores: $(nproc)"
free -m | head -2
df -h / /home 2>/dev/null | sort -u

echo
echo "=== TOOLCHAIN ==="
for c in dotnet clang gcc cc ld objcopy curl tar node npm python3 git; do
  if command -v "$c" >/dev/null 2>&1; then
    printf '  %-10s %s\n' "$c" "$(command -v "$c")"
  else
    printf '  %-10s (missing)\n' "$c"
  fi
done

echo
echo "=== VERSIONS ==="
node --version 2>/dev/null | sed 's/^/  node: /'
python3 --version 2>/dev/null | sed 's/^/  python: /'
(tar --version 2>/dev/null | head -1) | sed 's/^/  tar: /'
echo "  glibc: $(ldd --version 2>/dev/null | head -1)"

echo
echo "=== EXISTING DOTNET ==="
if [ -d "$HOME/.dotnet" ]; then
  echo "  ~/.dotnet exists:"
  ls -1 "$HOME/.dotnet" 2>/dev/null | head -10
else
  echo "  ~/.dotnet absent"
fi
ls -1 /usr/share/dotnet 2>/dev/null | head -5 || true

echo
echo "=== NETWORK REACHABILITY (what a user would hit) ==="
for url in https://dotnet.microsoft.com https://dot.net https://nodejs.org https://api.nuget.org; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null)
  printf '  %-32s %s\n' "$url" "${code:-timeout}"
done

echo
echo "=== WRITABLE SPACE FOR A BUILD DIR ==="
for d in "$HOME" /tmp; do
  if [ -w "$d" ]; then echo "  writable: $d  ($(df -h "$d" | tail -1 | awk '{print $4}') free)"; fi
done

echo
echo "PENGUIN-PROBE-DONE"
