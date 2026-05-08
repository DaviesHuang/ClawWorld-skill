console.log("[clawworld-channel] channel.ts loaded");
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import WebSocket from "ws";

// ── Config ────────────────────────────────────────────────────────────────────

interface ClawWorldChannelConfig {
  deviceToken: string;
  lobsterId:   string;
  instanceId:  string;
  endpoint:    string;
  wsEndpoint:  string;
}

const CONFIG_FILE = path.join(os.homedir(), ".openclaw", "clawworld", "config.json");
let _cachedLobsterId: string | null = null;

async function readChannelConfig(): Promise<ClawWorldChannelConfig | null> {
  try {
    const raw = (await fs.readFile(CONFIG_FILE, "utf8")).replace(/^﻿/, "");
    const parsed = JSON.parse(raw) as Partial<ClawWorldChannelConfig>;
    if (!parsed.deviceToken || !parsed.lobsterId || !parsed.instanceId || !parsed.endpoint) {
      return null;
    }
    return {
      deviceToken: parsed.deviceToken.trim(),
      lobsterId:   parsed.lobsterId.trim(),
      instanceId:  parsed.instanceId.trim(),
      endpoint:    parsed.endpoint.trim().replace(/\/+$/, ""),
      wsEndpoint:  (parsed.wsEndpoint ?? "").trim(),
    };
  } catch {
    return null;
  }
}

// ── WebSocket inbound ─────────────────────────────────────────────────────────

interface ClawWorldInboundMessage {
  type: "message" | "ping" | "pong";
  messageId: string;
  content: string;
  createdAt: string;
}

