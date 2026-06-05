console.log("[clawworld-channel] channel.ts loaded");
import { createWriteStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import WebSocket from "ws";

// ── Config ────────────────────────────────────────────────────────────────────

interface ClawWorldChannelConfig {
  deviceToken: string;
  lobsterId:   string;
  instanceId:  string;
  endpoint:    string;
  wsEndpoint:  string;
  // entrypoint.sh sets this to true in config.json on the very first deploy so
  // the agent posts a single boot greeting. Subsequent restarts (auto-wakes)
  // omit it, keeping the conversation thread free of restart spam.
  initialGreeting?: boolean;
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
      initialGreeting: parsed.initialGreeting === true,
    };
  } catch {
    return null;
  }
}

// ── Boot greeting variants ────────────────────────────────────────────────────
// Each cold start (initialGreeting=true in config) picks one of these so the
// agent doesn't open with the exact same line every time the container wakes.
// No timezone-aware variants: the container runs in UTC and we don't ship the
// user's local timezone, so randomized stylistic variants are the cheapest
// path to variety. Returns the directive body to pass to the agent, wrapped
// in [system] + "reply with…" so it triggers action=reply (action=send would
// require a target and error out per upstream fix 1470586).
function pickGreetingPrompt(): string {
  const variants = [
    "an upbeat, energetic hello — under 20 words, one emoji allowed.",
    "a thoughtful, slightly contemplative note that you're back online — under 20 words.",
    "a self-deprecating joke about cold start latency to say you're here — under 20 words.",
    "a quick check-in saying you're online, then ask what they're up to — under 20 words.",
    "a curious, friendly hello that wonders what they're working on right now — under 20 words.",
    "a casual, low-key hello — under 20 words, no fanfare.",
    "a warm, friend-who's-been-away-for-a-while reappearance — under 20 words.",
    "a brief, matter-of-fact note that you're here and ready to chat — under 20 words.",
  ];
  const directive = variants[Math.floor(Math.random() * variants.length)];
  return `[system] You have just started up and connected to your user's ClawWorld. Please reply (action=reply) with a short, friendly greeting in this style: ${directive}`;
}

// ── WebSocket inbound ─────────────────────────────────────────────────────────

interface ClawWorldInboundMessage {
  type: "message" | "ping" | "pong";
  messageId: string;
  content: string;
  createdAt: string;
  attachments?: ClawWorldAttachment[];
}

interface ClawWorldAttachment {
  fileId: string;
  direction: "in" | "out";
  kind: "image" | "file";
  name: string;
  mime: string;
  size?: number;
}

// ── Attachment helpers ─────────────────────────────────────────────────────────

const IN_DIR  = path.join(os.homedir(), ".openclaw", "in");
const OUT_DIR = path.join(os.homedir(), ".openclaw", "out");

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Download one inbound attachment from S3 via the deviceToken-authenticated
 * download-url endpoint. Returns the local file path on success, or null.
 */
