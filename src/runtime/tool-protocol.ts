import { randomUUID } from "node:crypto";
import type { Context, Message, TextContent, Tool, ToolCall } from "@mariozechner/pi-ai";

export type ParsedCopilotResponse =
  | { kind: "message"; text: string }
  | { kind: "toolCalls"; toolCalls: ToolCall[] };

export type ToolPromptKind = "initial" | "continuation" | "repair";

export interface ToolPromptMetadata {
  kind: ToolPromptKind;
  promptChars: number;
  contractChars: number;
  toolSummaryChars: number;
  currentTurnChars: number;
  toolCount: number;
  taskAnchorChars: number;
  workingDirectory?: string;
  repairReason?: "empty" | "invalid-shape";
}

export interface BuiltToolPrompt {
  prompt: string;
  metadata: ToolPromptMetadata;
}

export interface ToolPromptOptions {
  maxPromptChars?: number;
}

const TOOL_PROTOCOL_INSTRUCTIONS = [
  "You are a coding agent running inside pi.",
  "You must respond with JSON only.",
  "Never claim you executed a tool yourself.",
  "Use responseType message for a normal answer, or responseType toolCalls for one or more tool requests.",
  "Valid JSON response shapes:",
  '{"responseType":"message","text":"plain natural language answer"}',
  '{"responseType":"toolCalls","toolCalls":[{"name":"tool_name","arguments":{"key":"value"}}]}',
  "Never return an empty response.",
  "If more information is needed, request the next toolCalls immediately.",
  "If the available information is sufficient, return responseType message immediately.",
  "Prefer read for file inspection. Use bash mainly for listing, searching, or simple commands.",
  "Tool arguments must be valid JSON. Keep shell commands short and single-line.",
  "Do not wrap the JSON in markdown fences."
].join("\n");

const DEFAULT_MAX_PROMPT_CHARS = 9728;
const MAX_TOOLS_SECTION_CHARS = 2400;
const MAX_CONVERSATION_CHARS = 16000;
const MAX_USER_MESSAGE_CHARS = 3000;
const MAX_ASSISTANT_TEXT_CHARS = 2000;
const MAX_TOOL_RESULT_CHARS = 2500;
const MAX_REPAIR_REPLY_CHARS = 1200;

export function buildToolAwarePrompt(context: Context, options: ToolPromptOptions = {}): string {
  return buildToolPrompt(context, options).prompt;
}

export function buildToolPrompt(context: Context, options: ToolPromptOptions = {}): BuiltToolPrompt {
  const limits = resolvePromptLimits(options.maxPromptChars);
  const workingDirectory = extractWorkingDirectory(context.systemPrompt);
  const toolSummary = truncateText(formatTools(context.tools || []), limits.maxToolsSectionChars);
  const currentTurn = formatCurrentTurn(context.messages, limits);
  const kind = currentTurn.kind;
  const taskAnchorChars = currentTurn.taskAnchor?.length || 0;
  const sections = [
    TOOL_PROTOCOL_INSTRUCTIONS,
    workingDirectory ? `WORKING DIRECTORY\n${workingDirectory}` : "",
    toolSummary ? `AVAILABLE TOOLS\n${toolSummary}` : "",
    `CURRENT TURN\n${currentTurn.text}`
  ].filter(Boolean);

  const prompt = truncateText(sections.join("\n\n"), limits.maxPromptChars);
  return {
    prompt,
    metadata: {
      kind,
      promptChars: prompt.length,
      contractChars: TOOL_PROTOCOL_INSTRUCTIONS.length,
      toolSummaryChars: toolSummary.length,
      currentTurnChars: currentTurn.text.length,
      toolCount: context.tools?.length || 0,
      taskAnchorChars,
      workingDirectory
    }
  };
}

export function buildRepairPrompt(
  basePrompt: string,
  reason: "empty" | "invalid-shape",
  rawReply: string,
  options: ToolPromptOptions = {}
): BuiltToolPrompt {
  const limits = resolvePromptLimits(options.maxPromptChars);
  const repairTail = [
    "REPAIR",
    `The previous reply was ${reason === "empty" ? "empty" : "not valid JSON in the required envelope"}.`,
    rawReply.trim() ? `Previous reply:\n${truncateText(rawReply.trim(), limits.maxRepairReplyChars)}` : "",
    'Respond now with JSON only using exactly one of these shapes: {"responseType":"message","text":"..."} or {"responseType":"toolCalls","toolCalls":[...]} .'
  ]
    .filter(Boolean)
    .join("\n\n");
  const prompt = truncateText(`${basePrompt}\n\n${repairTail}`, limits.maxPromptChars);
  return {
    prompt,
    metadata: {
      kind: "repair",
      promptChars: prompt.length,
      contractChars: 0,
      toolSummaryChars: 0,
      currentTurnChars: 0,
      toolCount: 0,
      taskAnchorChars: 0,
      repairReason: reason
    }
  };
}

