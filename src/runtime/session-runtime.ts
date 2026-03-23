import { createHash } from "node:crypto";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ToolCall
} from "@mariozechner/pi-ai";
import type {
  CopilotConfig,
  CopilotInboundEvent,
  CopilotMode,
  CopilotRequestConfig,
  CopilotServerConfig,
  PersistedCopilotState
} from "../types.js";
import type { SessionTraceWriter } from "../core/session-trace.js";
import { generateClientSessionId } from "../core/ids.js";
import {
  buildMessagePreviewEvent,
  buildPongEvent,
  buildReportLocalConsentsEvent,
  buildSendEvent,
  buildSetOptionsEvent
} from "../protocol/messages.js";
import { CopilotConversationService } from "../transport/conversation-service.js";
import { CopilotWebSocketClient } from "../transport/websocket-client.js";
import { buildRepairPrompt, buildToolPrompt, getPromptBudget, parseCopilotToolResponse } from "./tool-protocol.js";

export interface SessionRuntimeDependencies {
  fetchImpl?: typeof fetch;
  webSocketFactory?: ConstructorParameters<typeof CopilotWebSocketClient>[2];
  traceWriter?: SessionTraceWriter;
}

interface EnsureSessionResult {
  conversationId: string;
  clientSessionId: string;
}

type ResponseHandlingMode = "streamingText" | "toolAware";
type ToolRecoveryReason = "empty" | "invalid-shape" | "too-many-messages" | "conversation-error";
type RequestStage = "initial" | "same-conversation-repair" | "fresh-conversation-replay";

interface RequestPolicy {
  originalPrompt: string;
  sameConversationRepairsRemaining: number;
  freshConversationReplayAvailable: boolean;
  stage: RequestStage;
}

export class CopilotSessionRuntime {
  private state: PersistedCopilotState;
  private transport: CopilotWebSocketClient | null = null;
  private inflight = false;
  private lastInboundEventId: string | undefined;
  private serverConfigPromise: Promise<CopilotServerConfig> | null = null;
  private activeAccessTokenFingerprint: string | undefined;

  constructor(
    private readonly config: CopilotConfig,
    sessionId: string,
    persistedState: PersistedCopilotState | undefined,
    private readonly persistState: (state: PersistedCopilotState) => void,
    private readonly dependencies: SessionRuntimeDependencies = {}
  ) {
    this.state = persistedState || {
      version: 2,
      sessionId,
      conversationId: config.conversationId || "",
      clientSessionId: config.clientSessionId || generateClientSessionId(),
      updatedAt: new Date().toISOString()
    };
  }

  get persistedState(): PersistedCopilotState {
    return this.state;
  }

  updatePersistedState(persistedState: PersistedCopilotState | undefined): void {
    if (persistedState) {
      this.state = persistedState;
      this.activeAccessTokenFingerprint = persistedState.accessTokenFingerprint;
    }
  }

  disconnect(): void {
    this.transport?.disconnect(1000, "session-switch");
    this.transport = null;
    this.inflight = false;
  }

  async streamPrompt(
    model: Model<any>,
    prompt: string,
    accessToken: string | undefined,
    abortSignal?: AbortSignal
  ): Promise<AssistantMessageEventStream> {
    if (!accessToken?.trim()) {
      return createImmediateErrorStream(
        model,
        "Microsoft Copilot is not logged in. Run /login microsoft-copilot or set MICROSOFT_COPILOT_ACCESS_TOKEN."
      );
    }

    await this.prepareForAccessToken(accessToken);
    const serverConfig = await this.getServerConfig(accessToken);
    return this.startRequest({
      model,
      prompt: truncateForTransport(prompt, getPromptBudget(serverConfig.maxTextMessageLength)),
      accessToken,
      abortSignal,
      mode: "streamingText"
    });
  }

