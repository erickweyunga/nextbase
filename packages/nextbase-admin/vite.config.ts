import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Everything is inlined into dist/index.html so the server can embed the
// admin UI as a single string and serve it from its own route.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    // The only output is index.html, overwritten in place. Emptying dist first
    // would let the server's watch build observe a missing file mid-rebuild.
    emptyOutDir: false,
  },
});
