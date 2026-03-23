import { describe, expect, test } from "vitest";
import {
  buildRepairPrompt,
  buildToolAwarePrompt,
  buildToolPrompt,
  getPromptBudget,
  parseCopilotToolResponse
} from "../src/runtime/tool-protocol.js";

describe("tool protocol", () => {
  test("builds a compact tool-aware prompt with tools and transcript", () => {
    const built = buildToolPrompt({
      systemPrompt: "Be precise.",
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string" }
            }
          }
        } as any
      ],
      messages: [{ role: "user", content: "Read package.json", timestamp: 1 }]
    });

    const prompt = built.prompt;
    expect(built.metadata.kind).toBe("initial");
    expect(prompt).toContain("AVAILABLE TOOLS");
    expect(prompt).toContain("CURRENT TURN");
    expect(prompt).toContain("read(path)");
    expect(prompt).toContain("TASK");
    expect(prompt).toContain("Read package.json");
    expect(prompt).toContain('"responseType":"toolCalls"');
    expect(prompt).not.toContain("SYSTEM PROMPT");
  });

  test("keeps only compact workspace context from the inherited system prompt", () => {
    const built = buildToolPrompt({
      systemPrompt: `You are an expert coding assistant.

Guidelines:
- Be concise

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: /tmp/README.md
- Additional docs: /tmp/docs
- Examples: /tmp/examples

Current date: 2026-03-23
Current working directory: /workspace`,
      messages: [{ role: "user", content: "Hello", timestamp: 1 }]
    });

    const prompt = built.prompt;
    expect(prompt).toContain("WORKING DIRECTORY");
    expect(prompt).toContain("/workspace");
    expect(prompt).not.toContain("Pi documentation");
    expect(prompt).not.toContain("Main documentation: /tmp/README.md");
    expect(prompt).not.toContain("You are an expert coding assistant.");
  });

  test("parses final JSON responses", () => {
    const parsed = parseCopilotToolResponse('{"responseType":"message","text":"Done."}');
    expect(parsed).toEqual({ kind: "message", text: "Done." });
  });

  test("parses tool call JSON responses wrapped in markdown fences", () => {
    const parsed = parseCopilotToolResponse(
      '```json\n{"responseType":"toolCalls","toolCalls":[{"name":"bash","arguments":{"command":"pwd"}}]}\n```'
    );

    expect(parsed).toMatchObject({
      kind: "toolCalls",
      toolCalls: [{ type: "toolCall", name: "bash", arguments: { command: "pwd" } }]
    });
  });

  test("preserves multiple tool calls when Copilot returns them", () => {
    const parsed = parseCopilotToolResponse(
      '{"responseType":"toolCalls","toolCalls":[{"name":"bash","arguments":{"command":"pwd"}},{"name":"read","arguments":{"path":"README.md"}}]}'
    );

    expect(parsed).toMatchObject({
      kind: "toolCalls",
      toolCalls: [
        { type: "toolCall", name: "bash", arguments: { command: "pwd" } },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } }
      ]
    });
  });

  test("parses the previously failing multi-tool bash response verbatim", () => {
    const payload =
      `{"responseType":"toolCalls","toolCalls":[{"name":"bash","arguments":{"command":"ls -la"}},{"name":"bash","arguments":{"command":"rg --hidden --glob '!node_modules' -n \\"^\\\\s*main\\\\b|entry|start|module.exports|exports|createServer|listen\\\\(|new\\\\s+Server|app\\\\.listen|program\\\\.|commander|yargs|bin\\" || true"}},{"name":"bash","arguments":{"command":"ls -la package.json || true"}},{"name":"bash","arguments":{"command":"sed -n '1,240p' package.json || true"}},{"name":"bash","arguments":{"command":"ls -la src || true"}},{"name":"bash","arguments":{"command":"sed -n '1,240p' src/index.ts || true"}},{"name":"bash","arguments":{"command":"sed -n '1,240p' src/adapter.ts || true"}},{"name":"bash","arguments":{"command":"sed -n '1,240p' src/server.ts || true"}},{"name":"bash","arguments":{"command":"sed -n '1,240p' src/config.ts || true"}}]}`;

    const parsed = parseCopilotToolResponse(payload);

    expect(parsed).toMatchObject({
      kind: "toolCalls",
      toolCalls: [
        { type: "toolCall", name: "bash", arguments: { command: "ls -la" } },
        {
          type: "toolCall",
          name: "bash",
          arguments: {
            command:
              `rg --hidden --glob '!node_modules' -n "^\\s*main\\b|entry|start|module.exports|exports|createServer|listen\\(|new\\s+Server|app\\.listen|program\\.|commander|yargs|bin" || true`
          }
        },
        { type: "toolCall", name: "bash", arguments: { command: "ls -la package.json || true" } },
        { type: "toolCall", name: "bash", arguments: { command: "sed -n '1,240p' package.json || true" } },
        { type: "toolCall", name: "bash", arguments: { command: "ls -la src || true" } },
        { type: "toolCall", name: "bash", arguments: { command: "sed -n '1,240p' src/index.ts || true" } },
        { type: "toolCall", name: "bash", arguments: { command: "sed -n '1,240p' src/adapter.ts || true" } },
        { type: "toolCall", name: "bash", arguments: { command: "sed -n '1,240p' src/server.ts || true" } },
        { type: "toolCall", name: "bash", arguments: { command: "sed -n '1,240p' src/config.ts || true" } }
      ]
    });

    expect(parsed?.kind).toBe("toolCalls");
    if (parsed?.kind === "toolCalls") {
      expect(parsed.toolCalls).toHaveLength(9);
    }
  });

  test("returns null for plain text responses that are not JSON tool envelopes", () => {
    expect(parseCopilotToolResponse("I checked the files and here is what I found.")).toBeNull();
  });

  test("returns null for empty tool responses", () => {
    expect(parseCopilotToolResponse("   ")).toBeNull();
  });

  test("truncates oversized tool-aware prompts", () => {
    const prompt = buildToolAwarePrompt({
      systemPrompt: "x".repeat(12000),
      tools: [
        {
          name: "bash",
          description: "Run shell commands",
          parameters: {
            type: "object",
            properties: {
              command: {
                type: "string",
                description: "y".repeat(4000)
              }
            }
          }
        } as any
      ],
      messages: [
        { role: "user", content: "Inspect the repo", timestamp: 1 },
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "z".repeat(15000) }],
          isError: false,
          timestamp: 2
        }
      ]
    });

    expect(prompt.length).toBeLessThanOrEqual(9728);
    expect(prompt).toContain("[truncated");
  });

  test("derives a conservative prompt budget from maxTextMessageLength", () => {
    expect(getPromptBudget(10240)).toBe(9728);
    expect(getPromptBudget(4096)).toBe(3584);
    expect(getPromptBudget(1500)).toBe(988);
    expect(getPromptBudget(512)).toBe(512);
    expect(getPromptBudget(128)).toBe(128);
    expect(getPromptBudget(0)).toBe(0);
    expect(getPromptBudget(-1)).toBe(0);
    expect(getPromptBudget(Number.NaN)).toBe(0);
    expect(getPromptBudget(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("uses only the latest continuation block instead of replaying the full conversation", () => {
    const built = buildToolPrompt({
      messages: [
        { role: "user", content: "First request", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }], api: "x", provider: "y", model: "z", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 },
        { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } }], api: "x", provider: "y", model: "z", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 3 },
        { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "Readme contents" }], isError: false, timestamp: 4 }
      ]
    });

    const prompt = built.prompt;
    expect(built.metadata.kind).toBe("continuation");
    expect(prompt).toContain("Continue the current task");
    expect(prompt).toContain("TASK");
    expect(prompt).toContain("First request");
    expect(prompt).toContain("Readme contents");
    expect(prompt).not.toContain("Earlier answer");
  });

  test("builds a repair prompt with the prior raw reply and reason", () => {
    const built = buildRepairPrompt("BASE PROMPT", "invalid-shape", "not json");

    expect(built.metadata.kind).toBe("repair");
    expect(built.metadata.repairReason).toBe("invalid-shape");
    expect(built.prompt).toContain("BASE PROMPT");
    expect(built.prompt).toContain("Previous reply");
    expect(built.prompt).toContain("not json");
  });
});
