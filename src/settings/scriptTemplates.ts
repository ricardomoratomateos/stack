/**
 * Starter scripts written by the settings panel's "Create one for me". They
 * exist to show the contract (which variables arrive, where you are) rather than
 * to do anything: every command is commented out and the user keeps what applies.
 */
export const SCRIPT_TEMPLATES: Record<'setup' | 'teardown', string> = {
  setup: `#!/usr/bin/env bash
# Runs after Foreman creates a worktree, from inside it.
#
# Available:
#   FOREMAN_REPO_ROOT        the main checkout
#   FOREMAN_WORKTREE_PATH    this worktree
#   FOREMAN_BRANCH           its branch
#   FOREMAN_COMPOSE_PROJECT  the docker compose project name Foreman uses for it
#   HTTP_PORT, DB_PORT…     one variable per port configured in Foreman settings
set -euo pipefail
cd "$FOREMAN_WORKTREE_PATH"

# Keep what applies:
# cp "$FOREMAN_REPO_ROOT/.env" .env
# npm install
# composer install
`,
  teardown: `#!/usr/bin/env bash
# Runs before Foreman deletes a worktree, from inside it. Same variables as setup.
set -euo pipefail
cd "$FOREMAN_WORKTREE_PATH"

# Keep what applies:
# docker compose -p "$FOREMAN_COMPOSE_PROJECT" down -v
`,
};
