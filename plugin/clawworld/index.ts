import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { clawworldChannelPlugin } from "./channel";
import { createClawWorldLogger } from "./clawworld-logger";

type ClawWorldConfig = {
  deviceToken: string;
  lobsterId: string;
  instanceId: string;
  endpoint: string;
};

type StatusPayload = {
  instance_id: string;
  lobster_id: string;
  event_type: string;
  event_action: string;
  timestamp: string;
  session_key_hash: string;
  installed_skills?: string[];
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
};

type SessionEntryLike = {
  modelProvider?: unknown;
  model?: unknown;
  providerOverride?: unknown;
  modelOverride?: unknown;
  authProfileOverride?: unknown;
  authProfileOverrideSource?: unknown;
};

type PayloadText = {
  text?: string;
  isReasoning?: boolean;
  isError?: boolean;
};

function truncate(value: string, max = 160): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function isNoActivitySummary(value: string): boolean {
  return value.trim().toUpperCase() === "NONE";
}

function extractMessageRole(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "unknown";
  }

  const record = message as {
    role?: unknown;
  };

  return typeof record.role === "string" ? record.role.trim().toLowerCase() || "unknown" : "unknown";
}

function extractMessageBody(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "<non-object message>";
  }

  const record = message as {
    content?: unknown;
  };
  const content = record.content;

  if (typeof content === "string") {
    const normalized = content.replace(/\s+/g, " ").trim();
    return normalized || "<empty content>";
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }
        const item = part as { type?: unknown; text?: unknown };
        if (item.type === "text" && typeof item.text === "string") {
          return item.text;
        }
        return typeof item.type === "string" ? `<${item.type}>` : "";
      })
      .filter(Boolean);

    if (textParts.length > 0) {
      return textParts.join(" ").replace(/\s+/g, " ").trim();
    }
  }

  return "<unrenderable content>";
}

function extractMessagePreview(message: unknown, max = 160): string {
  const role = extractMessageRole(message);
  const body = extractMessageBody(message);
  return `${role}: ${truncate(body, max)}`;
}

function findLatestUserMessage(messages: unknown[]): { index: number; preview: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (extractMessageRole(messages[index]) === "user") {
      return {
        index,
        preview: extractMessagePreview(messages[index], 280),
      };
    }
  }
  return null;
}

function formatRecentContextForSummary(messages: unknown[], latestUserIndex: number | null): string {
  const end = latestUserIndex == null ? messages.length : latestUserIndex;
  const start = Math.max(0, end - 4);
  const contextLines = messages
    .slice(start, end)
    .map((message, offset) => `${start + offset + 1}. ${extractMessagePreview(message)}`);

  return contextLines.length > 0 ? contextLines.join("\n") : "<none>";
}

function resolveAgentIdFromSessionKey(sessionKey: string): string {
  const parts = sessionKey.split(":");
  if (parts[0] === "agent" && typeof parts[1] === "string" && parts[1].trim()) {
    return parts[1].trim().toLowerCase();
  }
  return "main";
}

function resolveConfiguredModelRef(config: unknown, agentId: string): string | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const cfg = config as {
    agents?: {
      defaults?: { model?: unknown };
      list?: Array<{ id?: unknown; model?: unknown; default?: unknown }>;
    };
  };

  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  const matching = entries.find(
    (entry) => typeof entry?.id === "string" && entry.id.trim().toLowerCase() === agentId,
  );
  const fallbackDefault = entries.find((entry) => entry?.default === true);
  const raw = matching?.model ?? fallbackDefault?.model ?? cfg.agents?.defaults?.model;

  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }
  if (raw && typeof raw === "object") {
    const primary = (raw as { primary?: unknown }).primary;
    if (typeof primary === "string" && primary.trim()) {
      return primary.trim();
    }
  }
  return undefined;
}

