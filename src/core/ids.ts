import { randomUUID } from "node:crypto";

export function generateClientSessionId(): string {
  return randomUUID();
}
