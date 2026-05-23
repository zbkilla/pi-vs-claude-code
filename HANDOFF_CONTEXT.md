# HANDOFF_CONTEXT — coms-net pi↔CC peer messaging

A complete state-of-the-build dump for the work done on this branch (May 23 2026 session). Successor agents/sessions: read this in full, then check the latest commit on `main` against the section "Where things stand" to spot drift.

---

## 1. What we built

Started from a working pi-only `coms-net` extension and ended with a fully symmetric pi↔Claude Code peer-messaging protocol. End-to-end demo: from CC's chat, `coms_net_send planner-net "..."` shows the target peer's context% in the tool result, the message arrives at planner-net rendered as `<channel source="coms-net" sender="claude2" sender_context_pct="0" ...>body</channel>` inside their pi transcript, they reply naturally, the reply auto-arrives in CC as `<channel source="plugin:fakechat:coms-net" sender="planner-net" reply_to="<msg-id>" responder_context_pct="1" ...>body</channel>`. No explicit await needed on either side.

Components shipped:
- **`coms-net-cc` Claude Code plugin** (new) — MCP server + hooks + slash command that registers CC as a peer on the coms-net hub.
- **`claude/channel` push integration** via the fakechat-substitution trick — inbound prompts arrive inline in CC's transcript instead of via Stop-hook injection.
- **Stop hook with transcript-flush retry** — closes channel-pushed replies back to the hub by extracting the assistant text that follows the `<channel msg_id=X>` in the transcript.
- **Author-supplied `summary` parameter** on `coms_net_send` (≤200 chars) — wire-level field through hub.
- **Orthogonal peer-health visibility** — `context_pct` + `status` + `observed_age_ms` stamped on send result, inbound channel events, and reply channel events. No derived "constrained" boolean — receivers choose their threshold.
- **Auto-delivered outbound replies** — both pi and CC peers surface the response to a `coms_net_send` as a new `<channel reply_to=...>` event without needing `coms_net_await`. `consumedByAwait` flag suppresses double-delivery when await is called.

---

## 2. Architecture

```
                ┌─────────────────────────────────────────────┐
                │      coms-net hub (Bun HTTP/SSE)            │
                │   scripts/coms-net-server.ts                │
                │                                             │
                │   GET  /v1/agents        POST /v1/messages  │
                │   POST /v1/agents/:id/heartbeat             │
                │   GET  /v1/events        (SSE)              │
                │   POST /v1/messages/:id/response            │
                └──────┬──────────────────────────┬───────────┘
                       │                          │
            HTTP+SSE   │                          │   HTTP+SSE
                       │                          │
    ┌──────────────────▼──────────┐    ┌──────────▼─────────────────┐
    │  pi peer (planner-net)      │    │  CC peer (claude / claude2)│
    │  extensions/coms-net.ts     │    │  coms-net-cc plugin        │
    │                             │    │   - MCP server (channels-  │
    │  - inbound rendered as      │    │     enabled, fakechat-     │
    │    <channel ...>body        │    │     substituted)           │
    │  - sendMessage(followUp,    │    │   - Stop hook closes       │
    │    triggerTurn) on prompt   │    │     replies via transcript │
    │  - agent_end captures &     │    │     scan                   │
    │    POSTs response           │    │   - SessionEnd DELETEs     │
    │  - outbound reply auto-     │    │     agent on exit          │
    │    delivered as followUp    │    │   - claude/channel push    │
    └─────────────────────────────┘    │     for inbound + reply    │
                                       └────────────────────────────┘
```

---

## 3. Where things live (key files)

| Concern | File | Notes |
|---|---|---|
| Hub server | `scripts/coms-net-server.ts` | ~1500 LoC. State stays in-memory. |
| pi client | `extensions/coms-net.ts` | Loaded via `pi -e`. ~1600 LoC. |
| Local-only pi (no hub) | `extensions/coms.ts` | Unix-socket variant. Same UX shape. |
| CC plugin manifest | `coms-net-cc/.claude-plugin/plugin.json` | Marketplace registration in `.claude-plugin/marketplace.json`. |
| CC MCP server | `coms-net-cc/server/index.ts` | Bun, uses `@modelcontextprotocol/sdk`. |
| CC hub client | `coms-net-cc/server/hub-client.ts` | HTTP + SSE, ported from pi's. |
| CC identity | `coms-net-cc/server/identity.ts` | Walks `import.meta.url` up to find marketplace.json root. |
| CC state I/O | `coms-net-cc/server/state-store.ts` | Per-msg files under `~/.claude/plugins/coms-net-cc/state/<sha1(cwd)[:12]>/`. |
| CC Stop hook | `coms-net-cc/hooks/stop.ts` | Closes channel-pushed replies + drains inbox fallback. |
| CC SessionEnd hook | `coms-net-cc/hooks/session-end.ts` | DELETEs agent from hub. |
| CC channels installer | `coms-net-cc/bin/install-channels.sh` | Substitutes fakechat's .mcp.json. Idempotent. |
| CC slash command | `coms-net-cc/commands/coms-net.md` | `/coms-net status|peers|reconnect`. |
| User identity | `.claude/coms-net-cc.local.md` | YAML frontmatter: name, color, purpose, project. |

