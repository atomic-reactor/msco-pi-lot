import { describe, expect, test } from "vitest";
import { CopilotSessionStore } from "../src/runtime/session-store.js";

describe("session store", () => {
  test("reconstructs the latest persisted state for the current session", () => {
    const store = new CopilotSessionStore();
    const state = store.reconstruct({
      getSessionId: () => "session-1",
      getBranch: () =>
        [
          { type: "message" },
          {
            type: "custom",
            customType: "microsoft-copilot-state",
            data: {
              version: 1,
              sessionId: "session-1",
              conversationId: "conv-1",
              clientSessionId: "client-1",
              updatedAt: "2026-03-20T00:00:00.000Z"
            }
          }
        ] as any,
      getCwd: () => "",
      getSessionDir: () => "",
      getSessionFile: () => undefined,
      getLeafId: () => "",
      getLeafEntry: () => undefined,
      getEntry: () => undefined,
      getLabel: () => undefined,
      getHeader: () => ({ type: "session", id: "session-1" }),
      getEntries: () => [],
      getTree: () => [],
      getSessionName: () => undefined
    });

    expect(state?.conversationId).toBe("conv-1");
    expect(store.get("session-1")?.clientSessionId).toBe("client-1");
  });
});
