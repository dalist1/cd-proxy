#!/usr/bin/env bash
set -euo pipefail
BASE="${CD_PROXY_BASE_URL:-http://127.0.0.1:8318}"
API_KEY="${CD_PROXY_API_KEY:-$(cat "${CD_PROXY_API_KEY_FILE:-$HOME/.config/cliproxyapi/api-key}")}"
COUNT="${1:-14}"
json="$(curl -fsS -H "Authorization: Bearer $API_KEY" "$BASE/debug/rotation?count=$COUNT")"
bun -e '
const j = JSON.parse(process.argv[1]);
const labels = j.picked.map((x) => x?.label ?? null);
console.log(labels.map((label, i) => `${i}: ${label}`).join("\n"));
const n = Math.floor(labels.length / 2);
if (labels.length >= 2 && n && JSON.stringify(labels.slice(0, n)) === JSON.stringify(labels.slice(n, 2 * n))) {
  console.log(`round-robin ok: first ${n} selections repeat`);
} else {
  console.log("round-robin sequence printed above; not enough data or not an exact half-repeat");
}
' "$json"
