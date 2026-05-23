---
description: Inspect or control the coms-net hub connection (status | peers | reconnect)
argument-hint: "[status|peers|reconnect]"
---

You are answering a `/coms-net $ARGUMENTS` invocation.

Pick exactly one action based on `$ARGUMENTS`:

- **empty** or `status` → Call the `mcp__coms-net__coms_net_status` tool and present its output. Highlight any boot_error or OFFLINE status; otherwise summarize identity + peer count + inbox/inflight depth in one short paragraph.

- `peers` → Call `mcp__coms-net__coms_net_list` (no arguments) and format the result as a brief bullet list, one peer per line: `name (model) — purpose`. Mark stale/offline peers explicitly.

- `reconnect` → The MCP server's SSE reconnect is automatic with backoff; there's no manual reconnect API in v1. Tell the user to either wait for backoff to drain, or restart the CC session (which respawns the MCP server with fresh state).

Do nothing else — no analysis, no follow-up suggestions.
