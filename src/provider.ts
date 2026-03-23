import type { Context, Model, SimpleStreamOptions, ThinkingLevel } from "@mariozechner/pi-ai";
import type { ProviderConfig } from "@mariozechner/pi-coding-agent";
import type { CopilotMode } from "./types.js";
import type { CopilotRuntimeManager } from "./runtime/runtime-manager.js";

export const PROVIDER_NAME = "microsoft-copilot";
export const COPILOT_API = "microsoft-copilot-chat";

export const PROVIDER_MODELS: ProviderConfig["models"] = [
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
    apiKey: "MICROSOFT_COPILOT_ACCESS_TOKEN",
    models: PROVIDER_MODELS,
    streamSimple(model: Model<typeof COPILOT_API>, context: Context, options?: SimpleStreamOptions) {
      const sessionId = options?.sessionId || "default";
      return runtimeManager.streamContext(sessionId, model, context, resolveCopilotMode(options?.reasoning), options?.signal);
    }
  };
}

export function resolveCopilotMode(reasoning: ThinkingLevel | undefined): CopilotMode | undefined {
  if (!reasoning || reasoning === "off") {
    return "smart";
  }

  if (reasoning === "minimal" || reasoning === "low") {
    return "smart";
  }

  return "reasoning";
}
