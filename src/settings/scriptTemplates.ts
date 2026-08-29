/**
 * Starter scripts written by the settings panel's "Create one for me". They
 * exist to show the contract (which variables arrive, where you are) rather than
 * to do anything: every command is commented out and the user keeps what applies.
 */
export const SCRIPT_TEMPLATES: Record<'setup' | 'teardown', string> = {
  setup: `#!/usr/bin/env bash
# Runs after Unmess creates a worktree, from inside it.
#
# Available:
#   UNMESS_REPO_ROOT        the main checkout
#   UNMESS_WORKTREE_PATH    this worktree
#   UNMESS_BRANCH           its branch
#   UNMESS_COMPOSE_PROJECT  the docker compose project name Unmess uses for it
#   HTTP_PORT, DB_PORT…     one variable per port configured in Unmess settings
set -euo pipefail
cd "$UNMESS_WORKTREE_PATH"

# Keep what applies:
# cp "$UNMESS_REPO_ROOT/.env" .env
# npm install
# composer install
`,
  teardown: `#!/usr/bin/env bash
# Runs before Unmess deletes a worktree, from inside it. Same variables as setup.
set -euo pipefail
cd "$UNMESS_WORKTREE_PATH"

# Keep what applies:
# docker compose -p "$UNMESS_COMPOSE_PROJECT" down -v
`,
};
