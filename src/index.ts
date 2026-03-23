import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { loadConfig, maskConfigForLog } from "./core/config.js";
import { generateClientSessionId } from "./core/ids.js";
import { SessionTraceWriter } from "./core/session-trace.js";
import { createProviderConfig, PROVIDER_NAME } from "./provider.js";
import { CopilotRuntimeManager } from "./runtime/runtime-manager.js";
import { CopilotSessionStore, SESSION_ENTRY_TYPE } from "./runtime/session-store.js";
import type { PersistedCopilotState } from "./types.js";

function reconstructState(sessionStore: CopilotSessionStore, runtimeManager: CopilotRuntimeManager, ctx: ExtensionContext): void {
  const state = sessionStore.reconstruct(ctx.sessionManager);
  runtimeManager.updatePersistedState(state, ctx.sessionManager.getSessionId());
}

function seedFreshState(sessionStore: CopilotSessionStore, runtimeManager: CopilotRuntimeManager, ctx: ExtensionContext): void {
  const state: PersistedCopilotState = {
    version: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    conversationId: "",
    clientSessionId: generateClientSessionId(),
    updatedAt: new Date().toISOString()
  };

  sessionStore.set(state);
  runtimeManager.updatePersistedState(state, state.sessionId);
}

export default function microsoftCopilotExtension(pi: ExtensionAPI): void {
  const config = loadConfig();
  const traceWriter = config.trace ? new SessionTraceWriter(config.traceFile) : undefined;
  const sessionStore = new CopilotSessionStore();
  const runtimeManager = new CopilotRuntimeManager(
    config,
    (sessionId) => sessionStore.get(sessionId),
    (state: PersistedCopilotState) => {
      pi.appendEntry(SESSION_ENTRY_TYPE, state);
      sessionStore.set(state);
    },
    { traceWriter }
  );

  traceWriter?.write("extension.loaded", { config: maskConfigForLog(config) });

  pi.registerProvider(PROVIDER_NAME, createProviderConfig(runtimeManager));

  pi.on("session_start", async (_event, ctx) => {
    reconstructState(sessionStore, runtimeManager, ctx);
  });
  pi.on("session_switch", async (_event, ctx) => {
    if (_event.reason === "new") {
      seedFreshState(sessionStore, runtimeManager, ctx);
      return;
    }
    reconstructState(sessionStore, runtimeManager, ctx);
  });
  pi.on("session_fork", async (_event, ctx) => {
    reconstructState(sessionStore, runtimeManager, ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    reconstructState(sessionStore, runtimeManager, ctx);
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    runtimeManager.disconnectSession(ctx.sessionManager.getSessionId());
  });
}
