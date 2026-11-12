import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

// The version stackd reports is the root package.json's (esbuild.js); the app compares with the same one.
const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version as string;

export default defineConfig({
  plugins: [react()],
  define: { __STACK_VERSION__: JSON.stringify(version) },
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
