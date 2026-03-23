import dotenv from "dotenv";
import { maskCookie } from "./mask-secrets.js";
import type { CopilotConfig, CopilotMode } from "../types.js";

const DEFAULTS = Object.freeze({
  mode: "reasoning" as CopilotMode,
  channel: "edge",
  apiVersion: "2",
  debug: false,
  trace: false,
  origin: "https://copilot.microsoft.com",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0"
});

const ALLOWED_MODES = new Set<CopilotMode>(["reasoning", "smart"]);

function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function readEnv(env: NodeJS.ProcessEnv, canonical: string, legacy?: string): string | undefined {
  return env[canonical] || (legacy ? env[legacy] : undefined);
}

function normalizeMode(value: string | undefined): CopilotMode {
  const mode = (value || DEFAULTS.mode) as CopilotMode;
  if (!ALLOWED_MODES.has(mode)) {
    throw new Error(`Unsupported Copilot mode "${mode}". Expected one of: reasoning, smart`);
  }
  return mode;
}

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  loadDotEnv?: boolean;
  dotenvPath?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): CopilotConfig {
  if (options.loadDotEnv !== false) {
    dotenv.config({ path: options.dotenvPath, quiet: true });
  }

  const env = options.env ?? process.env;

  return {
    cookie: readEnv(env, "MICROSOFT_COPILOT_COOKIE", "COPILOT_COOKIE") || "",
    conversationId: readEnv(env, "MICROSOFT_COPILOT_CONVERSATION_ID", "COPILOT_CONVERSATION_ID") || undefined,
    clientSessionId: readEnv(env, "MICROSOFT_COPILOT_CLIENT_SESSION_ID", "COPILOT_CLIENT_SESSION_ID") || undefined,
    mode: normalizeMode(readEnv(env, "MICROSOFT_COPILOT_MODE", "COPILOT_MODE")),
    channel: readEnv(env, "MICROSOFT_COPILOT_CHANNEL", "COPILOT_CHANNEL") || DEFAULTS.channel,
    apiVersion: readEnv(env, "MICROSOFT_COPILOT_API_VERSION", "COPILOT_API_VERSION") || DEFAULTS.apiVersion,
    debug: parseBooleanFlag(readEnv(env, "MICROSOFT_COPILOT_DEBUG", "COPILOT_DEBUG"), DEFAULTS.debug),
    trace: parseBooleanFlag(readEnv(env, "MICROSOFT_COPILOT_TRACE", "COPILOT_TRACE"), DEFAULTS.trace),
    traceFile: readEnv(env, "MICROSOFT_COPILOT_TRACE_FILE", "COPILOT_TRACE_FILE") || undefined,
    origin: DEFAULTS.origin,
    userAgent: DEFAULTS.userAgent
  };
}

export function maskConfigForLog(config: CopilotConfig): Record<string, unknown> {
  return {
    ...config,
    cookie: maskCookie(config.cookie)
  };
}
