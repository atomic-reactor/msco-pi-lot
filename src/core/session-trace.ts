import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { maskCookie, maskSecret } from "./mask-secrets.js";

function sanitize(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/accessToken=([^&]+)/g, (_match, secret) => `accessToken=${maskSecret(secret)}`)
      .replace(/("accessToken":")([^"]+)(")/g, `$1***$3`)
      .replace(/("Authorization":"Bearer )([^"]+)(")/g, `$1***$3`)
      .replace(/("Cookie":")([^"]+)(")/g, (_match, prefix, cookie, suffix) => `${prefix}${maskCookie(cookie)}${suffix}`);
  }

  if (Array.isArray(value)) {
    return value.map(sanitize);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
        if (key === "accessToken" || key === "Authorization") {
          return [key, "***"];
        }
        if (key === "cookie" || key === "Cookie") {
          return [key, typeof entry === "string" ? maskCookie(entry) : "***"];
        }
        return [key, sanitize(entry)];
      })
    );
  }

  return value;
}

export class SessionTraceWriter {
  readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath || join("logs", `copilot-session-${Date.now()}.ndjson`);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  write(type: string, payload?: unknown): void {
    const row = {
      timestamp: new Date().toISOString(),
      type,
      payload: sanitize(payload)
    };
    appendFileSync(this.filePath, `${JSON.stringify(row)}\n`);
  }
}
