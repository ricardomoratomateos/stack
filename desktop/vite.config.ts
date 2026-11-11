import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // `@core` is the extension's own source: the sidebar's rules (derive.ts) are shared, not copied.
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, '../src'),
      '@codicons': path.resolve(__dirname, '../node_modules/@vscode/codicons/dist'),
    },
  },
  // WKWebView on current macOS: no need to lower ES2021+. Lowering xterm's `r ||= {}` let the
  // minifier drop `let r`, so its DECRQM handler threw a ReferenceError and the terminal stopped.
  build: { target: 'safari16' },
  server: { port: 1420, strictPort: true, fs: { allow: ['..'] } },
});