async function downloadInboundFile(
  cfg: ClawWorldChannelConfig,
  att: ClawWorldAttachment,
): Promise<string | null> {
  const fileDir  = path.join(IN_DIR, att.fileId);
  const filePath = path.join(fileDir, att.name);

  // Skip if already downloaded (idempotent — safe to replay)
  try { await fs.access(filePath); return filePath; } catch { /* not cached */ }

  // ④ Get presigned download URL
  let downloadUrl: string;
  try {
    const resp = await fetch(`${cfg.endpoint}/api/lobster/files/download-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fileId: att.fileId }),
    });
    if (!resp.ok) {
      console.error(`[clawworld-channel] download-url error for ${att.fileId}: ${resp.status}`);
      return null;
    }
    ({ downloadUrl } = (await resp.json()) as { downloadUrl: string });
  } catch (e: any) {
    console.error(`[clawworld-channel] download-url fetch error for ${att.fileId}:`, e?.message ?? e);
    return null;
  }

  // ⑤ Download to local disk
  try {
    await ensureDir(fileDir);
    const resp = await fetch(downloadUrl);
    if (!resp.ok || !resp.body) {
      console.error(`[clawworld-channel] S3 download error for ${att.fileId}: ${resp.status}`);
      return null;
    }
    // Node 20: Readable.fromWeb wraps a web ReadableStream
    await pipeline(Readable.fromWeb(resp.body as any), createWriteStream(filePath));
    console.log(`[clawworld-channel] downloaded: ${filePath}`);
    return filePath;
  } catch (e: any) {
    console.error(`[clawworld-channel] download error for ${att.fileId}:`, e?.message ?? e);
    return null;
  }
}

/**
 * Magic-byte MIME detection via pure Node.js file-header inspection.
 * No external process — reads only the first 16 bytes of the file.
 * Returns the detected MIME type string, or null if unknown.
 *
 * This is the server-side enforcement of §9 of the design doc.
 */
const MAGIC_SIGNATURES: Array<{ mime: string; offset: number; bytes: number[] }> = [
  { mime: "image/png",       offset: 0, bytes: [0x89, 0x50, 0x4E, 0x47] },
  { mime: "image/jpeg",      offset: 0, bytes: [0xFF, 0xD8, 0xFF] },
  { mime: "image/gif",       offset: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp",      offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // RIFF....WEBP
  { mime: "image/bmp",       offset: 0, bytes: [0x42, 0x4D] },
  { mime: "application/pdf", offset: 0, bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "application/zip", offset: 0, bytes: [0x50, 0x4B, 0x03, 0x04] }, // also DOCX/XLSX/PPTX
  { mime: "application/gzip",offset: 0, bytes: [0x1F, 0x8B, 0x08] },
];

function detectMimeType(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath, { flag: "r" }); // reads entire file but we only check header
    if (buf.length < 4) return null;

    for (const sig of MAGIC_SIGNATURES) {
      if (buf.length < sig.offset + sig.bytes.length) continue;
      let match = true;
      for (let i = 0; i < sig.bytes.length; i++) {
        if (buf[sig.offset + i] !== sig.bytes[i]) { match = false; break; }
      }
      if (match) return sig.mime;
    }

    return null; // unknown
  } catch (e: any) {
    console.warn(`[clawworld-channel] magic-byte detection failed for ${filePath}:`, e?.message ?? e);
    return null;
  }
}

/**
 * Validate that the detected MIME type is consistent with the declared MIME.
 * Returns null on success, or an error string on mismatch.
 */
function validateAttachmentMime(filePath: string, declaredMime: string): string | null {
  const detected = detectMimeType(filePath);
  if (!detected) return null; // detection failed — don't block on tooling issue

  // Normalize: strip charset/encoding suffixes, lowercase
  const norm = (m: string) => m.split(";")[0]!.trim().toLowerCase();
  const d = norm(detected);
  const e = norm(declaredMime);

  // Exact match
  if (d === e) return null;

  // Common aliases: magic-byte detector reports generic types for some formats.
  // DOCX/XLSX/PPTX are ZIP-based — detected as application/zip.
  // Text files (txt, md, csv, json, html, css, js) have no magic bytes —
  // the detector returns null, which skips validation (no false positives).
  const aliases: Record<string, string[]> = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["application/zip"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         ["application/zip"],
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["application/zip"],
    "application/zip":   ["application/zip", "application/x-zip-compressed"],
    "application/gzip":  ["application/gzip", "application/x-gzip"],
    "image/jpeg":        ["image/jpeg", "image/jpg"],
    "application/msword":["application/zip", "application/msword"], // .doc is OLE2, but some are ZIP
  };

  const acceptable = aliases[e];
  if (acceptable && acceptable.includes(d)) return null;

  return `MIME mismatch for ${path.basename(filePath)}: declared "${declaredMime}", detected "${detected}"`;
}

/**
 * Build the text block injected into the agent's prompt describing
 * downloaded attachments and their local paths.
 */
function buildAttachmentInjectionText(
  attachments: ClawWorldAttachment[],
  results: { att: ClawWorldAttachment; localPath: string | null }[],
): string {
  const downloaded = results.filter(r => r.localPath !== null);
  if (downloaded.length === 0) return "";

  const lines = downloaded.map(r =>
    ` - ${r.localPath} (${r.att.mime})`,
  );

  return [
    `\n[用户附带 ${downloaded.length} 个文件，已保存在容器本地：`,
    ...lines,
    "]",
  ].join("\n");
}

/**
 * Get a presigned upload URL for an outbound file and upload it to S3.
 * Returns the fileId on success, or null on failure.
 */
async function uploadOutboundFile(
  cfg: ClawWorldChannelConfig,
  filePath: string,
): Promise<{ fileId: string; name: string; mime: string; size: number } | null> {
  const name = path.basename(filePath);

  let stat: { size: number };
  try { stat = await fs.stat(filePath); } catch { return null; }

  // Detect MIME from magic bytes (more reliable than extension guess)
  const mime = detectMimeType(filePath) ?? "application/octet-stream";

  // ⑧ Get presigned upload URL
  let fileId: string;
  let uploadUrl: string;
  try {
    const resp = await fetch(`${cfg.endpoint}/api/lobster/files/upload-url`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.deviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, mime, size: stat.size }),
    });
    if (!resp.ok) {
      console.error(`[clawworld-channel] upload-url error for ${name}: ${resp.status}`);
      return null;
    }
    ({ fileId, uploadUrl } = (await resp.json()) as { fileId: string; uploadUrl: string });
  } catch (e: any) {
    console.error(`[clawworld-channel] upload-url fetch error for ${name}:`, e?.message ?? e);
    return null;
  }

  // ⑨ Upload to S3
  try {
    const fileBytes = await fs.readFile(filePath);
    const resp = await fetch(uploadUrl, {
      method: "PUT",
      body: fileBytes,
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${name.replace(/[\x00-\x1f\x7f\/\\:*?"<>|]/g, '_')}"`,
      },
    });
    if (!resp.ok) {
      console.error(`[clawworld-channel] S3 upload error for ${name}: ${resp.status}`);
      return null;
    }
    console.log(`[clawworld-channel] uploaded: ${name} → ${fileId}`);
    return { fileId, name, mime, size: stat.size };
  } catch (e: any) {
    console.error(`[clawworld-channel] upload error for ${name}:`, e?.message ?? e);
    return null;
  }
}

