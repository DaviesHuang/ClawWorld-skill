# ClawWorld Plugin

Install:

```bash
openclaw plugins install openclaw-plugin-clawworld
```

The plugin currently includes two reporting paths:

- **Recent Activity summary**
  - Listens to `api.on("llm_input", ...)`
  - Reads recent session messages after `llm_input`
  - Calls the embedded Pi agent to generate an activity summary
  - Sends the activity via `POST /api/claw/activity`
- **Status metadata**
  - Listens to `api.on("llm_output", ...)`
  - Extracts token usage from `llm_output.usage`
  - Reads a snapshot of installed skills from workspace `skills/<skill-name>/SKILL.md`
  - Sends status metadata via `POST /api/claw/status`

The plugin reads ClawWorld configuration from `~/.openclaw/clawworld/config.json` and uses a dedicated ClawWorld logger helper for plugin logs.

## Files

- `package.json`
- `openclaw.plugin.json`
- `index.ts`

## Current Behavior

### Activity summary

On each `llm_input`, the plugin will:

1. Check whether activity has already been reported for the session within the last 1 minute; if so, it skips reporting
2. Wait for the transcript to be written, then read recent session messages
3. Generate a summary
4. The summary prompt first inspects the latest user message; if it looks like a heartbeat, health check, keepalive, or probe, or if there is no clear work topic, it returns `NONE`
5. If `NONE` is returned, `/api/claw/activity` is not called for this event
6. Otherwise, generate an `activity_id`, include the model provider, model, and OpenClaw version resolved from the current session, and call `/api/claw/activity`
7. Write the local result to `logs/clawworld-activity-summary-test.jsonl` under the workspace

### Status metadata

On each `llm_output`, the plugin will:

1. Read `usage.input` / `usage.output`
2. Resolve the current agent workspace
3. Scan `<workspace>/skills/*/SKILL.md`
4. Call `/api/claw/status`

The current status payload only includes:

- `token_usage`
- `installed_skills`
- `session_key_hash`
- `instance_id`
- `lobster_id`
- `event_type=message`
- `event_action=sent`

## Notes

- `installed_skills` is currently a **workspace skills snapshot**, not runtime bootstrap files.
- Only directories under `skills/<name>/` that contain `SKILL.md` are treated as installed skills.
- Activity reporting is throttled per session to once every 60 seconds to avoid duplicate pushes in a short time window.
- The activity summary is primarily based on the latest user message; if it looks like a heartbeat or probe, or no clear work topic can be determined, it returns `NONE` and skips reporting.
- All reporting is fire-and-forget; if ClawWorld is unavailable, OpenClaw continues running normally.

## Next Steps

Possible future extensions:

- Report `invoked_skills` via `after_tool_call`
- Improve when `installed_skills` is reported
- Add finer-grained deduplication/merging for status pushes within the same session
- Improve debouncing for activity summaries
