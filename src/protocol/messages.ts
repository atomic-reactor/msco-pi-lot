import type { CopilotMode, CopilotRequestConfig } from "../types.js";

const SUPPORTED_FEATURES = ["partial-generated-images"];

const SUPPORTED_CARDS = [
  "weather",
  "local",
  "image",
  "inlineImage",
  "sports",
  "video",
  "inlineVideo",
  "healthcareEntity",
  "healthcareInfo",
  "safetyHelpline",
  "quiz",
  "finance",
  "recipe",
  "personalArtifacts",
  "flashcard",
  "navigation",
  "person",
  "consentV2",
  "composeEmail"
];

const SUPPORTED_UI_COMPONENTS = {
  Badge: "1.2",
  Basic: "1.2",
  Box: "1.2",
  Button: "1.2",
  Card: "1.2",
  Caption: "1.2",
  Chart: "1.2",
  Checkbox: "1.2",
  Col: "1.2",
  DatePicker: "1.2",
  Divider: "1.2",
  Form: "1.2",
  Icon: "1.2",
  Image: "1.2",
  Label: "1.2",
  ListView: "1.2",
  ListViewItem: "1.2",
  Map: "1.3",
  Markdown: "1.2",
  Pressable: "1.3",
  RadioGroup: "1.2",
  Row: "1.2",
  Select: "1.2",
  Spacer: "1.2",
  Text: "1.2",
  Textarea: "1.2",
  Title: "1.2",
  Transition: "1.2"
};

const SUPPORTED_ACTIONS: string[] = [];

export function buildWebSocketUrl(config: CopilotRequestConfig, clientSessionId: string): URL {
  const url = new URL("wss://copilot.microsoft.com/c/api/chat");
  url.searchParams.set("api-version", config.apiVersion);
  url.searchParams.set("clientSessionId", clientSessionId);
  url.searchParams.set("accessToken", config.accessToken);
  url.searchParams.set("channel", config.channel);
  url.searchParams.set("edgetab", "1");
  return url;
}

export function buildWebSocketHeaders(config: CopilotRequestConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Origin: config.origin,
    "User-Agent": config.userAgent
  };

  if (config.cookie) {
    headers.Cookie = config.cookie;
  }

  return headers;
}

export function buildSetOptionsEvent(): Record<string, unknown> {
  return {
    event: "setOptions",
    supportedFeatures: SUPPORTED_FEATURES,
    supportedCards: SUPPORTED_CARDS,
    supportedUIComponents: SUPPORTED_UI_COMPONENTS,
    ads: null,
    supportedActions: SUPPORTED_ACTIONS
  };
}

export function buildReportLocalConsentsEvent(): Record<string, unknown> {
  return {
    event: "reportLocalConsents",
    grantedConsents: []
  };
}

export function buildMessagePreviewEvent(input: {
  conversationId: string;
  prompt: string;
}): Record<string, unknown> {
  return buildPromptEvent({
    event: "messagePreview",
    conversationId: input.conversationId,
    prompt: input.prompt,
    mode: "smart"
  });
}

export function buildSendEvent(input: {
  conversationId: string;
  prompt: string;
  mode: CopilotMode;
}): Record<string, unknown> {
  return buildPromptEvent({
    event: "send",
    conversationId: input.conversationId,
    prompt: input.prompt,
    mode: input.mode
  });
}

export function buildPongEvent(input: { pingId?: string; lastEventId?: string }): Record<string, unknown> {
  return {
    event: "pong",
    id: input.pingId || `${input.lastEventId || "0"}.0001`
  };
}

function buildPromptEvent(input: {
  event: "messagePreview" | "send";
  conversationId: string;
  prompt: string;
  mode: CopilotMode;
}): Record<string, unknown> {
  return {
    event: input.event,
    conversationId: input.conversationId,
    content: [
      {
        type: "text",
        text: input.prompt
      }
    ],
    mode: input.mode
  };
}
