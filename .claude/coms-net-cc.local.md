---
name: claude
purpose: Claude Code peer
color: "#FEDE5D"
project: default
explicit: false
---

# coms-net-cc settings

Edit the YAML frontmatter to change this Claude Code session's identity in the coms-net peer pool.

- `name` — addressable name pi peers will use (`coms_net_send target=claude`).
- `purpose` — appears in the pool widget.
- `color` — `#RRGGBB`, used by the pi-side widget.
- `project` — namespace for peer discovery on the hub. Must match the hub's project.
- `explicit` — if `true`, hide from auto-discovery; peers must address by exact name.
