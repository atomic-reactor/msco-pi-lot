# Stateful WebSocket Modification Plan for Microsoft Copilot PI Extension

## Executive Summary

**Current Behavior**: Every request sends the full prompt, including conversation history.

**Target Behavior**: Leverage Microsoft Copilot's **server-side stateful WebSocket connection**:
- First message in session: Send system prompt + initial context → Server stores this
- Subsequent messages: Send ONLY the delta/new content → Server appends to its existing conversation state  
- No need to rebuild full prompt on every request because server maintains conversation history

**Key Insight**: Microsoft Copilot's WebSocket connection is stateful at the server level. We don't need to persist and resend full conversation history with each request—we just need to send incremental deltas after the initial setup message.

---

## Core Changes Required

### 1. Track Minimal State for Error Recovery (`src/runtime/session-runtime.ts`)

Add fields to track state needed for error recovery and reconnection:

```typescript
export class CopilotSessionRuntime {
  // Track last event ID from server for ordering/deduplication (for error recovery)
  private lastEventId: string | undefined;
  
  // Track if we've sent the initial system prompt in this WebSocket session
  private hasSentInitialPrompt = false;
}
```

**Purpose**: NOT to rebuild full prompts, but to:
- Send only deltas on subsequent messages (server maintains conversation)
- Track state for error recovery/reconnection scenarios where we may need to replay context
- Maintain minimal ordering information for message deduplication

---

### 2. Detect First vs Subsequent Messages (`src/runtime/session-runtime.ts`)

Modify `runStream()` to track message sequence:

```typescript
private async runStream(...) {
  const isFirstMessageInSession = !this.hasSentInitialPrompt;
  
  // ... existing logic ...
  
  transport.on("open", () => {
    if (isFirstMessageInSession) {
      // Send full prompt with system context (server stores this)
      this.sendSystemPrompt(prompt);
      this.hasSentInitialPrompt = true;
    } else {
      // Server already has conversation state, send only delta
      this.sendIncrementalUpdate(prompt);
    }
  });
}

private sendSystemPrompt(fullPrompt: string): void {
  transport.sendJson(buildSendEvent({
    conversationId: this.state.conversationId,
    prompt: fullPrompt, // System prompt + initial context (server stores)
    mode: copilotMode || this.config.mode
  }));
}

private sendIncrementalUpdate(newContent: string): void {
  transport.sendJson(buildIncrementalMessageEvent({
    conversationId: this.state.conversationId,
    delta: newContent, // Only the new content (server appends to existing state)
    lastEventId: this.lastInboundEventId
  }));
}
```

---

### 3. Add Incremental Message Protocol (`src/protocol/messages.ts`)

Add support for sending deltas (server maintains conversation state):

```typescript
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
        isIncremental: true // NEW FLAG - tells server this is a delta
      }
    ],
    mode: "smart" | "reasoning",
    lastEventId: input.lastEventId || undefined
  };
}

// Update existing builders to support incremental flag
export function buildSendEvent(input: {
  conversationId: string;
  prompt: string;
  mode: CopilotMode;
  isIncremental?: boolean; // NEW - default false for backward compat
}): Record<string, unknown> {
  return buildPromptEvent({
    event: "send",
    conversationId: input.conversationId,
    prompt: input.prompt,
    mode: input.mode,
    isIncremental: input.isIncremental || false
  });
}

function buildPromptEvent(input: {
  event: "messagePreview" | "send";
  conversationId: string;
  prompt: string;
  mode: CopilotMode;
  isIncremental?: boolean; // NEW
}): Record<string, unknown> {
  return {
    event: input.event,
    conversationId: input.conversationId,
    content: [
      {
        type: "text",
        text: input.prompt,
        isIncremental: input.isIncremental || false // NEW
      }
    ],
    mode: input.mode
  };
}
```

---

### 4. Minimal State Persistence (`src/types.ts` + `src/runtime/session-runtime.ts`)

Add minimal state for error recovery (NOT full conversation history):

```typescript
// src/types.ts
export interface PersistedCopilotState {
  version: 1 | 2;
  sessionId: string;
  conversationId: string;
  clientSessionId: string;
  accessTokenFingerprint?: string;
  updatedAt: string;
  
  // NEW: Minimal state for error recovery (NOT full history - server maintains it)
  lastEventId?: string;              // Last event ID from server for ordering
  hasSentInitialPrompt?: boolean;    // Track if initial system prompt was sent
}
```

Update `CopilotSessionRuntime` to persist minimal state:

```typescript
export class CopilotSessionRuntime {
  private state: PersistedCopilotState;
  
  // ... existing fields ...
  
  async updateLastEventId(eventId: string): Promise<void> {
    this.lastInboundEventId = eventId;
    if (this.state.version === 2) {
      this.state.lastEventId = eventId;
      this.persistState(this.state);
    }
  }

  async resetInitialPromptFlag(): Promise<void> {
    this.hasSentInitialPrompt = false;
    if (this.state.version === 2) {
      this.state.hasSentInitialPrompt = false;
      this.persistState(this.state);
    }
  }
}
```

---

### 5. Handle WebSocket Reconnections (`src/transport/websocket-client.ts`)

Preserve minimal state across reconnections:

