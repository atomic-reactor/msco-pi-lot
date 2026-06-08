import type {
  Context,
  Model,
  OAuthCredentials,
  OAuthLoginCallbacks,
  SimpleStreamOptions,
  ThinkingLevel
} from "@mariozechner/pi-ai";
import type { ProviderConfig } from "@mariozechner/pi-coding-agent";
import type { CopilotMode } from "./types.js";
import type { CopilotRuntimeManager } from "./runtime/runtime-manager.js";

export const PROVIDER_NAME = "microsoft-copilot";
export const COPILOT_API = "microsoft-copilot-chat";
const NON_REFRESHING_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365 * 10;

export const PROVIDER_MODELS: NonNullable<ProviderConfig["models"]> = [
  {
    id: "copilot",
    name: "Microsoft Copilot",
    api: COPILOT_API,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192
  }
];

export function createProviderConfig(runtimeManager: CopilotRuntimeManager): ProviderConfig {
  return {
    api: COPILOT_API,
    baseUrl: "https://copilot.microsoft.com/c/api",
    apiKey: "$MICROSOFT_COPILOT_ACCESS_TOKEN",
    models: PROVIDER_MODELS,
    oauth: {
      name: "Microsoft Copilot",
      login: promptForAccessToken,
      refreshToken: refreshPastedAccessToken,
      getApiKey: (credentials) => normalizeAccessToken(credentials.access)
    },
    streamSimple(model: Model<any>, context: Context, options?: SimpleStreamOptions) {
      const sessionId = options?.sessionId || "default";
      return runtimeManager.streamContext(
        sessionId,
        model,
        context,
        resolveCopilotMode(options?.reasoning),
        normalizeAccessToken(options?.apiKey),
        options?.signal
      ) as any;
    }
  };
}

export async function promptForAccessToken(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const token = normalizeAccessToken(await callbacks.onPrompt({
    message: "Paste your Microsoft Copilot access token:",
    placeholder: "Paste access token",
    allowEmpty: false
  }));

  if (!token) {
    throw new Error("A Microsoft Copilot access token is required");
  }

  return {
    access: token,
    refresh: token,
    expires: Date.now() + NON_REFRESHING_TOKEN_TTL_MS
  };
}

export async function refreshPastedAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const access = normalizeAccessToken(credentials.access);
  const refresh = normalizeAccessToken(credentials.refresh || credentials.access);

  if (!access) {
    throw new Error("Microsoft Copilot token is missing. Run /login microsoft-copilot again.");
  }

  return {
    ...credentials,
    access,
    refresh,
    expires: Date.now() + NON_REFRESHING_TOKEN_TTL_MS
  };
}

export function resolveCopilotMode(reasoning: ThinkingLevel | "off" | undefined): CopilotMode | undefined {
  if (!reasoning || reasoning === "off") {
    return "smart";
  }

  if (reasoning === "minimal" || reasoning === "low") {
    return "smart";
  }

  return "reasoning";
}

export function normalizeAccessToken(token: string | undefined): string {
  if (!token) {
    return "";
  }

  const trimmed = token.trim();
  if (!trimmed) {
    return "";
  }

  const parsedToken = extractTokenFromJson(trimmed);
  if (parsedToken) {
    return normalizeAccessToken(parsedToken);
  }

  const embeddedBearer = trimmed.match(/(?:authorization\s*:\s*)?bearer\s+([A-Za-z0-9._~+/=-]+)/i);
  if (embeddedBearer?.[1]) {
    return embeddedBearer[1].trim();
  }

  return trimmed
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^bearer\s+/i, "")
    .replace(/^[\'"]|[\'",;]$/g, "")
    .trim();
}

function extractTokenFromJson(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    for (const key of ["access", "accessToken", "access_token", "token", "bearerToken", "bearer_token"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
  } catch {
    // Not JSON; fall through to header/string parsing.
  }

  return undefined;
}