export function parseCopilotToolResponse(text: string): ParsedCopilotResponse | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const payload = extractJsonPayload(trimmed);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const responseType = normalizeString((payload as Record<string, unknown>).responseType ?? (payload as Record<string, unknown>).type);
  if (responseType === "message") {
    return {
      kind: "message",
      text: extractFinalText(payload as Record<string, unknown>)
    };
  }

  const toolCalls = extractToolCalls(payload as Record<string, unknown>);
  if (toolCalls.length > 0) {
    return { kind: "toolCalls", toolCalls };
  }

  return null;
}

function formatTools(tools: Tool[]): string {
  if (tools.length === 0) {
    return "No tools are available.";
  }

  return tools
    .map((tool) => {
      const parameterSummary = summarizeToolParameters(tool);
      return `- ${tool.name}${parameterSummary ? `(${parameterSummary})` : ""}: ${compactDescription(tool.description)}`;
    })
    .join("\n");
}

function formatCurrentTurn(
  messages: Message[],
  limits: PromptLimits
): { kind: Exclude<ToolPromptKind, "repair">; text: string; taskAnchor?: string } {
  if (messages.length === 0) {
    return { kind: "initial", text: "No current turn content." };
  }

  const latest = messages[messages.length - 1];
  if (latest.role === "user") {
    return {
      kind: "initial",
      taskAnchor: normalizeMessageContent(latest.content),
      text: ["TASK", truncateText(normalizeMessageContent(latest.content), limits.maxUserMessageChars)].join("\n")
    };
  }

  const continuationBlock = collectTrailingContinuation(messages);
  const userRequest = findContinuationUserRequest(messages, continuationBlock);
  const rendered = [
    userRequest ? ["TASK", truncateText(normalizeMessageContent(userRequest.content), limits.maxUserMessageChars)].join("\n") : "",
    continuationBlock.map((message) => formatMessage(message, limits)).join("\n\n")
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    kind: "continuation",
    taskAnchor: userRequest ? normalizeMessageContent(userRequest.content) : undefined,
    text: truncateText(
      [
        "Continue the current task using this latest tool activity.",
        "Do not wait for another user message.",
        rendered || "No current turn content."
      ].join("\n\n"),
      limits.maxConversationChars
    )
  };
}

function formatMessage(message: Message, limits: PromptLimits): string {
  if (message.role === "user") {
    return ["USER", truncateText(normalizeMessageContent(message.content), limits.maxUserMessageChars)].join("\n");
  }

  if (message.role === "toolResult") {
    return [
      `TOOL RESULT ${message.toolName} ${message.isError ? "(error)" : "(success)"}`,
      `toolCallId: ${message.toolCallId}`,
      truncateText(normalizeMessageContent(message.content), limits.maxToolResultChars)
    ].join("\n");
  }

  return [
    "ASSISTANT",
    message.content
      .map((content) => {
        if (content.type === "text") {
          return truncateText(content.text, limits.maxAssistantTextChars);
        }
        if (content.type === "thinking") {
          return `<thinking>${truncateText(content.thinking, limits.maxAssistantTextChars)}</thinking>`;
        }
        return JSON.stringify({
          toolCall: {
            id: content.id,
            name: content.name,
            arguments: content.arguments
          }
        });
      })
      .join("\n")
  ].join("\n");
}

function normalizeMessageContent(content: string | Array<TextContent | { type: "image"; data: string; mimeType: string }>): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      return `[image:${part.mimeType}]`;
    })
    .join("\n");
}

function extractJsonPayload(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const parsed = safeParseJson(fenced[1]);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const direct = safeParseJson(text);
  if (direct !== undefined) {
    return direct;
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return safeParseJson(text.slice(start, end + 1));
  }

  return undefined;
}

function extractFinalText(payload: Record<string, unknown>): string {
  const direct = normalizeString(payload.text);
  if (direct) {
    return direct;
  }

  const content = payload.content;
  if (typeof content === "string") {
    return content;
  }

  if (content && typeof content === "object" && !Array.isArray(content)) {
    return normalizeString((content as Record<string, unknown>).text) || "";
  }

  return "";
}

