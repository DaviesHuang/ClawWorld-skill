import type { HookHandler } from "../../src/hooks/hooks.js";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// --- Types ---

interface ClawWorldConfig {
  deviceToken: string;
  endpoint: string;
  lobsterId: string;
  instanceId: string;
}

interface StatusPayload {
  instance_id: string;
  lobster_id: string;
  event_type: string;
  event_action: string;
  timestamp: string;
  session_key_hash: string;    // SHA-256 hash, not raw key
  installed_skills?: string[]; // skill names from agent:bootstrap
  invoked_skills?: string[];   // session-accumulated skills from message:sent toolsUsed
  token_usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

// --- Config ---

const CONFIG_DIR = path.join(
  process.env.HOME || "~",
  ".openclaw",
  "clawworld"
);
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

// Minimum interval between status pushes (prevent spam)
const MIN_PUSH_INTERVAL_MS = 3_000; // 3 seconds
let lastPushTime = 0;

// Session-level invoked skills: keyed by session_key_hash, accumulated per session
const sessionInvokedSkills = new Map<string, Set<string>>();

// --- Helpers ---

function loadConfig(): ClawWorldConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as ClawWorldConfig;
  } catch {
    return null; // Not bound yet — silently exit
  }
}

function hashSessionKey(sessionKey: string): string {
  return crypto.createHash("sha256").update(sessionKey).digest("hex").slice(0, 16);
}

async function pushStatus(config: ClawWorldConfig, payload: StatusPayload): Promise<void> {
  const now = Date.now();
  if (now - lastPushTime < MIN_PUSH_INTERVAL_MS) {
    return;
  }
  lastPushTime = now;

  try {
    // Fire and forget — don't block the Gateway
    void fetch(`${config.endpoint}/api/claw/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.deviceToken}`,
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

// --- Skill extraction ---

function extractInstalledSkills(event: any): string[] | undefined {
  if (event.type === "agent" && event.action === "bootstrap") {
    const bootstrapFiles = event.context?.bootstrapFiles;
    if (Array.isArray(bootstrapFiles)) {
      const skills = bootstrapFiles
        .map((f: any) => f.path || f.name || "")
        .filter((p: string) => p.includes("/skills/"))
        .map((p: string) => {
          const match = p.match(/skills\/([^/]+)\//);
          return match ? match[1] : null;
        })
        .filter(Boolean) as string[];
      return skills.length > 0 ? skills : undefined;
    }
  }
  return undefined;
}

function extractInvokedSkills(event: any, sessionKeyHash: string): string[] | undefined {
  // On session reset or stop, clear accumulated state and return nothing
  if (event.type === "command" && (event.action === "reset" || event.action === "stop")) {
    sessionInvokedSkills.delete(sessionKeyHash);
    return undefined;
  }

  const toolsUsed = event.context?.toolsUsed as string[] | undefined;
  if (!toolsUsed || toolsUsed.length === 0) return undefined;

  if (!sessionInvokedSkills.has(sessionKeyHash)) {
    sessionInvokedSkills.set(sessionKeyHash, new Set());
  }
  const sessionSet = sessionInvokedSkills.get(sessionKeyHash)!;

  for (const tool of toolsUsed) {
    // OpenClaw tool naming convention: <skillName>_<toolName> (e.g. github_list_prs → github)
    const skillName = tool.includes("_") ? tool.split("_")[0] : tool;
    sessionSet.add(skillName);
  }

  const skills = Array.from(sessionSet);
  return skills.length > 0 ? skills : undefined;
}

function extractTokenUsage(event: any): StatusPayload["token_usage"] | undefined {
  if (event.type === "message" && event.action === "sent") {
    const tu = event.context?.tokenUsage;
    if (tu && (tu.inputTokens != null || tu.outputTokens != null)) {
      return {
        input_tokens: tu.inputTokens,
        output_tokens: tu.outputTokens,
      };
    }
  }
  return undefined;
}

// --- Main handler ---

const handler: HookHandler = async (event) => {
  const config = loadConfig();
  if (!config) {
    return; // Not bound — silently exit
  }

  const sessionKeyHash = hashSessionKey(event.sessionKey);

  const payload: StatusPayload = {
    instance_id: config.instanceId,
    lobster_id: config.lobsterId,
    event_type: event.type,
    event_action: event.action,
    timestamp: event.timestamp.toISOString(),
    session_key_hash: sessionKeyHash,
  };

  const installedSkills = extractInstalledSkills(event);
  if (installedSkills) {
    payload.installed_skills = installedSkills;
  }

  const invokedSkills = extractInvokedSkills(event, sessionKeyHash);
  if (invokedSkills) {
    payload.invoked_skills = invokedSkills;
  }

  const tokenUsage = extractTokenUsage(event);
  if (tokenUsage) {
    payload.token_usage = tokenUsage;
  }

  void pushStatus(config, payload);
};

export default handler;
