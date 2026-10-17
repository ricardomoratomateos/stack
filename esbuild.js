const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

function copyCodeicons() {
  const src = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
  const dst = path.join(__dirname, 'dist');
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(src, 'codicon.css'), path.join(dst, 'codicon.css'));
  fs.copyFileSync(path.join(src, 'codicon.ttf'), path.join(dst, 'codicon.ttf'));
}

const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
};

const webviewConfig = {
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: !isWatch,
  jsx: 'automatic',
};

const diffPanelConfig = {
  entryPoints: ['src/diff/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/diffPanel.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: !isWatch,
  jsx: 'automatic',
};

const settingsPanelConfig = {
  entryPoints: ['src/settings/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/settingsPanel.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: !isWatch,
  jsx: 'automatic',
};

const newTaskPanelConfig = {
  entryPoints: ['src/newtask/webview/index.tsx'],
  bundle: true,
  outfile: 'dist/newTaskPanel.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  minify: !isWatch,
  jsx: 'automatic',
};

// The Stack MCP bridge: a standalone Node program (no vscode), copied into
// globalStorage at activation and run by Claude Code / Codex as an MCP server.
// node18 so whatever `node` the user has can run it; no sourcemap, since it
// ships as one file that is copied by content.
const bridgeConfig = {
  entryPoints: ['src/mcp/bridge/main.ts'],
  bundle: true,
  outfile: 'dist/stack-mcp.js',
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: false,
  minify: !isWatch,
  define: { 'process.env.STACK_MCP_VERSION': JSON.stringify(require('./package.json').version) },
};

async function build() {
  if (isWatch) {
    const [extCtx, webCtx, diffCtx, newTaskCtx, settingsCtx, bridgeCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
      esbuild.context(diffPanelConfig),
      esbuild.context(newTaskPanelConfig),
      esbuild.context(settingsPanelConfig),
      esbuild.context(bridgeConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch(), diffCtx.watch(), newTaskCtx.watch(), settingsCtx.watch(), bridgeCtx.watch()]);
    copyCodeicons();
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(diffPanelConfig),
      esbuild.build(newTaskPanelConfig),
      esbuild.build(settingsPanelConfig),
      esbuild.build(bridgeConfig),
    ]);
    copyCodeicons();
    console.log('Build complete.');
  }
}

build().catch(() => process.exit(1));
