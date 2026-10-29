import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: { index: 'src/index.ts' },
  format: 'esm',
  platform: 'neutral',
  dts: true,
  failOnWarn: true,
});

export default config;
