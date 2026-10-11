import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8787' },
  },
  test: {
    root,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
} as never);
