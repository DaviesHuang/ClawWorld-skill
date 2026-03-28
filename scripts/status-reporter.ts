/**
 * Status push module for the ClawWorld hook.
 * Sends a fire-and-forget status event to the ClawWorld API.
 * ClawWorld outages must never block or crash the agent.
 */

import type { ClawWorldConfig } from './config.js';

export interface StatusPayload {
  instance_id: string;
  lobster_id: string;
  event_type: string;
  event_action: string;
  timestamp: string;
  session_key_hash: string;    // SHA-256 hash of sessionKey, first 16 hex chars
  installed_skills?: string[]; // skill names from agent:bootstrap bootstrapFiles
  invoked_skills?: string[];   // session-accumulated skills from message:sent toolsUsed
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

const MIN_PUSH_INTERVAL_MS = 3_000; // 3 seconds — prevent spam
let lastPushTime = 0;

export async function pushStatus(
  config: ClawWorldConfig,
  payload: StatusPayload
): Promise<void> {
  const now = Date.now();
  if (now - lastPushTime < MIN_PUSH_INTERVAL_MS) {
    return;
  }
  lastPushTime = now;

  try {
    // Fire and forget — do not await, do not block the agent
    void fetch(`${config.endpoint}/api/claw/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.deviceToken}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000), // 5s timeout
    }).catch((err: Error) => {
      console.error(`[clawworld-status] Push failed: ${err.message}`);
    });
  } catch {
    // Silently fail — ClawWorld outage must never affect the agent
  }
}
