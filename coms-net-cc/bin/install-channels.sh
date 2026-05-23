#!/usr/bin/env bash
# Substitute the allowlisted `fakechat` plugin's .mcp.json so it spawns
# coms-net-cc's MCP server. This is the trick that unlocks the
# `claude/channel` notification path without the dev-channels TTY dialog.
#
# Borrowed from /root/agent-view-teams/research/plugin-substitution-test-2026-05-14.md
# on python-dev-1.
#
# To restore the original fakechat plugin: bin/uninstall-channels.sh.
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_TS="$PLUGIN_ROOT/server/index.ts"
FAKECHAT_DIR="$HOME/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat"
FAKECHAT_MCP="$FAKECHAT_DIR/.mcp.json"
BACKUP="$FAKECHAT_DIR/.mcp.json.bak"

if [ ! -d "$FAKECHAT_DIR" ]; then
  echo "error: fakechat plugin not installed at $FAKECHAT_DIR" >&2
  echo "  run: /plugin install fakechat@claude-plugins-official" >&2
  exit 1
fi

if [ ! -f "$SERVER_TS" ]; then
  echo "error: server entry not found at $SERVER_TS" >&2
  exit 1
fi

if [ -f "$FAKECHAT_MCP" ] && [ ! -f "$BACKUP" ]; then
  cp "$FAKECHAT_MCP" "$BACKUP"
  echo "✓ backed up original fakechat .mcp.json → $BACKUP"
fi

cat > "$FAKECHAT_MCP" <<EOF
{
  "mcpServers": {
    "coms-net": {
      "command": "bun",
      "args": ["run", "$SERVER_TS"],
      "env": {}
    }
  }
}
EOF
echo "✓ substituted fakechat .mcp.json → spawns $SERVER_TS"
echo
echo "launch CC with channels enabled:"
echo "  claude --channels plugin:fakechat@claude-plugins-official"
echo
echo "to restore the original fakechat plugin:"
echo "  $PLUGIN_ROOT/bin/uninstall-channels.sh"
