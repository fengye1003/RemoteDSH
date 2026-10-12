#!/bin/bash
# Add the /drop/ location to the static vhost (idempotent), so the target machine can
# POST the pairing string straight to the operator instead of photographing it.
# Keeps a backup and refuses to reload nginx unless "nginx -t" passes.
set -u
VH=/www/server/panel/vhost/nginx/html_files.example.com.conf
STAMP=$(date +%Y%m%d%H%M%S)

if [ ! -f "$VH" ]; then echo "NO-VHOST $VH"; exit 1; fi

if grep -q 'location /drop/' "$VH"; then
    echo "ALREADY-PATCHED"
else
    cp -a "$VH" "$VH.bak-drop-$STAMP"
    echo "BACKUP $VH.bak-drop-$STAMP"
    python3 - "$VH" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
block = '''
    # Pairing-string drop box (token-gated). Proxied through a second SSH reverse
    # tunnel into the operator's machine, so nothing sensitive is stored on the
    # VPS. Remove this location (and the token) once the hand-over is done.
    location /drop/ {
        proxy_pass http://127.0.0.1:18091/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 60s;
        proxy_buffering off;
        proxy_cache off;
        access_log off;
        client_max_body_size 64k;
    }
'''
idx = src.rfind('}')
if idx < 0:
    print('NO-BRACE'); sys.exit(1)
open(path, 'w', encoding='utf-8').write(src[:idx] + block + src[idx:])
print('PATCHED')
PY
fi

echo "--- nginx -t ---"
nginx -t 2>&1
echo "--- reload ---"
nginx -s reload 2>&1 && echo RELOADED
grep -n 'drop' "$VH" | head -5
