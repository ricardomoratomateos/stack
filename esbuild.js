const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');

// The two Node programs the desktop app bundles (desktop/src-tauri/tauri.conf.json).
// The desktop UI itself is built by Vite from source (desktop/vite.config.ts).

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

const stackdConfig = {
  entryPoints: ['src/daemon/main.ts'],
  bundle: true,
  outfile: 'dist/stackd.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: !isWatch,
  // Reported in its snapshot; the desktop app, built from the same package.json, compares.
  define: { 'process.env.STACKD_VERSION': JSON.stringify(require('./package.json').version) },
};

async function build() {
  const configs = [bridgeConfig, stackdConfig];
  if (isWatch) {
    const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    await Promise.all(configs.map((c) => esbuild.build(c)));
    console.log('Build complete.');
  }
}

build().catch(() => process.exit(1));