```typescript
export class CopilotWebSocketClient extends EventEmitter<CopilotWebSocketClientEvents> {
  private socket: WebSocket | null = null;
  // NEW: Track if we've sent initial prompt in this session
  private hasSentInitialPromptInSession = false;

  async connect(): Promise<void> {
    // ... existing connection logic ...
    
    socket.on("open", () => {
      this.traceWriter?.write("socket.open");
      this.emit("open");
      
      // Send setOptions and consents (existing)
      this.sendJson(buildSetOptionsEvent());
      this.sendJson(buildReportLocalConsentsEvent());
      
      // NEW: Check if we need to send initial prompt
      if (!this.hasSentInitialPromptInSession && this.conversationHistory) {
        await this.sendSystemPrompt(this.conversationHistory);
        this.hasSentInitialPromptInSession = true;
      }
      
      resolve();
    });
  }

  // NEW: Send system prompt with full history
  private async sendSystemPrompt(history: Array<{ role: string; content: string }>): Promise<void> {
    const fullPrompt = buildConversationPromptFromHistory(history);
    
    this.sendJson(buildSendEvent({
      conversationId: this.config.conversationId,
      prompt: fullPrompt,
      mode: this.config.mode
    }));
  }

  // NEW: Track history for reconnection
  setConversationHistory(history: Array<{ role: string; content: string }>): void {
    this.conversationHistory = history;
  }
}
```

---

### 6. Update Session Lifecycle (`src/index.ts`)

Handle conversation state during session events:

```typescript
pi.on("session_start", async (_event, ctx) => {
  reconstructState(sessionStore, runtimeManager, ctx);
});

pi.on("session_switch", async (_event, ctx) => {
  if (_event.reason === "new") {
    // NEW session - clear conversation history
    seedFreshState(sessionStore, runtimeManager, ctx);
    return;
  }
  
  // Session switch (not new) - preserve conversation history
  reconstructState(sessionStore, runtimeManager, ctx);
});

pi.on("session_shutdown", async (_event, ctx) => {
  runtimeManager.disconnectSession(ctx.sessionManager.getSessionId());
});
```

---

## Implementation Priority

### Phase 1: Foundation (2-3 hours)
1. Add minimal state fields to `PersistedCopilotState` (`src/types.ts`) - lastEventId, hasSentInitialPrompt
2. Add tracking fields to `CopilotSessionRuntime` (`src/runtime/session-runtime.ts`) 
3. Implement `updateLastEventId()` and `resetInitialPromptFlag()` methods

### Phase 2: Protocol Updates (2-3 hours)
4. Add `buildIncrementalMessageEvent()` to `src/protocol/messages.ts`
5. Update existing event builders to support `isIncremental` flag
6. Test protocol changes with mock WebSocket

### Phase 3: Runtime Logic (3-4 hours)
7. Modify `runStream()` to detect first vs subsequent messages
8. Implement `sendSystemPrompt()` and `sendIncrementalUpdate()`
9. Wire up message tracking in response handlers

### Phase 4: Transport Layer (2-3 hours)
10. Add conversation history tracking to `CopilotWebSocketClient`
11. Handle initial prompt on WebSocket open
12. Implement reconnection with state preservation

### Phase 5: Testing & Polish (2-3 hours)
13. Write unit tests for message tracking
14. Test multi-turn conversations
15. Add feature flag for gradual rollout

---

## Configuration Options

Add optional configuration to control behavior:

```typescript
export interface CopilotConfig {
  // ... existing fields ...
  
  enableStatefulMode?: boolean; // NEW - default true for stateful mode
  maxConversationHistorySize?: number; // NEW - limit history size (default: 50)
}
```

**Environment Variable**: `MICROSOFT_COPILOT_ENABLE_STATEFUL_MODE` or `COPILOT_ENABLE_STATEFUL_MODE`
- Default: `true` (stateful mode enabled)
- Set to `false` to disable and use legacy behavior (send full prompt every time)

---

## Testing Checklist

- [ ] Single message works correctly
- [ ] Multi-turn conversation maintains context
- [ ] WebSocket reconnection preserves state
- [ ] Session switch clears history for new sessions
- [ ] Error recovery replays full conversation
- [ ] Incremental messages don't duplicate content
- [ ] Memory usage stays within bounds

---

## Backward Compatibility

**Default Behavior**: Keep `enableStatefulMode = true` by default (stateful mode enabled).
Users who need legacy behavior can disable it:
```bash
export MICROSOFT_COPILOT_ENABLE_STATEFUL_MODE=false
```

This ensures:
1. New deployments get the benefits of stateful communication automatically
2. Users experiencing issues can opt-out via environment variable
3. Easy rollback if issues arise

---

## Expected Benefits

| Metric | Before | After (Stateful) | Improvement |
|--------|--------|------------------|-------------|
| Bytes per request | ~50KB+ | ~100-500 bytes | 99% reduction |
| Server context tracking | None | **Server maintains state** | Better responses |
| Latency | Higher (full prompt) | Lower (delta only) | Faster for subsequent messages |
| Network overhead | High | Minimal | Efficient use of bandwidth |

---

## Risk Mitigation

### Risk: Server doesn't support incremental messages
**Mitigation**: Add feature detection in initial handshake, fall back to full prompts if unsupported.

### Risk: State desynchronization after errors
**Mitigation**: Use message IDs from server responses, implement retry with exponential backoff.

### Risk: Memory usage grows unbounded
**Mitigation**: Limit history size via config option, implement sliding window (keep last N messages).

---

## Files to Modify Summary

| File | Lines Changed | Complexity |
|------|---------------|------------|
| `src/types.ts` | +10 lines | Low |
| `src/protocol/messages.ts` | +35 lines | Medium |
| `src/runtime/session-runtime.ts` | +80 lines | High |
| `src/transport/websocket-client.ts` | +45 lines | Medium |
| `src/index.ts` | +5 lines | Low |

**Total**: ~175 lines of new code across 5 files.

---

## Next Steps

1. Review and approve this plan
2. Start with Phase 1 (add minimal state tracking)
3. Implement incrementally with tests at each phase
4. Add feature flag for gradual rollout
5. Monitor metrics during beta period
