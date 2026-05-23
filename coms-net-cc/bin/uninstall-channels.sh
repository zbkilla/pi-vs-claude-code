#!/usr/bin/env bash
# Restore the original fakechat plugin .mcp.json (saved by install-channels.sh).
set -euo pipefail

FAKECHAT_MCP="$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/.mcp.json"
BACKUP="$FAKECHAT_MCP.bak"

if [ ! -f "$BACKUP" ]; then
  echo "no backup at $BACKUP — nothing to restore" >&2
  exit 1
fi

cp "$BACKUP" "$FAKECHAT_MCP"
echo "✓ restored original fakechat .mcp.json from $BACKUP"
