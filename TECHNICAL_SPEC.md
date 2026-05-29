# Technical Implementation Specification
## Stateful WebSocket Communication for Microsoft Copilot PI Extension

**Version**: 1.0  
**Date**: May 29, 2026  
**Scope**: Modify extension to leverage server-side conversation state via incremental delta messages

---

## Overview

This specification details the exact code changes required to transform the Microsoft Copilot PI extension from sending full prompts on every request to leveraging the server's stateful WebSocket connection by sending only incremental deltas after the initial setup message.

### Key Principle
**Server maintains conversation context**. We send:
1. **First message**: System prompt + initial context (server stores this)
2. **Subsequent messages**: Only the delta/new content (server appends to existing state)

---

## File-by-File Implementation Details

### 1. `src/types.ts` - Add Minimal State Fields

**Purpose**: Extend persisted state with minimal tracking fields for error recovery and session management.

```typescript
// ADD THESE FIELDS TO PersistedCopilotState interface:

export interface PersistedCopilotState {
  version: 1 | 2;
  sessionId: string;
  conversationId: string;
  clientSessionId: string;
  accessTokenFingerprint?: string;
  updatedAt: string;
  
  // NEW FIELDS - Minimal state for error recovery (NOT full history)
  lastEventId?: string;              // Last event ID from server for ordering/deduplication
  hasSentInitialPrompt?: boolean;    // Track if initial system prompt was sent in this session
}
```

**Rationale**: 
- `lastEventId`: Used to track message ordering and detect duplicates during reconnection
- `hasSentInitialPrompt`: Prevents sending full prompt again after first message in WebSocket session

---

### 2. `src/protocol/messages.ts` - Add Incremental Message Protocol

**Purpose**: Define protocol messages for sending deltas instead of full prompts.

```typescript
// ADD NEW FUNCTION:

export function buildIncrementalMessageEvent(input: {
  conversationId: string;
  delta: string;
  lastEventId?: string;
}): Record<string, unknown> {
  return {
    event: "send",
    conversationId: input.conversationId,
    content: [
      {
        type: "text",
        text: input.delta,
        isIncremental: true // NEW FLAG - tells server this is a delta, not full prompt
      }
    ],
    mode: "smart" | "reasoning",
    lastEventId: input.lastEventId || undefined
  };
}

// MODIFY buildSendEvent to support incremental flag:

export function buildSendEvent(input: {
  conversationId: string;
  prompt: string;
  mode: CopilotMode;
  isIncremental?: boolean; // NEW PARAMETER - default false for backward compatibility
}): Record<string, unknown> {
  return buildPromptEvent({
    event: "send",
    conversationId: input.conversationId,
    prompt: input.prompt,
    mode: input.mode,
    isIncremental: input.isIncremental || false // Default to false for backward compat
  });
}

// MODIFY internal helper function:

function buildPromptEvent(input: {
  event: "messagePreview" | "send";
  conversationId: string;
  prompt: string;
  mode: CopilotMode;
  isIncremental?: boolean; // NEW PARAMETER
}): Record<string, unknown> {
  return {
    event: input.event,
    conversationId: input.conversationId,
    content: [
      {
        type: "text",
        text: input.prompt,
        isIncremental: input.isIncremental || false // NEW FIELD - tells server to append only this delta
      }
    ],
    mode: input.mode
  };
}
```

**Protocol Behavior**:
- `isIncremental: true` → Server appends only the delta text to existing conversation state
- `isIncremental: false` (default) → Server treats as full prompt (backward compatible)

---

### 3. `src/runtime/session-runtime.ts` - Core Runtime Changes

**Purpose**: Implement logic to detect first vs subsequent messages and send appropriate payload.

#### A. Add State Fields to Class

```typescript
export class CopilotSessionRuntime {
  private state: PersistedCopilotState;
  private transport: CopilotWebSocketClient | null = null;
  private inflight = false;
  private lastInboundEventId: string | undefined;
  private serverConfigPromise: Promise<CopilotServerConfig> | null = null;
  private activeAccessTokenFingerprint: string | undefined;
  
  // NEW FIELDS - Track message sequence and state
  private hasSentInitialPrompt = false;      // Has this WebSocket session received initial prompt?
  private lastInboundEventId: string | undefined; // Last event ID from server for ordering
  
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
    
    // Restore state from persisted data if available
    if (persistedState) {
      this.hasSentInitialPrompt = persistedState.hasSentInitialPrompt || false;
      this.lastInboundEventId = persistedState.lastEventId || undefined;
    }
  }
}
```

#### B. Add State Update Methods

