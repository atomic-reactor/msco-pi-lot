import type { Context, Message, TextContent } from "@mariozechner/pi-ai";

export function extractPrompt(context: Context): string {
  const userMessages = context.messages.filter((message): message is Extract<Message, { role: "user" }> => message.role === "user");
  const latest = userMessages.at(-1);

  if (!latest) {
    throw new Error("No user message found in request context");
  }

  if (typeof latest.content === "string") {
    return latest.content.trim();
  }

  return latest.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}
