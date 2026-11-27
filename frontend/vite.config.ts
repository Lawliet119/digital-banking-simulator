import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { devAuthPlugin } from './dev/dev-auth-plugin';

/** Where `npm run dev` sends `/v1` and `/health`: the backend started with `npm run start:dev`. */
const apiTarget = process.env.DBS_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react(), devAuthPlugin()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Same origin for the browser: the API needs no CORS for local work.
    proxy: {
      '/v1': { target: apiTarget, changeOrigin: false },
      '/health': { target: apiTarget, changeOrigin: false },
    },
  },
  build: { sourcemap: true },
  test: {
    include: ['src/**/*.test.ts', 'dev/**/*.test.ts'],
    environment: 'node',
  },
});
