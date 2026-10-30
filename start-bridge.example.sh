#!/usr/bin/env bash
set -euo pipefail

bridge_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
key_file="${XDG_CONFIG_HOME:-$HOME/.config}/claude-codex-bridge/deepseek-api-key"
if [[ -z "${DEEPSEEK_API_KEY:-}" && -f "$key_file" ]]; then
    DEEPSEEK_API_KEY="$(< "$key_file")"
    export DEEPSEEK_API_KEY
fi

export CLAUDE_BRIDGE_CLAUDE_BIN="${CLAUDE_BRIDGE_CLAUDE_BIN:-claude}"
export CLAUDE_BRIDGE_PROJECT_DIR="${CLAUDE_BRIDGE_PROJECT_DIR:-$PWD}"
exec node "$bridge_dir/server.js"