function resolveProviderModelFromSession(params: {
  sessionEntry?: SessionEntryLike;
  configuredModelRef?: string;
  defaultProvider: string;
  defaultModel: string;
}): { provider: string; model: string } {
  const entry = params.sessionEntry;
  const providerOverride =
    typeof entry?.providerOverride === "string" ? entry.providerOverride.trim() : "";
  const modelOverride = typeof entry?.modelOverride === "string" ? entry.modelOverride.trim() : "";
  const modelProvider = typeof entry?.modelProvider === "string" ? entry.modelProvider.trim() : "";
  const model = typeof entry?.model === "string" ? entry.model.trim() : "";
  const configuredModelRef = params.configuredModelRef?.trim() ?? "";

  if (providerOverride && modelOverride) {
    return { provider: providerOverride, model: modelOverride };
  }
  if (modelProvider && model) {
    return { provider: modelProvider, model };
  }
  if (!modelProvider && model.includes("/")) {
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash).trim();
    const resolvedModel = model.slice(slash + 1).trim();
    if (provider && resolvedModel) {
      return { provider, model: resolvedModel };
    }
  }
  if (configuredModelRef.includes("/")) {
    const slash = configuredModelRef.indexOf("/");
    const provider = configuredModelRef.slice(0, slash).trim();
    const resolvedModel = configuredModelRef.slice(slash + 1).trim();
    if (provider && resolvedModel) {
      return { provider, model: resolvedModel };
    }
  }
  if (model) {
    return { provider: params.defaultProvider, model };
  }
  return {
    provider: params.defaultProvider,
    model: configuredModelRef || params.defaultModel,
  };
}

function resolveAuthProfile(entry?: SessionEntryLike): {
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
} {
  const authProfileId =
    typeof entry?.authProfileOverride === "string" ? entry.authProfileOverride.trim() : "";
  const authProfileIdSource =
    entry?.authProfileOverrideSource === "auto" || entry?.authProfileOverrideSource === "user"
      ? entry.authProfileOverrideSource
      : undefined;
  if (!authProfileId) {
    return {};
  }
  return {
    authProfileId,
    authProfileIdSource,
  };
}

function hashSessionKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

function buildActivityId(params: {
  lobsterId: string;
  activityAt: string;
  sessionKeyHash: string;
  kind: string;
  summary: string;
}): string {
  const raw = [
    params.lobsterId,
    params.activityAt,
    params.sessionKeyHash,
    params.kind,
    params.summary,
  ].join("|");
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

async function loadClawWorldConfig(): Promise<ClawWorldConfig | null> {
  const configFile = path.join(os.homedir(), ".openclaw", "clawworld", "config.json");
  try {
    const raw = (await fs.readFile(configFile, "utf8")).replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw) as Partial<ClawWorldConfig>;
    if (
      typeof parsed.deviceToken !== "string" ||
      !parsed.deviceToken.trim() ||
      typeof parsed.lobsterId !== "string" ||
      !parsed.lobsterId.trim() ||
      typeof parsed.instanceId !== "string" ||
      !parsed.instanceId.trim() ||
      typeof parsed.endpoint !== "string" ||
      !parsed.endpoint.trim()
    ) {
      console.log(
        `[clawworld] invalid config at ${configFile}: missing required fields (home=${os.homedir()})`,
      );
      return null;
    }

    const config = {
      deviceToken: parsed.deviceToken.trim(),
      lobsterId: parsed.lobsterId.trim(),
      instanceId: parsed.instanceId.trim(),
      endpoint: parsed.endpoint.trim().replace(/\/+$/, ""),
    };

    console.log(
      `[clawworld] loaded config from ${configFile} home=${os.homedir()} endpoint=${config.endpoint} lobsterId=${config.lobsterId} instanceId=${config.instanceId} deviceTokenPrefix=${config.deviceToken.slice(0, 8)}`,
    );

    return config;
  } catch (err) {
    console.log(
      `[clawworld] failed to read config from ${configFile} home=${os.homedir()}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

async function postActivity(params: {
  config: ClawWorldConfig;
  activityAt: string;
  activityId: string;
  sessionKeyHash: string;
  kind: string;
  summary: string;
}): Promise<void> {
  const response = await fetch(`${params.config.endpoint}/api/claw/activity`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.config.deviceToken}`,
    },
    body: JSON.stringify({
      instance_id: params.config.instanceId,
      lobster_id: params.config.lobsterId,
      activity_at: params.activityAt,
      activity_id: params.activityId,
      session_key_hash: params.sessionKeyHash,
      kind: params.kind,
      summary: params.summary,
    }),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`activity POST failed: ${response.status} ${text}`.trim());
  }
}

