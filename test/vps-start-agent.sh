#!/bin/bash
# Start (or restart) the RemoteDSH agent on this machine, detached, and return
# immediately. Keeping the wrapper short and fully redirected is what stops ssh
# from hanging on the agent's inherited stdout.
#
#   start-agent.sh <relay-url> [extra rdsh args...]
set -u

RELAY="${1:-}"
shift || true
AGENT_DIR=/root/rdsh-agent
BIN=/root/rdsh-out/rdsh

mkdir -p "$AGENT_DIR"
pkill -f "$BIN" 2>/dev/null || true
sleep 1

if [ -z "$RELAY" ]; then
  echo "usage: $0 <relay-url> [extra args...]"
  exit 2
fi

# setsid + full redirection + closed stdin: the agent survives the ssh session
# and cannot hold it open.
setsid "$BIN" --relay "$RELAY" --no-discover --no-listen --emit-pair "$AGENT_DIR/pair.txt" "$@" \
  < /dev/null > "$AGENT_DIR/agent.log" 2>&1 &
disown 2>/dev/null || true

sleep 5
echo "--- process ---"
pgrep -af "$BIN" | head -3 || echo "  (not running)"
echo "--- pair string ---"
head -c 200 "$AGENT_DIR/pair.txt" 2>/dev/null || echo "  (no pair file yet)"
echo
echo "--- agent log ---"
tail -8 "$AGENT_DIR/agent.log" 2>/dev/null || echo "  (no log)"
echo "AGENT-START-ISSUED"
