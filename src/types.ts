import type { StopReason, Usage } from "@mariozechner/pi-ai";

export type CopilotMode = "reasoning" | "smart";

export interface CopilotConfig {
  cookie: string;
  conversationId?: string;
  clientSessionId?: string;
  mode: CopilotMode;
  channel: string;
  apiVersion: string;
  debug: boolean;
  trace: boolean;
  traceFile?: string;
  origin: string;
  userAgent: string;
  
  // NEW: Feature flag for stateful WebSocket communication
  enableStatefulMode?: boolean; // Default true - leverages server-side conversation state
}

export interface CopilotRequestConfig extends CopilotConfig {
  accessToken: string;
}

export interface CopilotServerConfig {
  maxTextMessageLength: number;
  maxPageContentLength?: number;
  maxPageTitleLength?: number;
  messagePreview?: {
    minTextLength?: number;
    textDeltaPercent?: number;
    debounceInMilliseconds?: number;
  };
  messageRecoveryInMinutes?: number;
  pageLimit?: number;
}

export interface PersistedCopilotState {
  version: 1 | 2;
  sessionId: string;
  conversationId: string;
  clientSessionId: string;
  accessTokenFingerprint?: string;
  updatedAt: string;

  // NEW FIELDS - Minimal state for error recovery and session management (NOT full history)
  lastEventId?: string;              // Last event ID from server for ordering/deduplication
  hasSentInitialPrompt?: boolean;    // Track if initial system prompt was sent in this WebSocket session
  estimatedContextTokens?: number;   // Locally estimated Copilot conversation context size
}

export interface CopilotInboundEvent {
  event: string;
  id?: string;
  messageId?: string;
  partId?: string;
  text?: string;
  errorCode?: string;
  title?: string;
  url?: string;
}

export interface CopilotUsage extends Usage {}

export interface CopilotFinalMessage {
  stopReason: StopReason;
  errorMessage?: string;
}