```typescript
// ADD THESE METHODS:

async updateLastEventId(eventId: string): Promise<void> {
  this.lastInboundEventId = eventId;
  
  // Persist to state store if version 2
  if (this.state.version === 2) {
    this.state.lastEventId = eventId;
    this.persistState(this.state);
  }
}

async resetInitialPromptFlag(): Promise<void> {
  this.hasSentInitialPrompt = false;
  
  // Persist to state store if version 2
  if (this.state.version === 2) {
    this.state.hasSentInitialPrompt = false;
    this.persistState(this.state);
  }
}

async updatePersistedState(persistedState: PersistedCopilotState | undefined): void {
  if (!persistedState) {
    return;
  }

  // Restore state from persisted data
  this.hasSentInitialPrompt = persistedState.hasSentInitialPrompt || false;
  this.lastInboundEventId = persistedState.lastEventId || undefined;
  
  // Update active fingerprint if token changed
  this.activeAccessTokenFingerprint = persistedState.accessTokenFingerprint;
}
```

#### C. Modify `runStream()` to Detect First vs Subsequent Messages

**Find the `transport.on("open", onMessage)` section and modify:**

```typescript
// REPLACE THIS SECTION:

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
```

**WITH THIS:**

```typescript
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

// NEW LOGIC - Detect first vs subsequent message in WebSocket session
const isFirstMessageInSession = !this.hasSentInitialPrompt;

if (isFirstMessageInSession) {
  // First message: Send full prompt with system context
  // Server stores this and maintains conversation state
  transport.sendJson(buildSendEvent({
    conversationId,
    prompt,
    mode: copilotMode || this.config.mode,
    isIncremental: false // Explicitly send as full prompt
  }));
  
  // Mark that we've sent the initial prompt in this session
  this.hasSentInitialPrompt = true;
} else {
  // Subsequent message: Send only delta (server already has conversation context)
  transport.sendJson(buildIncrementalMessageEvent({
    conversationId,
    delta: prompt, // Only send the new content as delta
    lastEventId: this.lastInboundEventId || undefined
  }));
}

await completion;
```

#### D. Update `ensureConnected()` to Reset Flag on Reconnection

**Find and modify:**

```typescript
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
    
    // Send setOptions and consents (existing behavior)
    this.transport.sendJson(buildSetOptionsEvent());
    this.transport.sendJson(buildReportLocalConsentsEvent());
    
    // NEW: Reset initial prompt flag on reconnection
    // This allows us to send full prompt again if needed after disconnection
    await this.resetInitialPromptFlag();
  }

  return this.transport;
}
```

#### E. Update `disconnect()` Method

**Find and modify:**

```typescript
disconnect(): void {
  this.transport?.disconnect(1000, "session-switch");
  this.transport = null;
  this.inflight = false;
  
  // NEW: Reset state on disconnect so next connection can send full prompt
  this.hasSentInitialPrompt = false;
}
```

---

### 4. `src/transport/websocket-client.ts` - Transport Layer Updates

**Purpose**: Handle WebSocket lifecycle and track session-level state.

#### A. Add Session State Field

```typescript
export class CopilotWebSocketClient extends EventEmitter<CopilotWebSocketClientEvents> {
  private socket: WebSocket | null = null;
  
  // NEW FIELD - Track if initial prompt was sent in this WebSocket session
  private hasSentInitialPromptInSession = false;
  
  constructor(
    private readonly config: CopilotRequestConfig,
    private readonly clientSessionId: string,
    private readonly webSocketFactory: (url: URL, options: { headers: Record<string, string> }) => WebSocket = (
      url,
      options
    ) => new WebSocket(url, options),
    private readonly traceWriter?: SessionTraceWriter
  ) {
    super();
  }
}
```

#### B. Modify `connect()` to Handle Initial Prompt

**Find the `socket.on("open", ...)` section and modify:**

```typescript
socket.on("open", () => {
  this.traceWriter?.write("socket.open");
  this.emit("open");
  
  // Send setOptions and consents (existing behavior)
  this.sendJson(buildSetOptionsEvent());
  this.sendJson(buildReportLocalConsentsEvent());
  
  // NEW: Check if we need to send initial prompt based on session state
  const shouldSendInitialPrompt = !this.hasSentInitialPromptInSession;
  
  if (shouldSendInitialPrompt) {
    // Send full system prompt - server will store this and maintain conversation context
    this.sendJson(buildSendEvent({
      conversationId: this.config.conversationId,
      prompt: "System initialization message", // Will be replaced by runtime with actual prompt
      mode: this.config.mode,
      isIncremental: false
    }));
    
    this.hasSentInitialPromptInSession = true;
  }
  
  resolve();
});
```

#### C. Modify `disconnect()` to Reset Session State

**Find and modify:**

```typescript
disconnect(code = 1000, reason = "normal"): void {
  if (!this.socket) {
    return;
  }

  this.traceWriter?.write("socket.disconnect", { code, reason });
  
  // NEW: Reset session state so next connection can send full prompt again
  this.hasSentInitialPromptInSession = false;
  
  this.socket.close(code, reason);
  this.socket = null;
}
```

