import type { Context, Model } from "@mariozechner/pi-ai";
import type { CopilotConfig, CopilotMode, PersistedCopilotState } from "../types.js";
import type { SessionTraceWriter } from "../core/session-trace.js";
import { CopilotSessionRuntime, type SessionRuntimeDependencies } from "./session-runtime.js";

export class CopilotRuntimeManager {
  private readonly runtimes = new Map<string, CopilotSessionRuntime>();

  constructor(
    private readonly config: CopilotConfig,
    private readonly readState: (sessionId: string) => PersistedCopilotState | undefined,
    private readonly persistState: (state: PersistedCopilotState) => void,
    private readonly dependencies: SessionRuntimeDependencies & { traceWriter?: SessionTraceWriter } = {}
  ) {}

  updatePersistedState(state: PersistedCopilotState | undefined, sessionId: string): void {
    if (!state) {
      return;
    }

    const runtime = this.runtimes.get(sessionId);
    runtime?.updatePersistedState(state);
  }

  disconnectSession(sessionId: string): void {
    this.runtimes.get(sessionId)?.disconnect();
  }

  async streamSimple(sessionId: string, model: Model<any>, prompt: string, signal?: AbortSignal) {
    const runtime = this.getOrCreateRuntime(sessionId);
    return runtime.streamPrompt(model, prompt, undefined, signal);
  }

  async streamContext(
    sessionId: string,
    model: Model<any>,
    context: Context,
    mode: CopilotMode | undefined,
    accessToken: string | undefined,
    signal?: AbortSignal
  ) {
    const runtime = this.getOrCreateRuntime(sessionId);
    return runtime.streamContext(model, context, mode, accessToken, signal);
  }

  getOrCreateRuntime(sessionId: string): CopilotSessionRuntime {
    let runtime = this.runtimes.get(sessionId);
    if (runtime) {
      return runtime;
    }

    runtime = new CopilotSessionRuntime(
      this.config,
      sessionId,
      this.readState(sessionId),
      (state) => {
        this.persistState(state);
        runtime?.updatePersistedState(state);
      },
      this.dependencies
    );
    this.runtimes.set(sessionId, runtime);
    return runtime;
  }
}
