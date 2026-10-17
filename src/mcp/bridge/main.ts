/* v8 ignore start */
import * as path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridgeServer } from './bridge';
import { STORAGE_ENV } from '../protocol';

/**
 * Entry point of dist/stack-mcp.js, which Stack copies into its globalStorage
 * — next to the `windows/` discovery files it reads. Only wiring: everything
 * it does is in bridge.ts, tested there and by the stdio integration test,
 * which runs this very file.
 */
async function main(): Promise<void> {
  const storageDir = process.env[STORAGE_ENV] || path.dirname(process.argv[1] ?? __filename);
  const server = createBridgeServer({
    storageDir,
    env: process.env,
    cwd: process.cwd(),
    version: process.env.STACK_MCP_VERSION ?? '0.0.0',
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  process.stderr.write(`stack-mcp: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
/* v8 ignore stop */
