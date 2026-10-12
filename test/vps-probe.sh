#!/bin/bash
# Probe the VPS for what a RemoteDSH Linux build needs. Read-only.
set -u

echo "=== OS / ARCH ==="
uname -a
. /etc/os-release 2>/dev/null && echo "distro: $PRETTY_NAME"

echo
echo "=== CPU / MEM / DISK ==="
echo "cores: $(nproc)"
free -m | head -2
df -h / /root /tmp 2>/dev/null | sort -u

echo
echo "=== TOOLCHAIN ==="
for c in dotnet clang gcc cc ld objcopy curl wget tar node python3 git; do
  if command -v "$c" >/dev/null 2>&1; then
    printf '  %-10s %s\n' "$c" "$(command -v "$c")"
  else
    printf '  %-10s (missing)\n' "$c"
  fi
done

echo
echo "=== VERSIONS ==="
echo "  glibc: $(ldd --version 2>/dev/null | head -1)"
(clang --version 2>/dev/null | head -1) | sed 's/^/  clang: /'
(gcc --version 2>/dev/null | head -1) | sed 's/^/  gcc: /'
(node --version 2>/dev/null) | sed 's/^/  node: /'

echo
echo "=== NETWORK (build-time reachability) ==="
for url in https://dot.net https://api.nuget.org https://nodejs.org; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 12 "$url" 2>/dev/null)
  printf '  %-28s %s\n' "$url" "${code:-timeout}"
done

echo
echo "=== WHAT IS ALREADY DEPLOYED (context) ==="
ls -d /www/updata 2>/dev/null && echo "  upload-point present"
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | awk '{print $1}' | grep -E 'nginx|php|ssh' | head -5

echo
echo "VPS-PROBE-DONE"