---

## 4. Commit log (this session)

All on `origin/main` at `github.com/zbkilla/pi-vs-claude-code`.

| Commit | What |
|---|---|
| `fad00d6` | Initial `coms-net-cc` plugin scaffold (MCP + Stop hook fakechat injection + tools). |
| `6c0425a` | Added `claude/channel` push via fakechat substitution. Channels-capable MCP. |
| `265bde1` | Stop hook walks transcript for `<channel msg_id>` events to close channel-pushed inbounds. |
| `23db09a` | Stop hook retries transcript read briefly (≤750ms) to handle CC's flush-race. |
| `105761d` | Pi-side `<channel>` rendering + auto-deliver outbound replies as followUp turns. `consumedByAwait` dedupe. |
| `f594fc3` | CC-side auto-deliver outbound replies via `claude/channel` push. Symmetric with pi. |
| `342a27f` | Identity resolver walks up from `import.meta.url` (handles fakechat-substituted cwd). |
| `46aba44` | Author-supplied `summary` parameter on `coms_net_send`. Hub-side `ComsMessage.summary`. |
| `911149f` | Peer-health visibility — `context_pct/status/observed_age_ms` on send result, prompt SSE, response SSE. |

---

## 5. How to run

### One-time setup

1. Hub: `~/.pi/coms-net/projects/default/server.{json,secret.json}` is auto-created on first hub launch.
2. fakechat substitution: `coms-net-cc/bin/install-channels.sh` repoints `~/.claude/plugins/marketplaces/claude-plugins-official/external_plugins/fakechat/.mcp.json` at our server. Backup at `.mcp.json.bak`. Idempotent. To restore: `coms-net-cc/bin/uninstall-channels.sh`.
3. CC settings (`~/.claude/settings.json`) has these keys set:
   ```json
   "extraKnownMarketplaces": {
     "pi-vs-cc": {
       "source": { "source": "directory", "path": "/Users/zbk/Development/pi-vs-claude-code" }
     }
   },
   "enabledPlugins": {
     "coms-net-cc@pi-vs-cc": true,
     "fakechat@claude-plugins-official": true
   }
   ```

### Day-to-day

```bash
# Terminal 1: hub (pin port so peers don't lose connections on restart)
cd /Users/zbk/Development/pi-vs-claude-code
PI_COMS_NET_PORT=63492 bun scripts/coms-net-server.ts

# Terminal 2: pi peer
cd /Users/zbk/Development/pi-vs-claude-code
source .env && pi -e extensions/coms-net.ts -e extensions/minimal.ts \
  --name planner-net --purpose Plans --color "#36F9F6"

# Terminal 3: CC with channels enabled
cd /Users/zbk/Development/pi-vs-claude-code
claude --channels plugin:fakechat@claude-plugins-official
```

Inside CC: `/coms-net status` to verify, `/coms-net peers` to list.

Pi launch caveat: don't use `just local-coms` — its arg substitution mangles the `#` in color hex codes. Call `pi` directly.

---

## 6. Design idioms baked into the protocol

These came out of empirical pain or the three-agent design loop. Reuse when extending.

1. **Orthogonal state encoding.** Hub stamps raw fields (`context_pct: integer`, `status: enum`, `observed_age_ms: integer`) on every peer-state attribute. Receivers derive thresholds (e.g. "constrained" at ≥80%) locally. The other CC peer flagged this in the design synthesis and won the argument over a hub-derived boolean.

2. **`consumedByAwait` dedupe + 150ms defer.** Auto-deliver of outbound replies as `<channel reply_to=...>` events fires 150ms after the SSE response event. If `coms_net_await` is called within that window, it sets `consumedByAwait = true` on the PendingReply; the timer re-checks and skips the push. Prevents the LLM from seeing the same reply twice.

3. **Stop hook transcript-flush retry.** CC fires Stop ~100ms after the assistant message timestamp hits the JSONL — sometimes faster than the flush completes. Hook reads transcript, finds no matching reply, would silently leave the message stuck. Retry: sleep 200ms, re-read, up to ~750ms total. Fast-path (already flushed) adds 0ms.

4. **Heartbeat over probe.** Peer-state snapshots come from the 10s heartbeat the agent already emits. Both peers (planner-net and the other claude) independently rejected on-demand probes — adds latency, thundering-herd risk, capacity doesn't spike sub-second.