/**
 * Scan the outbound directory, upload any files found, and return
 * attachment payloads ready for the ingest body.
 * Cleans up uploaded files from the out/ directory.
 */
async function collectAndUploadOutboundFiles(
  cfg: ClawWorldChannelConfig,
): Promise<ClawWorldAttachment[]> {
  let entries: { name: string }[];
  try {
    await ensureDir(OUT_DIR);
    entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  } catch { return []; }

  const files = entries.filter(e => e.isFile());
  if (files.length === 0) return [];

  const attachments: ClawWorldAttachment[] = [];
  for (const entry of files) {
    const filePath = path.join(OUT_DIR, entry.name);
    const result = await uploadOutboundFile(cfg, filePath);
    if (result) {
      attachments.push({
        fileId: result.fileId,
        direction: "out",
        kind: result.mime.startsWith("image/") ? "image" : "file",
        name: result.name,
        mime: result.mime,
        size: result.size,
      });
      // ⑨ Clean up local temp file after successful upload
      try { await fs.unlink(filePath); } catch { /* best effort */ }
    }
  }

  return attachments;
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

            // ⑧⑨⑩ Auto-detect and upload outbound files in ${HOME}/.openclaw/out/
            const outboundAttachments = await collectAndUploadOutboundFiles(account);

            const body: Record<string, any> = { content: text };
            if (outboundAttachments.length > 0) {
              body.attachments = outboundAttachments;
            }

            const resp = await fetch(`${account.endpoint}/api/lobster/ingest`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${account.deviceToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            });
            console.log("[clawworld-channel] ingest response:", resp.status);
          } catch (e: any) {
            console.error("[clawworld-channel] deliver error:", e?.message ?? e);
          }
        };

        // Boot greeting fires only on the very first deploy. Subsequent auto-wakes
        // (e.g. user re-engaged after inactivity-stop) launch the task without
        // initialGreeting set in config, so the chat thread isn't spammed with
        // restart notices. entrypoint.sh derives the flag from a task-definition
        // variable and bakes it into config.json before the plugin loads.
        const shouldGreet = account.initialGreeting === true;
        await runClawworldWebSocket({
          cfg: account,
          abortSignal,
          onFirstConnect: shouldGreet ? async () => {
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                if (attempt > 0) await new Promise<void>(r => setTimeout(r, 5_000));
                await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: {
                    Body: pickGreetingPrompt(),
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
          } : undefined,
          onMessage: async (msg) => {
            console.log("[clawworld-channel] dispatching message to agent:", msg.messageId);

            let agentBody = msg.content;

            // ④⑤⑥ Download inbound attachments & inject local paths into agent text
            if (msg.attachments && msg.attachments.length > 0) {
              const results: { att: ClawWorldAttachment; localPath: string | null }[] = [];
              for (const att of msg.attachments) {
                const localPath = await downloadInboundFile(account, att);

                // ⑥ Magic-byte validation after download
                if (localPath) {
                  const mimeError = validateAttachmentMime(localPath, att.mime);
                  if (mimeError) {
                    console.warn(`[clawworld-channel] MIME validation failed: ${mimeError}`);
                    // Remove the mislabeled file so the agent doesn't consume it
                    try { await fs.unlink(localPath); } catch { /* best effort */ }
                    results.push({ att, localPath: null });
                    continue;
                  }
                }

                results.push({ att, localPath });
              }

              const injection = buildAttachmentInjectionText(msg.attachments, results);
              if (injection) {
                agentBody = agentBody ? `${agentBody}\n${injection}` : injection;
              }
            }

            await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: {
                Body: agentBody,
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

        // Auto-detect and upload outbound files
        const outboundAttachments = await collectAndUploadOutboundFiles(config);

        const body: Record<string, any> = { content: text };
        if (outboundAttachments.length > 0) {
          body.attachments = outboundAttachments;
        }

        const resp = await fetch(`${config.endpoint}/api/lobster/ingest`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.deviceToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        console.log("[clawworld-channel] outbound sendText response:", resp.status);
      },
    },
  },

});

export const clawworldChannelPlugin = _cwPluginDef;
export default clawworldChannelPlugin;
