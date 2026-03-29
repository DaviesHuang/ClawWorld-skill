import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createClawWorldLogger } from "./clawworld-logger";

type TranscriptUpdate = {
  sessionFile: string;
  sessionKey?: string;
  message?: unknown;
  messageId?: string;
};

type ClawWorldConfig = {
  deviceToken: string;
  lobsterId: string;
  instanceId: string;
  endpoint: string;
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

function extractMessagePreview(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "<non-object message>";
  }

  const record = message as {
    role?: unknown;
    content?: unknown;
    __openclaw?: { seq?: unknown; id?: unknown; kind?: unknown };
  };

  const role = typeof record.role === "string" ? record.role : "unknown";
  const content = record.content;

  if (typeof content === "string") {
    return `${role}: ${truncate(content)}`;
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
      return `${role}: ${truncate(textParts.join(" "))}`;
    }
  }

  return `${role}: <unrenderable content>`;
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
    const raw = await fs.readFile(configFile, "utf8");
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
      return null;
    }
    return {
      deviceToken: parsed.deviceToken.trim(),
      lobsterId: parsed.lobsterId.trim(),
      instanceId: parsed.instanceId.trim(),
      endpoint: parsed.endpoint.trim().replace(/\/+$/, ""),
    };
  } catch {
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

function formatTranscriptForSummary(messages: unknown[]): string {
  const lines = messages.map((message, index) => `${index + 1}. ${extractMessagePreview(message)}`);
  return lines.join("\n");
}

async function appendJsonlLine(filePath: string, record: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export default definePluginEntry({
  id: "clawworld",
  name: "ClawWorld",
  description: "ClawWorld plugin PoC that summarizes transcript updates into a workspace log.",
  register(api) {
    const logger = createClawWorldLogger("plugin", api.logger);

    let unsubscribe: (() => void) | null = null;
    let workspaceLogsDir: string | null = null;
    let clawWorldConfig: ClawWorldConfig | null = null;
    const inFlightSessions = new Set<string>();

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
      const prompt = [
        "You are generating a short, safe activity summary for a coding session.",
        "Summarize what the agent appears to be doing based on the recent messages below.",
        "Requirements:",
        "- Output only plain text.",
        "- 1 sentence, max 140 characters if possible.",
        "- Focus on the current task/activity.",
        "- Do not include secrets, credentials, or long quotations.",
        "- If the task is unclear, say 'Working on an unclear task'.",
        "",
        "RECENT_MESSAGES:",
        formatTranscriptForSummary(messages),
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

    async function handleUpdate(update: TranscriptUpdate): Promise<void> {
      const sessionRef = update.sessionKey?.trim();
      const updateLabel = sessionRef || update.sessionFile;

      logger.info(
        `[clawworld] transcript update: sessionKey=${sessionRef ?? "<missing>"} messageId=${update.messageId ?? "<missing>"} sessionFile=${update.sessionFile}`,
      );

      if (!sessionRef) {
        logger.info(
          `[clawworld] skip summary generation because sessionKey is missing for ${updateLabel}`,
        );
        return;
      }

      if (inFlightSessions.has(sessionRef)) {
        logger.debug(`[clawworld] skip overlapping summary run for ${sessionRef}`);
        return;
      }

      inFlightSessions.add(sessionRef);
      try {
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

        if (!clawWorldConfig) {
          logger.info("[clawworld] skip activity POST because ClawWorld config is unavailable");
          return;
        }

        const activityId = buildActivityId({
          lobsterId: clawWorldConfig.lobsterId,
          activityAt,
          sessionKeyHash,
          kind,
          summary,
        });

        await postActivity({
          config: clawWorldConfig,
          activityAt,
          activityId,
          sessionKeyHash,
          kind,
          summary,
        });

        await appendJsonlLine(outputFile, {
          ts: activityAt,
          sessionKey: sessionRef,
          sessionFile: update.sessionFile,
          messageId: update.messageId,
          recentMessageCount: messages.length,
          sessionKeyHash,
          activityId,
          kind,
          summary,
          posted: true,
        });

        logger.info(`[clawworld] summary posted for ${sessionRef}: ${summary}`);
      } catch (err) {
        logger.warn(
          `[clawworld] failed to summarize recent messages for ${sessionRef}: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        inFlightSessions.delete(sessionRef);
      }
    }

    api.registerService({
      id: "clawworld-listener",
      async start(ctx) {
        const serviceLogger = createClawWorldLogger("service", ctx.logger);
        if (unsubscribe) {
          return;
        }

        const logsDir = await resolveLogsDir();
        clawWorldConfig = await loadClawWorldConfig();
        unsubscribe = api.runtime.events.onSessionTranscriptUpdate((update) => {
          void handleUpdate(update as TranscriptUpdate);
        });

        serviceLogger.info("transcript listener started", {
          logsDir,
          configLoaded: clawWorldConfig ? "yes" : "no",
        });
      },
      stop(ctx) {
        const serviceLogger = createClawWorldLogger("service", ctx.logger);
        unsubscribe?.();
        unsubscribe = null;
        serviceLogger.info("transcript listener stopped");
      },
    });
  },
});
