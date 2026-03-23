import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@mariozechner/pi-ai": fileURLToPath(new URL("./test/shims/pi-ai.ts", import.meta.url)),
      "@mariozechner/pi-coding-agent": fileURLToPath(new URL("./test/shims/pi-coding-agent.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
