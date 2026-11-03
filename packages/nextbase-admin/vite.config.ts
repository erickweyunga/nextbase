import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const backend = process.env.NEXTBASE_URL ?? 'http://localhost:3001';

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    Icons({ compiler: 'jsx', jsx: 'react' }),
    viteSingleFile(),
  ],
  base: command === 'serve' ? '/api/nextbase/_/' : '/',
  server: {
    proxy: {
      '^/api/nextbase/(?!_(/|$))': { target: backend },
    },
  },
  build: {
    emptyOutDir: false,
  },
}));
