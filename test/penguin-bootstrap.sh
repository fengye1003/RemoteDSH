#!/bin/bash
# Bootstrap a RemoteDSH build environment on this machine.
#   - .NET 8 SDK via the official install script (into ~/.dotnet, no root needed)
#   - clang, which NativeAOT needs as its linker driver
# Idempotent: re-running only installs what is missing and reports what it found.
set -euo pipefail

# Strip a UTF-8 BOM if this file was transferred with one: bash then treats the
# shebang as "#!/bin/bash" on line 1 and refuses to run.
sed -i '1s/^\xEF\xBB\xBF//' "$0" 2>/dev/null || true

log() { printf '\n=== %s ===\n' "$1"; }

log "before"
for c in dotnet clang; do
  if command -v "$c" >/dev/null 2>&1; then echo "  $c: $(command -v "$c")"; else echo "  $c: missing"; fi
done
free -m | head -2

# ---- clang (no sudo assumed; skip when already present) ----------------------
if ! command -v clang >/dev/null 2>&1; then
  log "installing clang"
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo apt-get update -qq && sudo apt-get install -y -qq clang zlib1g-dev
  else
    echo "  no passwordless sudo; trying apt-get without it"
    apt-get install -y clang 2>/dev/null || echo "  SKIPPED clang (will retry after you grant sudo)"
  fi
fi

# ---- .NET 8 SDK --------------------------------------------------------------
export DOTNET_ROOT="$HOME/.dotnet"
export PATH="$DOTNET_ROOT:$PATH"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_NOLOGO=1

if ! command -v dotnet >/dev/null 2>&1 || ! dotnet --list-sdks 2>/dev/null | grep -q '^8\.'; then
  log "installing .NET 8 SDK into $DOTNET_ROOT"
  tmp="$(mktemp -d)"
  curl -fsSL --max-time 300 https://dot.net/v1/dotnet-install.sh -o "$tmp/dotnet-install.sh"
  chmod +x "$tmp/dotnet-install.sh"
  "$tmp/dotnet-install.sh" --channel 8.0 --install-dir "$DOTNET_ROOT" --no-path
  rm -rf "$tmp"
else
  log ".NET SDK already present"
fi

log "after"
dotnet --list-sdks 2>/dev/null || echo "  dotnet still unavailable"
clang --version 2>/dev/null | head -1 || echo "  clang still unavailable"
echo
echo "add to your shell profile if missing:"
echo "  export DOTNET_ROOT=\"\$HOME/.dotnet\"; export PATH=\"\$DOTNET_ROOT:\$PATH\""
echo
echo "BOOTSTRAP-DONE"
