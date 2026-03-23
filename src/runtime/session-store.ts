import type { ReadonlySessionManager, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { PersistedCopilotState } from "../types.js";

export const SESSION_ENTRY_TYPE = "microsoft-copilot-state";

export class CopilotSessionStore {
  private readonly entries = new Map<string, PersistedCopilotState>();

  get(sessionId: string): PersistedCopilotState | undefined {
    return this.entries.get(sessionId);
  }

  set(state: PersistedCopilotState): void {
    this.entries.set(state.sessionId, state);
  }

  reconstruct(sessionManager: ReadonlySessionManager): PersistedCopilotState | undefined {
    const sessionId = sessionManager.getSessionId();
    let state: PersistedCopilotState | undefined;

    for (const entry of sessionManager.getBranch()) {
      if (isCopilotStateEntry(entry)) {
        state = entry.data;
      }
    }

    if (state && state.sessionId === sessionId) {
      this.entries.set(sessionId, state);
      return state;
    }

    this.entries.delete(sessionId);
    return undefined;
  }
}

function isCopilotStateEntry(entry: SessionEntry): entry is SessionEntry & { type: "custom"; data: PersistedCopilotState } {
  return entry.type === "custom" && entry.customType === SESSION_ENTRY_TYPE && Boolean(entry.data);
}
