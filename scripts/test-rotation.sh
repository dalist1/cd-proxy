#!/usr/bin/env bash
set -euo pipefail
BASE="${CD_PROXY_BASE_URL:-http://127.0.0.1:8318}"
API_KEY="${CD_PROXY_API_KEY:-$(cat "${CD_PROXY_API_KEY_FILE:-$HOME/.config/cliproxyapi/api-key}")}"
COUNT="${1:-14}"
json="$(curl -fsS -H "Authorization: Bearer $API_KEY" "$BASE/debug/rotation?count=$COUNT")"
python3 - "$json" <<'PY'
import json, sys
j=json.loads(sys.argv[1])
labels=[x['label'] if x else None for x in j['picked']]
print('\n'.join(f'{i}: {label}' for i,label in enumerate(labels)))
n=len(labels)//2
if len(labels) >= 2 and n and labels[:n] == labels[n:2*n]:
    print(f'round-robin ok: first {n} selections repeat')
else:
    print('round-robin sequence printed above; not enough data or not an exact half-repeat')
PY
