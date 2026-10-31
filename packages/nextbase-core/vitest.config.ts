import { fileURLToPath } from 'node:url';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const config: ViteUserConfig = defineConfig({
  resolve: {
    // Generated migration files import the package by name.
    alias: {
      '@nextbasejs/core': fileURLToPath(
        new URL('src/index.ts', import.meta.url),
      ),
    },
  },
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