  async streamContext(
    model: Model<any>,
    context: Context,
    mode: CopilotMode | undefined,
    accessToken: string | undefined,
    abortSignal?: AbortSignal
  ): Promise<AssistantMessageEventStream> {
    if (!accessToken?.trim()) {
      return createImmediateErrorStream(
        model,
        "Microsoft Copilot is not logged in. Run /login microsoft-copilot or set MICROSOFT_COPILOT_ACCESS_TOKEN."
      );
    }

    await this.prepareForAccessToken(accessToken);
    const serverConfig = await this.getServerConfig(accessToken);
    const builtPrompt = buildToolPrompt(context, { maxPromptChars: getPromptBudget(serverConfig.maxTextMessageLength) });
    this.dependencies.traceWriter?.write("prompt.built", builtPrompt.metadata);
    return this.startRequest({
      model,
      prompt: builtPrompt.prompt,
      copilotMode: mode,
      accessToken,
      abortSignal,
      mode: "toolAware"
    });
  }

  private async startRequest(input: {
    model: Model<any>;
    prompt: string;
    copilotMode?: CopilotMode;
    accessToken: string;
    abortSignal?: AbortSignal;
    mode: ResponseHandlingMode;
    policy?: RequestPolicy;
  }): Promise<AssistantMessageEventStream> {
    const stream = createAssistantMessageEventStream();

    if (!input.prompt.trim()) {
      queueMicrotask(() => {
        stream.push({
          type: "error",
          reason: "error",
          error: createAssistantMessage(input.model, "error", [], "Prompt is empty")
        });
      });
      return stream;
    }

    if (this.inflight) {
      queueMicrotask(() => {
        stream.push({
          type: "error",
          reason: "error",
          error: createAssistantMessage(
            input.model,
            "error",
            [],
            "Microsoft Copilot only supports one in-flight request per session"
          )
        });
      });
      return stream;
    }

    const policy =
      input.policy ||
      {
        originalPrompt: input.prompt,
        sameConversationRepairsRemaining: input.mode === "toolAware" ? 1 : 0,
        freshConversationReplayAvailable: input.mode === "toolAware",
        stage: "initial" as const
      };

    this.inflight = true;
    void this.runStream(
      stream,
      input.model,
      input.prompt,
      input.copilotMode,
      input.accessToken,
      input.mode,
      input.abortSignal,
      policy
    );
    return stream;
  }

  private async runStream(
    stream: AssistantMessageEventStream,
    model: Model<any>,
    prompt: string,
    copilotMode: CopilotMode | undefined,
    accessToken: string,
    responseHandlingMode: ResponseHandlingMode,
    abortSignal: AbortSignal | undefined,
    policy: RequestPolicy
  ): Promise<void> {
    let aborted = false;
    let removeAbortListener: (() => void) | undefined;
    let settleCompletion!: () => void;
    let completionSettled = false;
    const completion = new Promise<void>((resolve) => {
      settleCompletion = () => {
        if (completionSettled) {
          return;
        }
        completionSettled = true;
        resolve();
      };
    });

    const abortHandler = () => {
      aborted = true;
      this.transport?.disconnect(1000, "aborted");
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        aborted = true;
      } else {
        abortSignal.addEventListener("abort", abortHandler, { once: true });
        removeAbortListener = () => abortSignal.removeEventListener("abort", abortHandler);
      }
    }

