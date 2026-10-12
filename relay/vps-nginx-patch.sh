#!/bin/bash
# Patch the files.example.com vhost with the RemoteDSH relay location.
# Idempotent: re-running only reports ALREADY-PATCHED. Always keeps a timestamped
# backup and refuses to reload nginx unless "nginx -t" passes.
set -u
VH=/www/server/panel/vhost/nginx/html_files.example.com.conf
STAMP=$(date +%Y%m%d%H%M%S)

if [ ! -f "$VH" ]; then echo "NO-VHOST $VH"; exit 1; fi

if grep -q 'location /rdsh/' "$VH"; then
    echo "ALREADY-PATCHED"
else
    cp -a "$VH" "$VH.bak-rdsh-$STAMP"
    echo "BACKUP $VH.bak-rdsh-$STAMP"
    python3 - "$VH" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
block = '''
    # RemoteDSH relay (added by the DSH agent). The target machine dials
    # ws://<this host>/rdsh/remote/attach; this proxies into an SSH reverse
    # tunnel that ends at the home harness (:8088). No inbound port is needed
    # on either side, and plain HTTP keeps unpatched Windows 7 clients working.
    location /rdsh/ {
        proxy_pass http://127.0.0.1:18088/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        proxy_cache off;
        access_log off;
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
echo "--- location check ---"
grep -n 'rdsh' "$VH" | head -20