---

### 5. `src/index.ts` - Session Lifecycle Updates

**Purpose**: Ensure proper state management during session events.

No changes needed to core logic, but add comments for clarity:

```typescript
pi.on("session_start", async (_event, ctx) => {
  reconstructState(sessionStore, runtimeManager, ctx);
  // NEW: Runtime will reset initial prompt flag on next message
});

pi.on("session_switch", async (_event, ctx) => {
  if (_event.reason === "new") {
    // NEW session - clear conversation history and state
    seedFreshState(sessionStore, runtimeManager, ctx);
    return;
  }
  
  // Session switch (not new) - preserve minimal state but reset prompt flag
  reconstructState(sessionStore, runtimeManager, ctx);
});

pi.on("session_fork", async (_event, ctx) => {
  reconstructState(sessionStore, runtimeManager, ctx);
});

pi.on("session_tree", async (_event, ctx) => {
  reconstructState(sessionStore, runtimeManager, ctx);
});

pi.on("session_shutdown", async (_event, ctx) => {
  // Disconnect will reset initial prompt flag for next session
  runtimeManager.disconnectSession(ctx.sessionManager.getSessionId());
});
```

---

## Implementation Sequence

### Phase 1: Type Definitions (30 minutes)
1. ✅ Add `lastEventId` and `hasSentInitialPrompt` to `PersistedCopilotState` in `src/types.ts`
2. ✅ Verify TypeScript compilation passes

### Phase 2: Protocol Messages (45 minutes)
1. ✅ Implement `buildIncrementalMessageEvent()` in `src/protocol/messages.ts`
2. ✅ Modify `buildSendEvent()` and `buildPromptEvent()` to accept `isIncremental` parameter
3. ✅ Test protocol builders with mock data

### Phase 3: Runtime State Management (60 minutes)
1. ✅ Add state fields (`hasSentInitialPrompt`, `lastInboundEventId`) to `CopilotSessionRuntime`
2. ✅ Implement `updateLastEventId()` and `resetInitialPromptFlag()` methods
3. ✅ Modify constructor to restore state from persisted data
4. ✅ Update `ensureConnected()`, `disconnect()`, and `updatePersistedState()`

### Phase 4: Message Routing Logic (60 minutes)
1. ✅ Modify `runStream()` to detect first vs subsequent messages
2. ✅ Implement conditional logic to send full prompt or delta based on state
3. ✅ Update `onClose` handler to reset flag on abnormal closure
4. ✅ Test with mock WebSocket

### Phase 5: Transport Layer (45 minutes)
1. ✅ Add `hasSentInitialPromptInSession` field to `CopilotWebSocketClient`
2. ✅ Modify `connect()` to check and send initial prompt if needed
3. ✅ Modify `disconnect()` to reset session state
4. ✅ Test WebSocket lifecycle

### Phase 6: Integration Testing (60 minutes)
1. ✅ Test single message flow
2. ✅ Test multi-turn conversation (verify deltas are sent after first message)
3. ✅ Test WebSocket reconnection (verify full prompt is resent)
4. ✅ Test session switch behavior
5. ✅ Verify backward compatibility with `isIncremental: false`

---

## Testing Strategy

### Unit Tests Required

**1. Type Definitions (`test/types.test.ts`)**
```typescript
describe("PersistedCopilotState", () => {
  it("should have lastEventId and hasSentInitialPrompt fields", () => {
    const state: PersistedCopilotState = {
      version: 2,
      sessionId: "test-session",
      conversationId: "test-conversation",
      clientSessionId: "test-client-id",
      updatedAt: new Date().toISOString(),
      lastEventId: "event-123",
      hasSentInitialPrompt: true
    };
    
    expect(state.lastEventId).toBe("event-123");
    expect(state.hasSentInitialPrompt).toBe(true);
  });
});
```

**2. Protocol Messages (`test/protocol/messages.test.ts`)**
```typescript
describe("buildIncrementalMessageEvent", () => {
  it("should create incremental message with isIncremental flag", () => {
    const event = buildIncrementalMessageEvent({
      conversationId: "test-conversation",
      delta: "New user message content"
    });
    
    expect(event.event).toBe("send");
    expect(event.content[0].isIncremental).toBe(true);
    expect(event.content[0].text).toBe("New user message content");
  });
});

describe("buildSendEvent with isIncremental", () => {
  it("should create incremental message when flag is true", () => {
    const event = buildSendEvent({
      conversationId: "test-conversation",
      prompt: "Test prompt",
      mode: "smart",
      isIncremental: true
    });
    
    expect(event.content[0].isIncremental).toBe(true);
  });

  it("should create full message when flag is false (default)", () => {
    const event = buildSendEvent({
      conversationId: "test-conversation",
      prompt: "Test prompt",
      mode: "smart"
    });
    
    expect(event.content[0].isIncremental).toBe(false);
  });
});
```

