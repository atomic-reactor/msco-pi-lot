import { describe, expect, test } from "vitest";
import {
  normalizeAccessToken,
  extractAccessToken,
  PROVIDER_MODELS,
  promptForAccessToken,
  refreshPastedAccessToken,
  resolveCopilotMode
} from "../src/provider.js";

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

  test("normalizes pasted Bearer tokens during login", async () => {
    const credentials = await promptForAccessToken({
      onAuth: () => {},
      onPrompt: async () => "Bearer secret-token"
    });

    expect(credentials.access).toBe("secret-token");
    expect(credentials.refresh).toBe("secret-token");
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

  test("normalizeAccessToken strips optional bearer/header wrappers", () => {
    expect(normalizeAccessToken("Bearer abc")).toBe("abc");
    expect(normalizeAccessToken("bearer    abc")).toBe("abc");
    expect(normalizeAccessToken("Authorization: Bearer abc")).toBe("abc");
    expect(normalizeAccessToken("'abc'" )).toBe("abc");
    expect(normalizeAccessToken("\"abc\"")).toBe("abc");
    expect(normalizeAccessToken("  abc  ")).toBe("abc");
    expect(normalizeAccessToken("  ")).toBe("");
  });

  test("extractAccessToken handles full URLs, curl, fetch, and json payloads", () => {
    const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.XXX.YYY";

    // WS / request URL with query param
    expect(extractAccessToken(`wss://copilot.microsoft.com/c/api/chat?accessToken=${token}&clientSessionId=foo`)).toBe(token);

    // Full https url
    expect(extractAccessToken(`https://copilot.microsoft.com/c/api/config?api-version=2&accessToken=${encodeURIComponent(token)}`)).toBe(token);

    // curl with Authorization header
    expect(extractAccessToken(`curl 'https://copilot.microsoft.com/c/api/conversations' -H 'Authorization: Bearer ${token}' -H 'Origin: ...'`)).toBe(token);

    // fetch snippet
    expect(extractAccessToken(`fetch("https://copilot.microsoft.com/c/api/chat?accessToken=${token}", {headers:{}})`)).toBe(token);

    // JSON with accessToken
    expect(extractAccessToken(JSON.stringify({ accessToken: token, foo: 1 }))).toBe(token);

    // Headers block
    expect(extractAccessToken(`Authorization: Bearer ${token}\nUser-Agent: ...`)).toBe(token);
  });

  test("extractAccessToken is robust with quotes and extra text", () => {
    expect(extractAccessToken('"my-token-12345678901234567890"')).toBe("my-token-12345678901234567890");
    expect(extractAccessToken("   'abcde12345678901234567890'   ")).toBe("abcde12345678901234567890");
  });
});
