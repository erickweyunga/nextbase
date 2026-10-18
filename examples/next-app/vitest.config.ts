import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    // Each file starts a Next.js server.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

export default config;