**3. Runtime State (`test/runtime/session-runtime.test.ts`)**
```typescript
describe("CopilotSessionRuntime state management", () => {
  it("should initialize hasSentInitialPrompt from persisted state", async () => {
    const runtime = new CopilotSessionRuntime(
      config,
      "test-session-id",
      {
        version: 2,
        sessionId: "test-session-id",
        conversationId: "test-conversation",
        clientSessionId: "test-client-id",
        updatedAt: new Date().toISOString(),
        hasSentInitialPrompt: true,
        lastEventId: "event-456"
      },
      () => {}
    );
    
    expect(runtime.hasSentInitialPrompt).toBe(true);
  });

  it("should reset initial prompt flag on disconnect", async () => {
    const runtime = new CopilotSessionRuntime(
      config,
      "test-session-id",
      undefined,
      () => {}
    );
    
    // Simulate sending initial prompt
    (runtime as any).hasSentInitialPrompt = true;
    
    // Call disconnect
    (runtime as any).disconnect();
    
    expect((runtime as any).hasSentInitialPrompt).toBe(false);
  });

  it("should update last event ID and persist", async () => {
    let persistedState: PersistedCopilotState | undefined;
    
    const runtime = new CopilotSessionRuntime(
      config,
      "test-session-id",
      undefined,
      (state) => { persistedState = state; }
    );
    
    await (runtime as any).updateLastEventId("event-789");
    
    expect(persistedState?.lastEventId).toBe("event-789");
  });
});
```

### Integration Tests Required

**1. Multi-Turn Conversation Flow**
```typescript
describe("Multi-turn conversation with stateful WebSocket", () => {
  it("should send full prompt on first message, then deltas", async () => {
    const mockWebSocket = new MockWebSocket();
    
    // First request - should send full prompt
    await runtime.streamPrompt(model, "First message");
    expect(mockWebSocket.sentMessages[0].isIncremental).toBe(false);
    
    // Second request - should send delta only
    await runtime.streamPrompt(model, "Second message");
    expect(mockWebSocket.sentMessages[1].isIncremental).toBe(true);
  });

  it("should reset to full prompt after WebSocket disconnect", async () => {
    const mockWebSocket = new MockWebSocket();
    
    // First request - send full prompt
    await runtime.streamPrompt(model, "First message");
    expect(mockWebSocket.sentMessages[0].isIncremental).toBe(false);
    
    // Simulate disconnect
    mockWebSocket.disconnect();
    
    // Second request after reconnect - should send full prompt again
    await runtime.streamPrompt(model, "Second message");
    expect(mockWebSocket.sentMessages[1].isIncremental).toBe(false);
  });
});
```

---

## Rollout Strategy

### Step 1: Add Feature Flag (Week 1)
- Add `enableStatefulMode` config option (default: `false`)
- When disabled, use existing behavior (send full prompt every time)
- When enabled, use new incremental message logic

### Step 2: Internal Testing (Week 2-3)
- Enable feature flag for internal testing only
- Monitor error rates and response quality
- Collect telemetry on bandwidth savings

### Step 3: Gradual Rollout (Week 4-6)
- Enable for 10% of users
- Monitor metrics and collect feedback
- Fix any issues discovered

### Step 4: Full Deployment (Week 7+)
- Enable for all users
- Deprecate old behavior in next major version

---

## Success Metrics

| Metric | Target | Measurement Method |
|--------|--------|---------------------|
| Bandwidth reduction | >95% per request after first message | Network telemetry |
| Error rate increase | <1% during transition period | Error logging |
| Response quality | No degradation in user satisfaction surveys | User feedback |
| Latency improvement | 20-30% faster for subsequent messages | Request timing metrics |

---

## Rollback Plan

If issues are discovered:

1. **Immediate**: Disable `enableStatefulMode` flag (reverts to full prompt behavior)
2. **Short-term**: Investigate and fix issues while maintaining backward compatibility
3. **Long-term**: If critical issues found, consider reverting to original implementation

---

## Dependencies

- ✅ Microsoft Copilot WebSocket API supports incremental messages (verify via feature detection)
- ✅ Server maintains conversation state across multiple `send` events in same session
- ✅ No breaking changes to existing protocol for backward compatibility

---

## Known Limitations

1. **Server Compatibility**: If server doesn't support incremental messages, fall back to full prompts
2. **Error Recovery**: May need to resend full prompt after certain error conditions
3. **Memory**: Minimal state overhead (only 2 fields per session)

---

## Next Steps After Implementation

1. Monitor bandwidth metrics for actual savings
2. Collect user feedback on response quality
3. Plan migration path to make incremental mode default in v2.0+
4. Document behavior changes for users if needed
