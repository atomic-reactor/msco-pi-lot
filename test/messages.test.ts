import { describe, expect, test } from "vitest";
import { buildMessagePreviewEvent, buildSendEvent, buildSetOptionsEvent } from "../src/protocol/messages.js";

describe("protocol messages", () => {
  test("does not advertise browser actions in pi mode", () => {
    const event = buildSetOptionsEvent() as {
      supportedFeatures: string[];
      supportedActions: string[];
    };

    expect(event.supportedFeatures).toEqual(["partial-generated-images"]);
    expect(event.supportedActions).toEqual([]);
  });

  test("does not send edge browser context metadata in prompt events", () => {
    const preview = buildMessagePreviewEvent({
      conversationId: "conv-1",
      prompt: "Hello"
    }) as Record<string, unknown>;
    const send = buildSendEvent({
      conversationId: "conv-1",
      prompt: "Hello",
      mode: "smart"
    }) as Record<string, unknown>;

    expect(preview).not.toHaveProperty("context");
    expect(send).not.toHaveProperty("context");
  });
});
