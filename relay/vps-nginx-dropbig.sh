#!/bin/bash
# Widen the /drop/ body limit so a gzipped database dump fits through it.
# Idempotent; backup + nginx -t before reload, same as the other patch scripts.
set -u
VH=/www/server/panel/vhost/nginx/html_files.example.com.conf
STAMP=$(date +%Y%m%d%H%M%S)

if [ ! -f "$VH" ]; then echo "NO-VHOST $VH"; exit 1; fi

if grep -q 'client_max_body_size 16m;' "$VH"; then
    echo "ALREADY-WIDE"
else
    cp -a "$VH" "$VH.bak-dropbig-$STAMP"
    echo "BACKUP $VH.bak-dropbig-$STAMP"
    python3 - "$VH" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
if 'client_max_body_size 64k;' not in src:
    print('NO-64K-MARKER'); sys.exit(1)
open(path, 'w', encoding='utf-8').write(src.replace('client_max_body_size 64k;', 'client_max_body_size 16m;'))
print('PATCHED')
PY
fi

echo "--- nginx -t ---"
nginx -t 2>&1
echo "--- reload ---"
nginx -s reload 2>&1 && echo RELOADED
grep -n 'client_max_body_size' "$VH"
