import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate from vite.config.ts so tests don't boot the Cloudflare/React plugins.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
