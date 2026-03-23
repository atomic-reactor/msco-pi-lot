import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { SessionTraceWriter } from "../src/core/session-trace.js";

describe("session trace", () => {
  test("masks secrets when writing trace rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "copilot-trace-"));
    const file = join(dir, "trace.ndjson");
    const writer = new SessionTraceWriter(file);

    writer.write("socket.outbound.json", {
      payload: {
        accessToken: "secret-token",
        Cookie: "MUID=123; ANON=456"
      },
      url: "wss://example.test?accessToken=secret-token"
    });

    const contents = readFileSync(file, "utf8");
    expect(contents).toContain('"accessToken":"***"');
    expect(contents).toContain('"Cookie":"MUID=***; ANON=***"');
    expect(contents).not.toContain("secret-token");
  });
});
