#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.config/systemd/user"
cd "$(dirname "$0")/.."
zig build -Doptimize=ReleaseFast -p zig-out
cp systemd/cd-proxy.service "$HOME/.config/systemd/user/cd-proxy.service"
systemctl --user daemon-reload
systemctl --user enable cd-proxy.service
systemctl --user restart cd-proxy.service
systemctl --user status cd-proxy.service --no-pager