    try {
      if (aborted) {
        stream.push({
          type: "error",
          reason: "aborted",
          error: createAssistantMessage(model, "aborted", [], "Request was aborted")
        });
        return;
      }

      const { conversationId } = await this.ensureSession(accessToken);
      const transport = await this.ensureConnected(accessToken);

      const partial = createAssistantMessage(model, "stop", []);
      const textContent = { type: "text" as const, text: "" };

      let started = false;
      let completed = false;
      let handedOff = false;
      const cleanup = () => {
        transport.off("message", onMessage);
        transport.off("close", onClose);
        transport.off("error", onError);
      };

      const fail = (reason: "aborted" | "error", message: string) => {
        if (completed) {
          return;
        }
        completed = true;
        cleanup();
        stream.push({
          type: "error",
          reason,
          error: createAssistantMessage(model, reason, partial.content, message)
        });
        settleCompletion();
      };

      const handOffRequest = (): boolean => {
        if (completed || handedOff) {
          return false;
        }

        handedOff = true;
        completed = true;
        cleanup();
        this.inflight = false;
        return true;
      };

      const failAfterHandOff = (message: string) => {
        stream.push({
          type: "error",
          reason: "error",
          error: createAssistantMessage(model, "error", partial.content, message)
        });
        settleCompletion();
      };

      const replayInFreshConversation = async (reason: ToolRecoveryReason) => {
        if (!policy.freshConversationReplayAvailable) {
          fail("error", `Copilot returned an unusable response after tool results (${reason})`);
          return;
        }

        if (!handOffRequest()) {
          return;
        }

        this.dependencies.traceWriter?.write("conversation.replay", {
          reason,
          previousConversationId: this.state.conversationId,
          stage: policy.stage
        });
        try {
          await this.recreateConversation(accessToken);
          const retriedStream = await this.startRequest({
            model,
            prompt: policy.originalPrompt,
            copilotMode,
            accessToken,
            abortSignal,
            mode: responseHandlingMode,
            policy: {
              originalPrompt: policy.originalPrompt,
              sameConversationRepairsRemaining: 0,
              freshConversationReplayAvailable: false,
              stage: "fresh-conversation-replay"
            }
          });
          for await (const event of retriedStream) {
            stream.push(event);
          }
          settleCompletion();
        } catch (error) {
          failAfterHandOff(error instanceof Error ? error.message : String(error));
        }
      };

      const retryToolAwareResponse = async (reason: "empty" | "invalid-shape", rawReply: string) => {
        if (policy.sameConversationRepairsRemaining <= 0) {
          await replayInFreshConversation(reason);
          return;
        }

        if (!handOffRequest()) {
          return;
        }

        try {
          const repairPrompt = buildRepairPrompt(policy.originalPrompt, reason, rawReply, {
            maxPromptChars: getPromptBudget((await this.getServerConfig(accessToken)).maxTextMessageLength)
          });
          this.dependencies.traceWriter?.write("prompt.repair", {
            ...repairPrompt.metadata,
            stage: "same-conversation-repair",
            baseStage: policy.stage
          });
          const retriedStream = await this.startRequest({
            model,
            prompt: repairPrompt.prompt,
            copilotMode,
            accessToken,
            abortSignal,
            mode: responseHandlingMode,
            policy: {
              originalPrompt: policy.originalPrompt,
              sameConversationRepairsRemaining: policy.sameConversationRepairsRemaining - 1,
              freshConversationReplayAvailable: policy.freshConversationReplayAvailable,
              stage: "same-conversation-repair"
            }
          });
          for await (const event of retriedStream) {
            stream.push(event);
          }
          settleCompletion();
        } catch (error) {
          failAfterHandOff(error instanceof Error ? error.message : String(error));
        }
      };

      const emitToolAwareResult = async () => {
        const rawText = textContent.text;
        if (!rawText.trim()) {
          await retryToolAwareResponse("empty", rawText);
          return;
        }

        const parsed = parseCopilotToolResponse(rawText);
        if (!parsed) {
          await retryToolAwareResponse("invalid-shape", rawText);
          return;
        }

        if (parsed.kind === "message") {
          if (!parsed.text.trim()) {
            await retryToolAwareResponse("empty", rawText);
            return;
          }
          completed = true;
          emitFinalText(stream, partial, parsed.text);
          stream.push({
            type: "done",
            reason: "stop",
            message: createAssistantMessage(model, "stop", [{ type: "text", text: parsed.text }])
          });
          settleCompletion();
          return;
        }

        completed = true;
        partial.content = parsed.toolCalls;
        stream.push({ type: "start", partial });
        parsed.toolCalls.forEach((toolCall, contentIndex) => {
          stream.push({ type: "toolcall_start", contentIndex, partial });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial });
        });
        stream.push({
          type: "done",
          reason: "toolUse",
          message: createAssistantMessage(model, "toolUse", parsed.toolCalls)
        });
        settleCompletion();
      };

      const finish = async () => {
        if (completed) {
          return;
        }

        if (responseHandlingMode === "toolAware") {
          await emitToolAwareResult();
          return;
        }

        completed = true;
        cleanup();
        emitFinalText(stream, partial, textContent.text, started);
        stream.push({
          type: "done",
          reason: "stop",
          message: createAssistantMessage(model, "stop", [{ type: "text", text: textContent.text }])
        });
        settleCompletion();
      };

      const onMessage = async (event: CopilotInboundEvent) => {
        try {
          this.lastInboundEventId = event.id || this.lastInboundEventId;
          if (event.event === "ping") {
            transport.sendJson(buildPongEvent({ pingId: event.id, lastEventId: this.lastInboundEventId }));
            return;
          }

          if (event.event === "error") {
            const code = event.errorCode || "unknown";
            if (isRecoverableConversationError(code)) {
              await replayInFreshConversation(code === "too-many-messages" ? "too-many-messages" : "conversation-error");
            } else {
              fail("error", `Copilot server rejected the request: ${code}`);
            }
            return;
          }

          if (event.event === "appendText") {
            if (responseHandlingMode === "streamingText" && !started) {
              partial.content = [textContent];
              started = true;
              stream.push({ type: "start", partial });
              stream.push({ type: "text_start", contentIndex: 0, partial });
            }

            textContent.text += event.text || "";

            if (responseHandlingMode === "streamingText") {
              stream.push({
                type: "text_delta",
                contentIndex: 0,
                delta: event.text || "",
                partial
              });
            }
            return;
          }

          if (event.event === "done") {
            await finish();
          }
        } catch (error) {
          fail("error", error instanceof Error ? error.message : String(error));
        }
      };

      const onClose = () => {
        if (!completed) {
          fail(aborted ? "aborted" : "error", aborted ? "Request was aborted" : "Socket closed mid-response");
        }
      };

      const onError = (error: Error) => {
        fail(aborted ? "aborted" : "error", error.message);
      };

      transport.on("message", onMessage);
      transport.on("close", onClose);
      transport.on("error", onError);

      transport.sendJson(buildMessagePreviewEvent({ conversationId, prompt }));
      transport.sendJson(buildSendEvent({ conversationId, prompt, mode: copilotMode || this.config.mode }));
      await completion;
    } catch (error) {
      stream.push({
        type: "error",
        reason: aborted ? "aborted" : "error",
        error: createAssistantMessage(
          model,
          aborted ? "aborted" : "error",
          [],
          error instanceof Error ? error.message : String(error)
        )
      });
      settleCompletion();
    } finally {
      removeAbortListener?.();
      this.inflight = false;
    }
  }

  private async ensureSession(accessToken: string): Promise<EnsureSessionResult> {
    if (!this.state.conversationId) {
      this.state = {
        ...this.state,
        conversationId: await this.createConversationService(accessToken).createConversation(),
        updatedAt: new Date().toISOString()
      };
      this.persistState(this.state);
    }

    return {
      conversationId: this.state.conversationId,
      clientSessionId: this.state.clientSessionId
    };
  }

  private async recreateConversation(accessToken: string): Promise<void> {
    this.transport?.disconnect(1000, "recreate-conversation");
    this.transport = null;
    this.state = {
      ...this.state,
      conversationId: await this.createConversationService(accessToken).createConversation(),
      updatedAt: new Date().toISOString()
    };
    this.persistState(this.state);
  }

  private async ensureConnected(accessToken: string): Promise<CopilotWebSocketClient> {
    if (!this.transport) {
      this.transport = new CopilotWebSocketClient(
        this.buildRequestConfig(accessToken),
        this.state.clientSessionId,
        this.dependencies.webSocketFactory,
        this.dependencies.traceWriter
      );
    }

    if (!this.transport.isConnected) {
      await this.transport.connect();
      this.transport.sendJson(buildSetOptionsEvent());
      this.transport.sendJson(buildReportLocalConsentsEvent());
    }

    return this.transport;
  }

  private async getServerConfig(accessToken: string): Promise<CopilotServerConfig> {
    if (!this.serverConfigPromise) {
      this.serverConfigPromise = this.createConversationService(accessToken).getServerConfig();
    }

    return this.serverConfigPromise;
  }

  private createConversationService(accessToken: string): CopilotConversationService {
    return new CopilotConversationService(
      this.buildRequestConfig(accessToken),
      this.dependencies.fetchImpl,
      this.dependencies.traceWriter
    );
  }

  private buildRequestConfig(accessToken: string): CopilotRequestConfig {
    return {
      ...this.config,
      accessToken
    };
  }

  private async prepareForAccessToken(accessToken: string): Promise<void> {
    const nextFingerprint = fingerprintAccessToken(accessToken);
    const persistedFingerprint = this.state.accessTokenFingerprint;

    if (this.activeAccessTokenFingerprint === undefined) {
      this.activeAccessTokenFingerprint = persistedFingerprint;
    }

    const tokenChanged =
      (persistedFingerprint !== undefined && persistedFingerprint !== nextFingerprint) ||
      (this.activeAccessTokenFingerprint !== undefined && this.activeAccessTokenFingerprint !== nextFingerprint);

    if (!tokenChanged) {
      this.activeAccessTokenFingerprint = nextFingerprint;
      if (this.state.version !== 2 || persistedFingerprint !== nextFingerprint) {
        this.state = {
          ...this.state,
          version: 2,
          accessTokenFingerprint: nextFingerprint,
          updatedAt: new Date().toISOString()
        };
        this.persistState(this.state);
      }
      return;
    }

    this.transport?.disconnect(1000, "access-token-changed");
    this.transport = null;
    this.serverConfigPromise = null;
    this.lastInboundEventId = undefined;

    this.state = {
      ...this.state,
      version: 2,
      conversationId: "",
      clientSessionId: generateClientSessionId(),
      accessTokenFingerprint: nextFingerprint,
      updatedAt: new Date().toISOString()
    };
    this.activeAccessTokenFingerprint = nextFingerprint;
    this.persistState(this.state);
  }
}

