# ClawWorld Plugin PoC

最小 PoC 插件：

- 监听 `api.runtime.events.onSessionTranscriptUpdate(...)`
- 收到更新后读取该 `sessionKey` 最近消息
- 调 embedded Pi agent 生成 activity summary
- 把 summary 写到 OpenClaw workspace 下的 `logs/clawworld-activity-summary-test.jsonl`

## 文件

- `package.json`
- `openclaw.plugin.json`
- `index.ts`

## 当前行为

每次 transcript 更新时，插件会打印：

1. update 本身的 `sessionKey` / `sessionFile` / `messageId`
2. 最近 6 条消息中的最后 3 条预览

## 预期用途

先验证这三件事：

1. 插件可以被 OpenClaw 加载
2. 插件能收到 transcript update
3. 插件能通过 `api.runtime.subagent.getSessionMessages({ sessionKey })` 读到最近消息

## 下一步

PoC 验证通过后，可以继续扩展为：

- debounce 同一 session 的频繁更新
- 调 embedded Pi agent 做 summary
- POST summary 到 ClawWorld backend
