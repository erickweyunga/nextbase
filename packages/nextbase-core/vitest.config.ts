import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // Most files create a database, migrate it and hash passwords with
    // scrypt, all in parallel with other packages' suites under turbo.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});

export default config;
