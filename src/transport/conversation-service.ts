import type { CopilotRequestConfig, CopilotServerConfig } from "../types.js";
import type { SessionTraceWriter } from "../core/session-trace.js";

const DEFAULT_SERVER_CONFIG: CopilotServerConfig = {
  maxTextMessageLength: 10240
};

export class CopilotConversationService {
  private serverConfigPromise: Promise<CopilotServerConfig> | null = null;

  constructor(
    private readonly config: CopilotRequestConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly traceWriter?: SessionTraceWriter
  ) {}

  async createConversation(): Promise<string> {
    const url = "https://copilot.microsoft.com/c/api/conversations";
    const headers: Record<string, string> = {
      Accept: "*/*",
      Authorization: `Bearer ${this.config.accessToken}`,
      Origin: this.config.origin,
      Referer: this.config.origin,
      "User-Agent": this.config.userAgent,
      "X-Search-UILang": "en-gb"
    };

    if (this.config.cookie) {
      headers.Cookie = this.config.cookie;
    }

    this.traceWriter?.write("conversation.create.request", { url, hasCookie: Boolean(this.config.cookie) });

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers
    });

    const text = await response.text();
    const body = text ? safeJsonParse(text) : null;

    this.traceWriter?.write("conversation.create.response", {
      ok: response.ok,
      status: response.status,
      body
    });

    if (!response.ok) {
      throw new Error(`Conversation bootstrap failed with HTTP ${response.status}`);
    }

    const conversationId =
      body?.conversationId ?? body?.id ?? body?.conversation?.id ?? body?.data?.conversationId ?? null;

    if (!conversationId) {
      throw new Error("Conversation bootstrap succeeded but no conversation id was returned");
    }

    return conversationId;
  }

  async getServerConfig(): Promise<CopilotServerConfig> {
    if (!this.serverConfigPromise) {
      this.serverConfigPromise = this.fetchServerConfig().catch((error) => {
        this.traceWriter?.write("config.fetch.error", {
          message: error instanceof Error ? error.message : String(error),
          fallback: DEFAULT_SERVER_CONFIG
        });
        return DEFAULT_SERVER_CONFIG;
      });
    }

    return this.serverConfigPromise;
  }

  private async fetchServerConfig(): Promise<CopilotServerConfig> {
    const url = `https://copilot.microsoft.com/c/api/config?api-version=${encodeURIComponent(this.config.apiVersion)}`;
    const headers: Record<string, string> = {
      Accept: "*/*",
      Authorization: `Bearer ${this.config.accessToken}`,
      Origin: this.config.origin,
      Referer: this.config.origin,
      "User-Agent": this.config.userAgent,
      "X-Search-UILang": "en-gb"
    };

    if (this.config.cookie) {
      headers.Cookie = this.config.cookie;
    }

    this.traceWriter?.write("config.fetch.request", { url, hasCookie: Boolean(this.config.cookie) });

    const response = await this.fetchImpl(url, { headers });
    const text = await response.text();
    const body = text ? safeJsonParse(text) : null;

    this.traceWriter?.write("config.fetch.response", {
      ok: response.ok,
      status: response.status,
      body: body
        ? {
            maxTextMessageLength: body.maxTextMessageLength,
            maxPageContentLength: body.maxPageContentLength,
            maxPageTitleLength: body.maxPageTitleLength,
            messagePreview: body.messagePreview,
            messageRecoveryInMinutes: body.messageRecoveryInMinutes,
            pageLimit: body.pageLimit
          }
        : null
    });

    if (!response.ok) {
      throw new Error(`Copilot config fetch failed with HTTP ${response.status}`);
    }

    const maxTextMessageLength =
      typeof body?.maxTextMessageLength === "number" && body.maxTextMessageLength > 0
        ? body.maxTextMessageLength
        : DEFAULT_SERVER_CONFIG.maxTextMessageLength;

    return {
      maxTextMessageLength,
      maxPageContentLength:
        typeof body?.maxPageContentLength === "number" ? body.maxPageContentLength : undefined,
      maxPageTitleLength: typeof body?.maxPageTitleLength === "number" ? body.maxPageTitleLength : undefined,
      messagePreview: body?.messagePreview && typeof body.messagePreview === "object" ? body.messagePreview : undefined,
      messageRecoveryInMinutes:
        typeof body?.messageRecoveryInMinutes === "number" ? body.messageRecoveryInMinutes : undefined,
      pageLimit: typeof body?.pageLimit === "number" ? body.pageLimit : undefined
    };
  }
}

function safeJsonParse(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
