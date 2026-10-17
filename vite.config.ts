/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // API calls go to Pages Functions running under `npm run dev:api` (wrangler on :8788).
    proxy: { '/api': 'http://localhost:8788' },
  },
  test: { include: ['tests/**/*.test.ts'] },
});
