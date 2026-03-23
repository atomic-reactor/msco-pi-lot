import EventEmitter from "node:events";
import WebSocket from "ws";
import type { CopilotConfig } from "../types.js";
import type { SessionTraceWriter } from "../core/session-trace.js";
import { buildWebSocketHeaders, buildWebSocketUrl } from "../protocol/messages.js";

export interface CopilotWebSocketClientEvents {
  open: [];
  message: [any];
  rawMessage: [string];
  close: [{ code: number; reason: string }];
  error: [Error];
  sent: [Record<string, unknown>];
}

export class CopilotWebSocketClient extends EventEmitter<CopilotWebSocketClientEvents> {
  private socket: WebSocket | null = null;

  constructor(
    private readonly config: CopilotConfig,
    private readonly clientSessionId: string,
    private readonly webSocketFactory: (url: URL, options: { headers: Record<string, string> }) => WebSocket = (
      url,
      options
    ) => new WebSocket(url, options),
    private readonly traceWriter?: SessionTraceWriter
  ) {
    super();
  }

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.isConnected) {
      return;
    }

    if (this.socket && this.socket.readyState === WebSocket.CONNECTING) {
      await EventEmitter.once(this, "open");
      return;
    }

    const url = buildWebSocketUrl(this.config, this.clientSessionId);
    const headers = buildWebSocketHeaders(this.config);
    this.traceWriter?.write("socket.connecting", { url: url.toString(), hasCookie: Boolean(this.config.cookie) });

    await new Promise<void>((resolve, reject) => {
      const socket = this.webSocketFactory(url, { headers });
      this.socket = socket;

      socket.on("open", () => {
        this.traceWriter?.write("socket.open");
        this.emit("open");
        resolve();
      });

      socket.on("message", (data) => {
        const payload = data.toString();
        this.traceWriter?.write("socket.inbound.raw", { payload });
        this.emit("rawMessage", payload);

        try {
          this.emit("message", JSON.parse(payload));
        } catch (error) {
          this.emit("error", new Error(`Invalid JSON from websocket: ${(error as Error).message}`));
        }
      });

      socket.on("close", (code, reason) => {
        this.traceWriter?.write("socket.close", { code, reason: reason.toString() });
        this.socket = null;
        this.emit("close", { code, reason: reason.toString() });
      });

      socket.on("error", (error) => {
        this.traceWriter?.write("socket.error", { message: error.message });
        this.emit("error", error);
        if (socket.readyState !== WebSocket.OPEN) {
          reject(error);
        }
      });
    });
  }

  sendJson(payload: Record<string, unknown>): void {
    if (!this.isConnected || !this.socket) {
      throw new Error("WebSocket is not connected");
    }

    this.traceWriter?.write("socket.outbound.json", { payload });
    this.socket.send(JSON.stringify(payload));
    this.emit("sent", payload);
  }

  disconnect(code = 1000, reason = "normal"): void {
    if (!this.socket) {
      return;
    }

    this.traceWriter?.write("socket.disconnect", { code, reason });
    this.socket.close(code, reason);
    this.socket = null;
  }
}