function createImmediateErrorStream(model: Model<any>, message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({
      type: "error",
      reason: "error",
      error: createAssistantMessage(model, "error", [], message)
    });
  });
  return stream;
}

function emitFinalText(
  stream: AssistantMessageEventStream,
  partial: AssistantMessage,
  text: string,
  alreadyStarted = false
): void {
  partial.content = [{ type: "text", text }];
  if (!alreadyStarted) {
    stream.push({ type: "start", partial });
    stream.push({ type: "text_start", contentIndex: 0, partial });
    stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial });
  }
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial });
}

function isRecoverableConversationError(errorCode: string): boolean {
  return /conversation|not.?found|invalid-event|too-many-messages/i.test(errorCode);
}

function createAssistantMessage(
  model: Model<any>,
  stopReason: "stop" | "toolUse" | "error" | "aborted",
  content: AssistantMessage["content"],
  errorMessage?: string
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    errorMessage,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    timestamp: Date.now()
  };
}

function truncateForTransport(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  const marker = `\n...[truncated ${value.length - maxChars} chars]...\n`;
  if (marker.length >= maxChars) {
    return value.slice(0, maxChars);
  }
  const head = Math.max(0, Math.floor((maxChars - marker.length) * 0.7));
  const tail = Math.max(0, maxChars - marker.length - head);
  return `${value.slice(0, head)}${marker}${value.slice(value.length - tail)}`;
}

function fingerprintAccessToken(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex").slice(0, 16);
}
