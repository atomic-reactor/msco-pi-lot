import { describe, expect, test } from "vitest";
import { loadConfig, maskConfigForLog } from "../src/core/config.js";

describe("config", () => {
  test("canonical env vars take precedence over legacy aliases", () => {
    const config = loadConfig({
      env: {
        MICROSOFT_COPILOT_ACCESS_TOKEN: "canonical-token",
        COPILOT_ACCESS_TOKEN: "legacy-token",
        MICROSOFT_COPILOT_MODE: "smart",
        COPILOT_MODE: "reasoning",
        MICROSOFT_COPILOT_TRACE: "1",
        COPILOT_TRACE: "0"
      },
      loadDotEnv: false
    });

    expect(config.accessToken).toBe("canonical-token");
    expect(config.mode).toBe("smart");
    expect(config.trace).toBe(true);
  });

  test("legacy env vars are accepted when canonical values are absent", () => {
    const config = loadConfig({
      env: {
        COPILOT_ACCESS_TOKEN: "legacy-token",
        COPILOT_CONVERSATION_ID: "conv-1",
        COPILOT_CLIENT_SESSION_ID: "client-1"
      },
      loadDotEnv: false
    });

    expect(config.accessToken).toBe("legacy-token");
    expect(config.conversationId).toBe("conv-1");
    expect(config.clientSessionId).toBe("client-1");
  });

  test("maskConfigForLog redacts token and cookie values", () => {
    expect(
      maskConfigForLog({
        accessToken: "abcdefghijklmnopqrstuvwxyz",
        cookie: "MUID=123; ANON=456",
        mode: "reasoning",
        channel: "edge",
        apiVersion: "2",
        debug: false,
        trace: false,
        origin: "https://copilot.microsoft.com",
        userAgent: "ua"
      })
    ).toMatchObject({
      accessToken: "abcdef...wxyz",
      cookie: "MUID=***; ANON=***"
    });
  });
});
