import { readFile } from "node:fs/promises";
import { defineConfig, type UserConfig } from "tsdown";

const RAW_SUFFIX = "?raw";

const config: UserConfig = defineConfig({
  entry: {
    server: "src/server/index.ts",
    client: "src/client/index.ts",
  },
  format: "esm",
  platform: "neutral",
  dts: true,
  plugins: [
    {
      // Inlines `import x from "file?raw"` as a string, matching Vite/Vitest
      // semantics. Used to embed the built admin UI into the server bundle.
      name: "nextbase:raw",
      async resolveId(source, importer) {
        if (!source.endsWith(RAW_SUFFIX)) return null;
        const resolved = await this.resolve(
          source.slice(0, -RAW_SUFFIX.length),
          importer,
          { skipSelf: true },
        );
        // Fail instead of silently externalizing: a `?raw` import must be inlined.
        if (!resolved) this.error(`Cannot resolve raw import "${source}".`);
        return `${resolved.id}${RAW_SUFFIX}`;
      },
      async load(id) {
        if (!id.endsWith(RAW_SUFFIX)) return null;
        const file = id.slice(0, -RAW_SUFFIX.length);
        // Rebuild in `tsdown --watch` when the admin UI is rebuilt.
        this.addWatchFile(file);
        const content = await readFile(file, "utf8");
        return `export default ${JSON.stringify(content)};`;
      },
    },
  ],
});

export default config;