async function postStatus(params: {
  config: ClawWorldConfig;
  payload: StatusPayload;
}): Promise<void> {
  const response = await fetch(`${params.config.endpoint}/api/claw/status`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.config.deviceToken}`,
    },
    body: JSON.stringify(params.payload),
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`status POST failed: ${response.status} ${text}`.trim());
  }
}

function collectPayloadText(payloads: unknown): string {
  if (!Array.isArray(payloads)) {
    return "";
  }
  return payloads
    .map((payload) => {
      if (!payload || typeof payload !== "object") {
        return "";
      }
      const item = payload as PayloadText;
      if (item.isReasoning || item.isError || typeof item.text !== "string") {
        return "";
      }
      return item.text.trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

async function appendJsonlLine(filePath: string, record: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export default definePluginEntry({
  id: "openclaw-plugin-clawworld",
  name: "ClawWorld",
  description: "ClawWorld plugin that posts Recent Activity on llm_input and status on llm_output.",
  register(api) {
    const logger = createClawWorldLogger("plugin", api.logger);
    const _api = api as any;
    if (typeof _api.registerChannel === "function") {
      _api.registerChannel({ plugin: clawworldChannelPlugin });
      logger.info("[clawworld-channel] registered via api.registerChannel");
    } else {
      logger.warn("[clawworld-channel] no registerChannel; keys: " + Object.keys(_api).join(","));
    }

    let workspaceLogsDir: string | null = null;
    let clawWorldConfig: ClawWorldConfig | null = null;
    const inFlightSessions = new Set<string>();
    const lastStatusPushAtBySession = new Map<string, number>();
    const lastActivityPushAtBySession = new Map<string, number>();
    const MIN_STATUS_PUSH_INTERVAL_MS = 3_000;
    const MIN_ACTIVITY_PUSH_INTERVAL_MS = 60_000;

    async function loadInstalledSkillsFromWorkspace(sessionKey: string): Promise<string[] | undefined> {
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const workspaceDir = api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
      if (!workspaceDir) {
        return undefined;
      }

      const skillsDir = path.join(workspaceDir, "skills");
      try {
        const entries = await fs.readdir(skillsDir, { withFileTypes: true });
        const checks = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory())
            .map(async (entry) => {
              const skillName = entry.name.trim();
              if (!skillName) {
                return null;
              }
              try {
                await fs.access(path.join(skillsDir, skillName, "SKILL.md"));
                return skillName;
              } catch {
                return null;
              }
            }),
        );
        const skills = checks.filter((value): value is string => Boolean(value));
        if (skills.length === 0) {
          return undefined;
        }
        return [...new Set(skills)].sort();
      } catch {
        return undefined;
      }
    }

    async function ensureClawWorldConfig(): Promise<ClawWorldConfig | null> {
      if (clawWorldConfig) {
        return clawWorldConfig;
      }
      clawWorldConfig = await loadClawWorldConfig();
      return clawWorldConfig;
    }

    api.on("session_start", (event, ctx) => {
      void (async () => {
        const sessionKey = ctx.sessionKey?.trim() ?? event.sessionKey?.trim();

        logger.debug("[clawworld] session_start event fired", {
          sessionId: event.sessionId,
          sessionKey,
          agentId: ctx.agentId,
          resumedFrom: event.resumedFrom,
        });

        if (!sessionKey) {
          logger.warn("[clawworld] skip SessionStart POST because sessionKey is missing");
          return;
        }

        const config = await ensureClawWorldConfig();
        if (!config) {
          logger.warn("[clawworld] skip SessionStart POST because ClawWorld config is unavailable");
          return;
        }

        const payload: StatusPayload = {
          instance_id: config.instanceId,
          lobster_id: config.lobsterId,
          event_type: "openclaw",
          event_action: "SessionStart",
          timestamp: new Date().toISOString(),
          session_key_hash: hashSessionKey(sessionKey),
        };

        try {
          await postStatus({ config, payload });
          logger.debug(`[clawworld] SessionStart posted for ${sessionKey}`, {
            sessionKeyHash: payload.session_key_hash,
          });
        } catch (err) {
          logger.warn(
            `[clawworld] failed to post SessionStart for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    });

    api.on("session_end", (event, ctx) => {
      void (async () => {
        const sessionKey = ctx.sessionKey?.trim() ?? event.sessionKey?.trim();

        logger.debug("[clawworld] session_end event fired", {
          sessionId: event.sessionId,
          sessionKey,
          agentId: ctx.agentId,
          messageCount: event.messageCount,
          durationMs: event.durationMs,
        });

        if (!sessionKey) {
          logger.warn("[clawworld] skip SessionEnd POST because sessionKey is missing");
          return;
        }

        const config = await ensureClawWorldConfig();
        if (!config) {
          logger.warn("[clawworld] skip SessionEnd POST because ClawWorld config is unavailable");
          return;
        }

        const payload: StatusPayload = {
          instance_id: config.instanceId,
          lobster_id: config.lobsterId,
          event_type: "openclaw",
          event_action: "SessionEnd",
          timestamp: new Date().toISOString(),
          session_key_hash: hashSessionKey(sessionKey),
        };

        try {
          await postStatus({ config, payload });
          logger.debug(`[clawworld] SessionEnd posted for ${sessionKey}`, {
            sessionKeyHash: payload.session_key_hash,
          });
        } catch (err) {
          logger.warn(
            `[clawworld] failed to post SessionEnd for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    });

    api.on("llm_input", (event, ctx) => {
      void (async () => {
        const sessionKey = ctx.sessionKey?.trim();
        const isInternalSummaryRun =
          typeof event.runId === "string" && event.runId.startsWith("clawworld-summary-");

        logger.debug("[clawworld] llm_input event fired", {
          runId: event.runId,
          sessionId: event.sessionId,
          sessionKey,
          agentId: ctx.agentId,
          provider: event.provider,
          model: event.model,
          isInternalSummaryRun,
        });

        if (!sessionKey) {
          logger.warn("[clawworld] skip llm_input handling because sessionKey is missing");
          return;
        }

        if (isInternalSummaryRun) {
          logger.debug(`[clawworld] skip llm_input handling for internal summary run ${event.runId}`);
          return;
        }

        const config = await ensureClawWorldConfig();
        if (!config) {
          logger.warn("[clawworld] skip llm_input handling because ClawWorld config is unavailable");
          return;
        }

        const payload: StatusPayload = {
          instance_id: config.instanceId,
          lobster_id: config.lobsterId,
          event_type: "openclaw",
          event_action: "UserPromptSubmit",
          timestamp: new Date().toISOString(),
          session_key_hash: hashSessionKey(sessionKey),
        };

        try {
          await postStatus({ config, payload });
          logger.debug(`[clawworld] UserPromptSubmit posted for ${sessionKey}`, {
            sessionKeyHash: payload.session_key_hash,
          });
        } catch (err) {
          logger.warn(
            `[clawworld] failed to post UserPromptSubmit for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        await handleActivityFromLlmInput({
          config,
          sessionKey,
          runId: typeof event.runId === "string" ? event.runId : undefined,
          sessionId: typeof event.sessionId === "string" ? event.sessionId : undefined,
        });
      })();
    });

    api.on("llm_output", (event, ctx) => {
      void (async () => {
        const usage = event.usage;
        const sessionKey = ctx.sessionKey?.trim();
        const isInternalSummaryRun =
          typeof event.runId === "string" && event.runId.startsWith("clawworld-summary-");

        logger.debug("[clawworld] llm_output event fired", {
          runId: event.runId,
          sessionId: event.sessionId,
          sessionKey,
          agentId: ctx.agentId,
          provider: event.provider,
          model: event.model,
          usage: usage ?? null,
          assistantTextCount: Array.isArray(event.assistantTexts) ? event.assistantTexts.length : 0,
          isInternalSummaryRun,
        });

        if (!sessionKey) {
          logger.warn("[clawworld] skip status POST because sessionKey is missing");
          return;
        }

        if (isInternalSummaryRun) {
          logger.debug(`[clawworld] skip llm_output status POST for internal summary run ${event.runId}`);
          return;
        }

        if (!usage || (usage.input == null && usage.output == null)) {
          logger.warn(`[clawworld] skip status POST because usage is empty for ${sessionKey}`);
          return;
        }

        const config = await ensureClawWorldConfig();
        if (!config) {
          logger.warn("[clawworld] skip status POST because ClawWorld config is unavailable");
          return;
        }

        const now = Date.now();
        const lastPushAt = lastStatusPushAtBySession.get(sessionKey) ?? 0;
        if (now - lastPushAt < MIN_STATUS_PUSH_INTERVAL_MS) {
          logger.warn(`[clawworld] skip status POST due to throttle for ${sessionKey}`);
          return;
        }
        lastStatusPushAtBySession.set(sessionKey, now);

        const installedSkills = await loadInstalledSkillsFromWorkspace(sessionKey);

        const payload: StatusPayload = {
          instance_id: config.instanceId,
          lobster_id: config.lobsterId,
          event_type: "openclaw",
          event_action: "Stop",
          timestamp: new Date().toISOString(),
          session_key_hash: hashSessionKey(sessionKey),
          ...(installedSkills?.length ? { installed_skills: installedSkills } : {}),
          token_usage: {
            ...(usage.input != null ? { input_tokens: usage.input } : {}),
            ...(usage.output != null ? { output_tokens: usage.output } : {}),
          },
        };

        try {
          await postStatus({ config, payload });
          logger.debug(`[clawworld] status posted for ${sessionKey}`, {
            sessionKeyHash: payload.session_key_hash,
            tokenUsage: payload.token_usage,
          });
        } catch (err) {
          logger.warn(
            `[clawworld] failed to post status for ${sessionKey}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      })();
    });


    async function resolveLogsDir(): Promise<string> {
      if (workspaceLogsDir) {
        return workspaceLogsDir;
      }
      const workspaceDir =
        api.runtime.agent.resolveAgentWorkspaceDir(api.config) ?? process.cwd();
      workspaceLogsDir = path.join(workspaceDir, "logs");
      await fs.mkdir(workspaceLogsDir, { recursive: true });
      return workspaceLogsDir;
    }

    async function summarizeRecentMessages(sessionKey: string, messages: unknown[]): Promise<string> {
      const logsDir = await resolveLogsDir();
      const summarySessionId = `clawworld-summary-${crypto
        .createHash("sha1")
        .update(sessionKey)
        .digest("hex")
        .slice(0, 12)}`;
      const summarySessionFile = path.join(logsDir, `${summarySessionId}.jsonl`);
      const agentId = resolveAgentIdFromSessionKey(sessionKey);
      const storePath = api.runtime.agent.session.resolveStorePath(undefined, { agentId });
      const sessionStore = api.runtime.agent.session.loadSessionStore(storePath, {
        skipCache: true,
      }) as Record<string, SessionEntryLike>;
      const sessionEntry = sessionStore[sessionKey] ?? sessionStore[sessionKey.toLowerCase()];
      const configuredModelRef = resolveConfiguredModelRef(api.config, agentId);
      const { provider, model } = resolveProviderModelFromSession({
        sessionEntry,
        configuredModelRef,
        defaultProvider: api.runtime.agent.defaults.provider,
        defaultModel: api.runtime.agent.defaults.model,
      });
      const { authProfileId, authProfileIdSource } = resolveAuthProfile(sessionEntry);
      const latestUserMessage = findLatestUserMessage(messages);
      const latestUserPreview = latestUserMessage?.preview ?? "<missing>";
      const recentContext = formatRecentContextForSummary(messages, latestUserMessage?.index ?? null);
      const prompt = [
        "You are generating a short, safe activity summary for a coding session.",
        "Decide whether the LATEST_USER_MESSAGE indicates a real, concrete work topic.",
        "Requirements:",
        "- Output only plain text.",
        "- If there is no clear, concrete work topic, output exactly NONE.",
        "- Output exactly NONE if the latest user message is a heartbeat, ping, pong, health check, keepalive, noop, status probe, connection test, or similar non-work probe.",
        "- Output exactly NONE if the latest user message is meta-only, transitional, too vague, missing, or cannot be understood confidently.",
        "- Do NOT infer a work topic from older context alone.",
        "- RECENT_CONTEXT is only supporting evidence; the latest user message must itself justify the activity.",
        "- Otherwise output exactly 1 short sentence, max 140 characters if possible.",
        "- Focus on the current task/activity, not generic effort.",
        "- Do not include secrets, credentials, or long quotations.",
        "- Do not explain your reasoning.",
        "",
        "LATEST_USER_MESSAGE:",
        latestUserPreview,
        "",
        "RECENT_CONTEXT:",
        recentContext,
      ].join("\n");

      logger.info(
        `[clawworld] summary runner for ${sessionKey}: agentId=${agentId} provider=${provider} model=${model} authProfile=${authProfileId ?? "<none>"}`,
      );

      const result = await api.runtime.agent.runEmbeddedPiAgent({
        sessionId: summarySessionId,
        sessionKey,
        agentId,
        runId: `clawworld-summary-${Date.now()}`,
        sessionFile: summarySessionFile,
        agentDir: api.runtime.agent.resolveAgentDir(api.config, agentId),
        workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId),
        config: api.config,
        prompt,
        provider,
        model,
        ...(authProfileId ? { authProfileId } : {}),
        ...(authProfileIdSource ? { authProfileIdSource } : {}),
        timeoutMs: api.runtime.agent.resolveAgentTimeoutMs({ cfg: api.config }),
        disableTools: true,
      });

      const text = collectPayloadText(result.payloads);
      if (!text) {
        throw new Error("embedded summarizer returned empty output");
      }
      return truncate(text, 280);
    }

    async function handleActivityFromLlmInput(params: {
      config: ClawWorldConfig;
      sessionKey: string;
      runId?: string;
      sessionId?: string;
    }): Promise<void> {
      const sessionRef = params.sessionKey.trim();

      logger.info(
        `[clawworld] activity trigger (llm_input): sessionKey=${sessionRef} runId=${params.runId ?? "<missing>"} sessionId=${params.sessionId ?? "<missing>"}`,
      );

      const now = Date.now();
      const lastPushAt = lastActivityPushAtBySession.get(sessionRef) ?? 0;
      if (now - lastPushAt < MIN_ACTIVITY_PUSH_INTERVAL_MS) {
        logger.debug(`[clawworld] skip activity POST due to 60s throttle for ${sessionRef}`);
        return;
      }

      if (inFlightSessions.has(sessionRef)) {
        logger.debug(`[clawworld] skip overlapping activity run for ${sessionRef}`);
        return;
      }

      inFlightSessions.add(sessionRef);
      try {
        await new Promise((resolve) => setTimeout(resolve, 150));

        const { messages } = await api.runtime.subagent.getSessionMessages({
          sessionKey: sessionRef,
          limit: 8,
        });

        const previews = messages.slice(-3).map(extractMessagePreview);
        logger.info(
          `[clawworld] recent messages for ${sessionRef} (count=${messages.length}): ${previews.length > 0 ? previews.join(" | ") : "<empty>"}`,
        );

        const summary = await summarizeRecentMessages(sessionRef, messages);
        const logsDir = await resolveLogsDir();
        const outputFile = path.join(logsDir, "clawworld-activity-summary-test.jsonl");
        const activityAt = new Date().toISOString();
        const sessionKeyHash = hashSessionKey(sessionRef);
        const kind = "other";

        if (isNoActivitySummary(summary)) {
          await appendJsonlLine(outputFile, {
            ts: activityAt,
            source: "llm_input",
            runId: params.runId,
            sessionId: params.sessionId,
            sessionKey: sessionRef,
            recentMessageCount: messages.length,
            sessionKeyHash,
            kind,
            summary,
            posted: false,
            skippedReason: "no_clear_work_topic",
          });
          logger.info(`[clawworld] skip activity POST for ${sessionRef} because summary returned NONE`);
          return;
        }

        const activityId = buildActivityId({
          lobsterId: params.config.lobsterId,
          activityAt,
          sessionKeyHash,
          kind,
          summary,
        });

        await postActivity({
          config: params.config,
          activityAt,
          activityId,
          sessionKeyHash,
          kind,
          summary,
        });
        lastActivityPushAtBySession.set(sessionRef, Date.now());

        await appendJsonlLine(outputFile, {
          ts: activityAt,
          source: "llm_input",
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: sessionRef,
          recentMessageCount: messages.length,
          sessionKeyHash,
          activityId,
          kind,
          summary,
          posted: true,
        });

        logger.info(`[clawworld] activity posted for ${sessionRef}: ${summary}`);
      } catch (err) {
        logger.warn(
          `[clawworld] failed to post activity for ${sessionRef} on llm_input: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        inFlightSessions.delete(sessionRef);
      }
    }
  },
});