5. **State-dir keyed by `sha1(cwd)[:12]`.** MCP server's `process.cwd()` and the Stop hook's stdin `cwd` independently derive the same state dir without IPC. Identity resolver walks `import.meta.url` up to find the project root (needed because fakechat substitution sets `process.cwd()` to fakechat's dir).

6. **Empty `.mcp.json` in the plugin we ship.** `coms-net-cc/.mcp.json` has `{"mcpServers":{}}` — the plugin contributes hooks + commands but NO MCP server of its own. The fakechat-substituted MCP is the only one running. Avoids the double-MCP collision.

---

## 7. Known limits / non-fixes

- **128 MiB payload cap** — Bun's default `Request` body limit. Hub rejects with HTTP 413, no corruption. Lift with `Bun.serve({ maxRequestBodySize: N })` if ever needed. LLM context windows are ≪ ceiling.
- **CC has no native context-usage signal exposed to MCP** — `context_used_pct` from CC peers is stubbed to 0 in heartbeats. Cosmetic only (pool widget bar shows empty); routing decisions for CC-as-target aren't actually informed by CC's real context state. Open: estimate from transcript byte count.
- **Idle CC can't receive a "now" wake.** Channels push during a live session, but if CC is sitting at the prompt with no assistant turn running, the message lands in the transcript as user-role content waiting for the next turn to start. Pi's pi.sendMessage(followUp+triggerTurn) is more aggressive but pi sessions also need to be at a ready state.
- **Two `claude*` registrations linger on the hub.** Leftovers from earlier crashes. The hub's 60s stale-scan would reap them but they keep heartbeating from somewhere. Manually DELETE if they bother you; otherwise harmless. Hub auto-bumps new CCs to `claude2`, `claude3` etc on collision.

---

## 8. Open items the agents flagged

In priority order:

### #2 from the synthesis (DONE this session)
Peer-health visibility — shipped in `911149f`.

### Auto-deliver loop hazard (open)
The other CC peer flagged a theoretical loop: both Stop hooks auto-capture final assistant text and ship to the last inbound sender; under acknowledgment chains the ping-pong self-sustains. The specific reproduction they described didn't actually fire (the relevant msg stayed `delivered`, not `complete`), but the hazard is real if both sides default to acknowledging. Their proposed fix:
- Hub-side origin tracking — suppress auto-deliver when the current assistant turn was itself produced in response to an auto-delivered inbound. One round, no writer discipline needed.

Worth tracing before deploying multi-agent flows with chained delegation. Not yet built.

### #3 from the synthesis (open)
Thread repair — `GET /v1/threads/:thread_id` + a unilateral-merge endpoint so receivers can reconcile fragmented threads. Lower priority than the loop fix per the consensus.

### Local-coms parity (open)
`extensions/coms.ts` (Unix-socket variant) has the `<channel>` rendering shipped, but does NOT yet have peer-health attrs or summary parameter. Symmetric with coms-net would be nice but not blocking — local-coms is single-machine only.

---

## 9. Three-agent design pattern (worth reusing)

Twice this session we sent the same focused design question to TWO peers (planner-net + other CC) and read the divergence as signal. Both rounds yielded:
- Unanimous agreement on the priority (peer health > thread repair > etc.)
- Productive disagreement on encoding (planner: derived boolean; claude: orthogonal raw fields)
- Predictions the other agent would make, which were then partially validated

Pattern: when designing a non-obvious feature on this protocol, send the design question to ≥2 peers with the prompt "≤6 sentences, opinionated, the strongest disagreement is what I'm looking for." Synthesize the delta, not the agreement.

---

## 10. Memory entries created

Per the user's CLAUDE.md, memory lives at `/Users/zbk/.claude/projects/-Users-zbk/memory/`. New entries from this session, all linked from `MEMORY.md`:

- `reference_pi_vs_cc_repo.md`
- `fakechat_substitution_pattern.md`
- `coms_net_no_explicit_await.md`
- `droplet_agent_view_teams_prior_art.md`
- `coms_net_payload_ceiling.md`
- `coms_net_design_idioms.md`

A future session restarting fresh should pick these up automatically from `MEMORY.md`.

---

## 11. Quick "is everything still working?" check

```bash
# 1. Hub up?
TOKEN=$(jq -r .token ~/.pi/coms-net/projects/default/server.secret.json)
HUB=$(jq -r .local_url ~/.pi/coms-net/projects/default/server.json)
curl -s "$HUB/health" | jq .

# 2. Peers registered?
curl -s -H "Authorization: Bearer $TOKEN" "$HUB/v1/agents?project=default" | jq '.agents | map({name, status, context_used_pct})'

# 3. CC plugin state dir healthy?
find ~/.claude/plugins/coms-net-cc/state -name identity.json -newer /dev/null 2>/dev/null | head -3 | xargs -I{} jq '{name, session_id, state_dir}' {}
```

If hub is down or peers look wrong, restart the hub with `PI_COMS_NET_PORT=63492 bun scripts/coms-net-server.ts` and relaunch CC + pi peers.

---

*Session date: 2026-05-23. Origin commit at handoff: `911149f`.*
