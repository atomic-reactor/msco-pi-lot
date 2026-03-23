import type { StopReason, Usage } from "@mariozechner/pi-ai";

export type CopilotMode = "reasoning" | "smart";

export interface CopilotConfig {
  accessToken: string;
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
  version: 1;
  sessionId: string;
  conversationId: string;
  clientSessionId: string;
  updatedAt: string;
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
