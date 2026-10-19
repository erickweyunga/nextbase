import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
  entry: { index: "src/index.ts" },
  format: "esm",
  platform: "neutral",
  dts: true,
  failOnWarn: true,
  // Every export is client-only. The bundler does not keep module-level
  // directives from source, so add the directive to the output instead.
  banner: { js: '"use client";' },
});

export default config;
