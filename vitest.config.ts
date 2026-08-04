import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    // The git/tmux integration suites shell out to real binaries against real
    // temp repos, so their wall-clock depends on machine load; 5s was tight
    // enough that they flaked when the whole suite runs in parallel.
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/webview/**',        // React webview — untouched by the refactor, covered by the "never changes" invariant
        'src/diff/webview/**',   // React diff-review panel — UI, exercised manually like src/webview
        'src/diff/types.ts',     // type-only message/DTO definitions
        'src/extension.ts',      // pure wiring after Step 5 — excluded per plan
        'src/ports/**',          // type-only interfaces
      ],
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
    },
  },
});
