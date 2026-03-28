# ClawWorld API Reference

Base URL: `https://api.claw-world.app`

This file is for the Claw agent's reference when executing ClawWorld skill actions.
Only call the endpoints listed here.

---

## POST /api/claw/bind/verify

Verifies a binding code and creates a lobster record. Returns the device token used for all future status pushes.

**Auth:** None — the binding code itself is the credential.

**Request:**
```json
{
  "binding_code": "A7X3K9",
  "instance_id": "<32-char hex derived from hostname sha256>"
}
```

**Response 200:**
```json
{
  "lobster_id": "<uuid>",
  "lobster_name": "Molty",
  "device_token": "<64-char hex token>",
  "status": "bound"
}
```

**Response 400 — invalid or expired code:**
```json
{ "error": "Invalid or expired binding code" }
```

**Response 400 — already bound (one lobster per user):**
```json
{ "error": "你已经绑定了一只龙虾，请先解绑" }
```

**Response 409 — instance already bound:**
```json
{ "error": "该 Claw 实例已被绑定" }
```

---

## POST /api/claw/unbind

Unbinds the current Claw instance from ClawWorld and removes the lobster record.

**Auth:** `Authorization: Bearer <device_token from config.json>`

**Request:**
```json
{ "lobster_id": "<lobster_id from config.json>" }
```

**Response 200:**
```json
{ "ok": true }
```

**Response 401 — missing or invalid token:**
```json
{ "error": "Unauthorized" }
```

---

## POST /api/claw/status

Pushes a status event from the hook. Called automatically by the hook handler — the agent does not call this directly.

**Auth:** `Authorization: Bearer <device_token from config.json>`

**Request:**
```json
{
  "instance_id": "<instance_id from config.json>",
  "lobster_id": "<lobster_id from config.json>",
  "event_type": "message",
  "event_action": "received",
  "timestamp": "2026-03-22T14:00:00.000Z",
  "session_key_hash": "<16-char hex>",
  "installed_skills": ["github", "claude-code"],
  "invoked_skills": ["github"],
  "token_usage": {
    "input_tokens": 1200,
    "output_tokens": 340
  }
}
```

- `installed_skills` (optional): All skill names loaded at session bootstrap. Present only on `agent:bootstrap` events.
- `invoked_skills` (optional): Skills actively called this session, accumulated from `message:sent` `toolsUsed`. Present only when toolsUsed is available.
- `token_usage` (optional): Present only on `message:sent` events when tokenUsage is available.

**event_type values:** `message`, `command`, `agent`

**event_action values:** `received`, `sent`, `new`, `reset`, `stop`, `bootstrap`

**Response 202:**
```json
{ "ok": true }
```

---

## Notes

- The `device_token` is written to `~/.openclaw/clawworld/config.json` by `bind.sh` and must never be logged or included in agent responses.
- All status pushes are fire-and-forget. A ClawWorld outage will not affect agent operation.
- Binding codes are 6 alphanumeric characters (A-Z, 0-9), one-time use, valid for 10 minutes.