function extractToolCalls(payload: Record<string, unknown>): ToolCall[] {
  const rawToolCalls =
    asArray(payload.toolCalls) ??
    asArray(payload.calls) ??
    asArray(payload.actions) ??
    (payload.toolCall ? [payload.toolCall] : []);

  const normalized: ToolCall[] = [];
  for (const candidate of rawToolCalls) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const name = normalizeString(record.name);
    if (!name) {
      continue;
    }

    const rawArguments = record.arguments ?? record.args ?? {};
    const argumentsObject = normalizeArguments(rawArguments);
    if (!argumentsObject) {
      continue;
    }

    normalized.push({
      type: "toolCall",
      id: normalizeString(record.id) || `call_${randomUUID()}`,
      name,
      arguments: argumentsObject
    });
  }

  return normalized;
}

function normalizeArguments(value: unknown): Record<string, unknown> | null {
  if (!value) {
    return {};
  }

  if (typeof value === "string") {
    const parsed = safeParseJson(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return null;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function sanitizeSystemPrompt(systemPrompt: string | undefined): string {
  if (!systemPrompt?.trim()) {
    return "";
  }

  return systemPrompt
    .replace(/(?:\n|^)Pi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):\n(?:- .*(?:\n|$))+/m, "\n")
    .trim();
}

function extractWorkingDirectory(systemPrompt: string | undefined): string | undefined {
  const sanitized = sanitizeSystemPrompt(systemPrompt);
  const match = sanitized.match(/Current working directory:\s*(.+)$/m);
  return match?.[1]?.trim();
}

function summarizeToolParameters(tool: Tool): string {
  const properties = (tool.parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties) {
    return "";
  }

  return Object.keys(properties).slice(0, 4).join(", ");
}

function compactDescription(description: string | undefined): string {
  if (!description) {
    return "";
  }

  return description.replace(/\s+/g, " ").trim();
}

function collectTrailingContinuation(messages: Message[]): Message[] {
  const collected: Message[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "toolResult") {
      collected.unshift(message);
      continue;
    }

    if (message.role === "assistant" && message.content.some((content) => content.type === "toolCall")) {
      collected.unshift(message);
    }
    break;
  }

  return collected;
}

function findContinuationUserRequest(messages: Message[], continuationBlock: Message[]): Message | undefined {
  if (continuationBlock.length === 0) {
    return undefined;
  }

  const firstContinuation = continuationBlock[0];
  const startIndex = messages.indexOf(firstContinuation);
  if (startIndex <= 0) {
    return undefined;
  }

  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user") {
      return message;
    }
  }

  return undefined;
}

function truncateText(value: string, maxChars: number): string {
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

interface PromptLimits {
  maxPromptChars: number;
  maxToolsSectionChars: number;
  maxConversationChars: number;
  maxUserMessageChars: number;
  maxAssistantTextChars: number;
  maxToolResultChars: number;
  maxRepairReplyChars: number;
}

export function getPromptBudget(maxTextMessageLength: number): number {
  if (!Number.isFinite(maxTextMessageLength)) {
    return 0;
  }

  const normalizedLimit = Math.max(0, Math.floor(maxTextMessageLength));
  if (normalizedLimit <= 512) {
    return normalizedLimit;
  }

  return Math.min(DEFAULT_MAX_PROMPT_CHARS, normalizedLimit - 512);
}

function resolvePromptLimits(maxPromptChars = DEFAULT_MAX_PROMPT_CHARS): PromptLimits {
  const safeMaxPromptChars = Number.isFinite(maxPromptChars) ? Math.max(0, Math.floor(maxPromptChars)) : 0;
  return {
    maxPromptChars: safeMaxPromptChars,
    maxToolsSectionChars:
      safeMaxPromptChars <= 0 ? 0 : Math.min(MAX_TOOLS_SECTION_CHARS, Math.max(600, Math.floor(safeMaxPromptChars * 0.25))),
    maxConversationChars:
      safeMaxPromptChars <= 0 ? 0 : Math.min(MAX_CONVERSATION_CHARS, Math.max(1400, Math.floor(safeMaxPromptChars * 0.52))),
    maxUserMessageChars:
      safeMaxPromptChars <= 0 ? 0 : Math.min(MAX_USER_MESSAGE_CHARS, Math.max(600, Math.floor(safeMaxPromptChars * 0.3))),
    maxAssistantTextChars:
      safeMaxPromptChars <= 0 ? 0 : Math.min(MAX_ASSISTANT_TEXT_CHARS, Math.max(400, Math.floor(safeMaxPromptChars * 0.18))),
    maxToolResultChars:
      safeMaxPromptChars <= 0 ? 0 : Math.min(MAX_TOOL_RESULT_CHARS, Math.max(700, Math.floor(safeMaxPromptChars * 0.22))),
    maxRepairReplyChars:
      safeMaxPromptChars <= 0 ? 0 : Math.min(MAX_REPAIR_REPLY_CHARS, Math.max(300, Math.floor(safeMaxPromptChars * 0.12)))
  };
}