async function ackMessage(cfg: ClawWorldChannelConfig, messageId: string): Promise<void> {
  try {
    await fetch(`${cfg.endpoint}/api/lobster/pending/${encodeURIComponent(messageId)}/ack`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.deviceToken}` },
    });
  } catch { /* best effort */ }
}

async function drainPending(
  cfg: ClawWorldChannelConfig,
  onMessage: (msg: ClawWorldInboundMessage) => Promise<void>,
): Promise<void> {
  try {
    const resp = await fetch(`${cfg.endpoint}/api/lobster/pending`, {
      headers: { Authorization: `Bearer ${cfg.deviceToken}` },
    });
    if (!resp.ok) return;
    const { messages } = (await resp.json()) as { messages: ClawWorldInboundMessage[] };
    for (const msg of messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      await onMessage(msg);
      await ackMessage(cfg, msg.messageId);
    }
  } catch { /* endpoint not yet deployed */ }
}

async function runClawworldWebSocket(opts: {
  cfg: ClawWorldChannelConfig;
  abortSignal: AbortSignal;
  onMessage: (msg: ClawWorldInboundMessage) => Promise<void>;
  onFirstConnect?: () => Promise<void>;
}): Promise<void> {
  const { cfg, abortSignal, onMessage } = opts;

  // Dedup messageIds so drain and WebSocket don't double-dispatch the same message
  const dispatched = new Set<string>();
  const safeOnMessage = async (msg: ClawWorldInboundMessage) => {
    if (dispatched.has(msg.messageId)) return;
    dispatched.add(msg.messageId);
    await onMessage(msg);
  };

  // Drain pending messages in parallel with WebSocket connect so the WS connection
  // (which signals wsConnected=true to the frontend) isn't blocked on the HTTP round-trip.
  drainPending(cfg, safeOnMessage).catch(() => {});

  return new Promise<void>(resolve => {
    let backoffMs = 1_000;
    let currentWs: WebSocket | null = null;
    let hasGreeted = false; // fire onFirstConnect only on the first successful open

    const connect = () => {
      if (abortSignal.aborted) return;

      // API Gateway WS requires HTTP/1.1 — use the `ws` package, not native WebSocket
      // Token passed via query string because API Gateway $connect doesn't support custom auth headers
      const ws = new WebSocket(`${cfg.wsEndpoint}?token=${cfg.deviceToken}`);
      currentWs = ws;

      let pingInterval: ReturnType<typeof setInterval> | null = null;

      ws.onopen = () => {
        backoffMs = 1_000; // reset backoff on successful connect
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 60_000); // heartbeat every 60s to outlast API Gateway's 2h idle timeout
        if (!hasGreeted) {
          hasGreeted = true;
          opts.onFirstConnect?.().catch((e: any) => {
            console.error("[clawworld-channel] onFirstConnect error:", e?.message ?? e);
          });
        }
      };

      ws.onmessage = async (event) => {
        let msg: ClawWorldInboundMessage;
        try {
          msg = JSON.parse(event.data as string) as ClawWorldInboundMessage;
        } catch { return; }
        if (msg.type !== "message") return; // drop pong, ping errors, API Gateway error responses
        await safeOnMessage(msg);
        await ackMessage(cfg, msg.messageId);
      };

      ws.onclose = () => {
        if (pingInterval) clearInterval(pingInterval);
        currentWs = null;
        if (abortSignal.aborted) return;
        setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000); // exponential backoff, cap at 30s
      };

      ws.onerror = () => ws.close(); // triggers onclose → reconnect
    };

    connect();

    abortSignal.addEventListener("abort", () => {
      currentWs?.close();
      resolve();
    });
  });
}

// ── Channel plugin ────────────────────────────────────────────────────────────
// Pairing is handled by the existing SKILL.md bind flow: bind.sh calls POST /api/claw/bind/verify
// and writes ~/.openclaw/clawworld/config.json including wsEndpoint. This plugin reads that config
// on startup — no separate `openclaw channel add` step needed.

const _cwPluginDef = createChatChannelPlugin({
  base: {
    id: "clawworld",

    config: {
      listAccountIds: () => ["default"],
      resolveDefaultTo: () => _cachedLobsterId ?? undefined,
      resolveAccount: async (_accountId?: string) => {
        return await readChannelConfig() ?? {
          deviceToken: "",
          lobsterId:   "",
          instanceId:  "",
          endpoint:    "https://api.claw-world.app",
          wsEndpoint:  "",
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { account: _accountIdOrConfig, cfg, accountId, abortSignal, channelRuntime } = ctx;
        const account = (typeof _accountIdOrConfig === "object" && _accountIdOrConfig !== null && (_accountIdOrConfig as ClawWorldChannelConfig).wsEndpoint)
          ? _accountIdOrConfig as ClawWorldChannelConfig
          : await readChannelConfig();
        if (account?.lobsterId) _cachedLobsterId = account.lobsterId;
        if (!account?.wsEndpoint) {
          console.warn("[clawworld-channel] wsEndpoint not configured, skipping WebSocket connection");
          await new Promise<void>(resolve => abortSignal.addEventListener("abort", resolve, { once: true }));
          return;
        }
        if (!channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
          console.warn("[clawworld-channel] channelRuntime not available; ctx keys:", Object.keys(ctx || {}));
          await new Promise<void>(resolve => abortSignal.addEventListener("abort", resolve, { once: true }));
          return;
        }
        const ingest = async (payload: any) => {
          try {
            const text = (payload as any)?.text ?? "";
            if (!text) return;
            const resp = await fetch(`${account.endpoint}/api/lobster/ingest`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${account.deviceToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ content: text }),
            });
            console.log("[clawworld-channel] ingest response:", resp.status);
          } catch (e: any) {
            console.error("[clawworld-channel] deliver error:", e?.message ?? e);
          }
        };

        await runClawworldWebSocket({
          cfg: account,
          abortSignal,
          onFirstConnect: async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                if (attempt > 0) await new Promise<void>(r => setTimeout(r, 5_000));
                await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: {
                    Body: "[system] You have just started up and connected to your user's ClawWorld. Please reply with a short, friendly greeting to let them know you are online and ready to help.",
                    From: `clawworld:${account.lobsterId}`,
                    To: account.lobsterId,
                    AccountId: accountId ?? "default",
                  },
                  cfg,
                  dispatcherOptions: { deliver: ingest },
                });
                break;
              } catch (e: any) {
                console.warn(`[clawworld-channel] greeting attempt ${attempt + 1} failed:`, e?.message ?? e);
              }
            }
          },
          onMessage: async (msg) => {
            console.log("[clawworld-channel] dispatching message to agent:", msg.messageId);
            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: {
                Body: msg.content,
                From: `clawworld:${account.lobsterId}`,
                To: account.lobsterId,
                AccountId: accountId ?? "default",
              },
              cfg,
              dispatcherOptions: { deliver: ingest },
            });
          },
        });
      },
    },

    messaging: {
      resolveDeliveryTarget: ({ conversationId }: { conversationId: string }) => ({
        to: conversationId,
      }),
    },
  },

  // Outbound: cron/announce delivery — requires attachedResults.sendText so that
  // resolveChatChannelOutbound flattens it and createPluginHandler finds outbound.sendText
  outbound: {
    base: {
      resolveTarget: ({ to }: { to?: string }) => {
        const trimmed = to?.trim();
        if (!trimmed) return { ok: false as const, error: new Error("Delivering to clawworld requires a target lobsterId") };
        return { ok: true as const, to: trimmed };
      },
    },
    attachedResults: {
      channel: "clawworld",
      sendText: async ({ cfg, text }: { cfg: any; text: string }) => {
        const config: ClawWorldChannelConfig | null = (cfg?.deviceToken && cfg?.endpoint)
          ? cfg as ClawWorldChannelConfig
          : await readChannelConfig();
        if (!config?.deviceToken || !text) return;
        const resp = await fetch(`${config.endpoint}/api/lobster/ingest`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.deviceToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: text }),
        });
        console.log("[clawworld-channel] outbound sendText response:", resp.status);
      },
    },
  },

});

export const clawworldChannelPlugin = _cwPluginDef;
export default clawworldChannelPlugin;
