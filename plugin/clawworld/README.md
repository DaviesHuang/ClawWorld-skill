# ClawWorld Plugin

安装：

```bash
openclaw plugins install openclaw-plugin-clawworld
```

当前插件包含两条上报链路：

- **Recent Activity summary**
  - 监听 `api.runtime.events.onSessionTranscriptUpdate(...)`
  - 读取最近 session messages
  - 调 embedded Pi agent 生成 activity summary
  - 调用 `POST /api/claw/activity` 上报 activity
- **Status metadata**
  - 监听 `api.on("llm_output", ...)`
  - 从 `llm_output.usage` 提取 token usage
  - 从 workspace `skills/<skill-name>/SKILL.md` 读取 installed skills 快照
  - 调用 `POST /api/claw/status` 上报 status metadata

插件会从 `~/.openclaw/clawworld/config.json` 读取 ClawWorld 配置，并使用单独的 ClawWorld logger helper 输出插件日志。

## 文件

- `package.json`
- `openclaw.plugin.json`
- `index.ts`

## 当前行为

### Activity summary

每次 transcript 更新时，插件会：

1. 读取最近 session messages
2. 生成 summary
3. 生成 `activity_id`
4. 调用 `/api/claw/activity`
5. 把本地结果写入 workspace 下的 `logs/clawworld-activity-summary-test.jsonl`

### Status metadata

每次 `llm_output` 时，插件会：

1. 读取 `usage.input` / `usage.output`
2. 解析当前 agent 的 workspace
3. 扫描 `<workspace>/skills/*/SKILL.md`
4. 调用 `/api/claw/status`

当前 status payload 只包含：

- `token_usage`
- `installed_skills`
- `session_key_hash`
- `instance_id`
- `lobster_id`
- `event_type=message`
- `event_action=sent`

## 说明

- `installed_skills` 当前是 **workspace skills 快照**，不是 runtime bootstrapFiles。
- 只有目录中存在 `SKILL.md` 的 `skills/<name>/` 才会被视为一个 skill。
- 所有上报都是 fire-and-forget；ClawWorld 不可用时不会影响 OpenClaw 正常运行。

## 下一步

后续可以继续扩展为：

- 用 `after_tool_call` 上报 `invoked_skills`
- 优化 `installed_skills` 上报时机
- 给同一 session 的 status push 做更细粒度去重/合并
- 优化 activity summary 的 debounce
