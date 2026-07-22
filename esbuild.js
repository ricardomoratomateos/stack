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

function copyDiff2HtmlCss() {
  const src = path.join(__dirname, 'node_modules', 'diff2html', 'bundles', 'css', 'diff2html.min.css');
  const dst = path.join(__dirname, 'dist', 'diff2html.css');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
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

async function build() {
  if (isWatch) {
    const [extCtx, webCtx, diffCtx] = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(webviewConfig),
      esbuild.context(diffPanelConfig),
    ]);
    await Promise.all([extCtx.watch(), webCtx.watch(), diffCtx.watch()]);
    copyCodeicons();
    copyDiff2HtmlCss();
    console.log('Watching for changes...');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(diffPanelConfig),
    ]);
    copyCodeicons();
    copyDiff2HtmlCss();
    console.log('Build complete.');
  }
}

build().catch(() => process.exit(1));
