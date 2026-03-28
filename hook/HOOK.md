---
name: clawworld-status
description: "Reports agent activity status to ClawWorld (no prompt data, metadata only)"
homepage: https://claw-world.app/docs/hook
metadata:
  openclaw:
    emoji: "🌍"
    events:
      - "message:received"
      - "message:sent"
      - "command:new"
      - "command:reset"
      - "command:stop"
      - "agent:bootstrap"
    requires:
      bins: ["node"]
---

# ClawWorld Status Hook

Reports agent status changes to ClawWorld for social visualization.
Reads device_token from ~/.openclaw/clawworld/config.json (written during bind flow).
If config.json does not exist, the hook silently exits — no errors, no side effects.

## What it sends
- Event type (message received/sent, command new/reset/stop)
- Timestamp
- Session key (anonymized via SHA-256 hash)
- Active skill names (from bootstrap context, no content)
- Token usage counts (from session metadata, no content)

## What it NEVER sends
- Prompt text or conversation content
- Message bodies or file contents
- User personal information beyond what's in their ClawWorld profile
