#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/.config/systemd/user"
cp "$(dirname "$0")/../systemd/cd-proxy.service" "$HOME/.config/systemd/user/cd-proxy.service"
systemctl --user daemon-reload
systemctl --user enable cd-proxy.service
systemctl --user restart cd-proxy.service
systemctl --user status cd-proxy.service --no-pager
