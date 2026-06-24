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
import { extractAccessToken } from "./auth/token-capture.js";

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
  // Delegate to the rich implementation that supports browser auto-capture + smart paste
  const mod = await import("./auth/token-capture.js");
  return mod.loginWithBestEffort(callbacks as any);
}

export async function refreshPastedAccessToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
  const access = normalizeAccessToken(credentials.access);
  const refresh = normalizeAccessToken(credentials.refresh || credentials.access);

  if (!access) {
    throw new Error("Microsoft Copilot token is missing. Run /login and select Microsoft Copilot (or set MICROSOFT_COPILOT_ACCESS_TOKEN).");
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
  // Powerful extractor handles raw token, Bearer, full URLs with accessToken=, curl, fetch, JSON etc.
  return extractAccessToken(token);
}

// Re-export for convenience / tests
export { extractAccessToken } from "./auth/token-capture.js";
