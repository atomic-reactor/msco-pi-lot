import { describe, expect, test } from "vitest";
import { PROVIDER_MODELS, promptForAccessToken, refreshPastedAccessToken, resolveCopilotMode } from "../src/provider.js";

describe("provider", () => {
  test("registers a single Copilot model", () => {
    expect(PROVIDER_MODELS).toHaveLength(1);
    expect(PROVIDER_MODELS[0]).toMatchObject({
      id: "copilot",
      name: "Microsoft Copilot",
      reasoning: true
    });
  });

  test("maps pi thinking levels to Copilot modes", () => {
    expect(resolveCopilotMode("off")).toBe("smart");
    expect(resolveCopilotMode("minimal")).toBe("smart");
    expect(resolveCopilotMode("low")).toBe("smart");
    expect(resolveCopilotMode("medium")).toBe("reasoning");
    expect(resolveCopilotMode("high")).toBe("reasoning");
    expect(resolveCopilotMode("xhigh")).toBe("reasoning");
    expect(resolveCopilotMode(undefined)).toBe("smart");
  });

  test("accepts a pasted access token through the login prompt", async () => {
    const credentials = await promptForAccessToken({
      onAuth: () => {},
      onPrompt: async () => "  secret-token  "
    });

    expect(credentials.access).toBe("secret-token");
    expect(credentials.refresh).toBe("secret-token");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  test("refresh keeps non-empty pasted tokens valid", async () => {
    const refreshed = await refreshPastedAccessToken({
      access: "secret-token",
      refresh: "",
      expires: 0
    });

    expect(refreshed.access).toBe("secret-token");
    expect(refreshed.refresh).toBe("secret-token");
    expect(refreshed.expires).toBeGreaterThan(Date.now());
  });
});
