import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

type LoggerTarget = Pick<PluginLogger, "info" | "warn" | "error" | "debug">;

export type ClawWorldLogger = {
  subsystem: string;
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  child: (name: string) => ClawWorldLogger;
};

const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

function formatMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) {
    return "";
  }
  const parts = Object.entries(meta)
    .map(([key, value]) => {
      if (value === undefined || value === null) {
        return null;
      }
      if (typeof value === "object") {
        return `${key}=${JSON.stringify(value)}`;
      }
      return `${key}=${String(value)}`;
    })
    .filter(Boolean);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatMessage(subsystem: string, message: string, meta?: Record<string, unknown>): string {
  return `[clawworld/${subsystem}] ${message}${formatMeta(meta)}`;
}

function consoleFallback(subsystem: string): LoggerTarget {
  const tag = `clawworld/${subsystem}`;
  return {
    debug: (msg) => console.debug(`${GRAY}[${tag}]${RESET}`, msg),
    info: (msg) => console.log(`${CYAN}[${tag}]${RESET}`, msg),
    warn: (msg) => console.warn(`${YELLOW}[${tag}]${RESET}`, msg),
    error: (msg) => console.error(`${RED}[${tag}]${RESET}`, msg),
  };
}

function resolveTarget(primary: LoggerTarget | null | undefined, subsystem: string): LoggerTarget {
  return primary ?? consoleFallback(subsystem);
}

export function createClawWorldLogger(
  subsystem: string,
  primary: LoggerTarget | null | undefined,
): ClawWorldLogger {
  const target = resolveTarget(primary, subsystem);

  return {
    subsystem,
    debug(message, meta) {
      target.debug?.(formatMessage(subsystem, message, meta));
    },
    info(message, meta) {
      target.info?.(formatMessage(subsystem, message, meta));
    },
    warn(message, meta) {
      target.warn?.(formatMessage(subsystem, message, meta));
    },
    error(message, meta) {
      target.error?.(formatMessage(subsystem, message, meta));
    },
    child(name) {
      return createClawWorldLogger(`${subsystem}/${name}`, primary);
    },
  };
}
