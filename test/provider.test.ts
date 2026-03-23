import { describe, expect, test } from "vitest";
import { PROVIDER_MODELS, resolveCopilotMode } from "../src/provider.js";

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
});
