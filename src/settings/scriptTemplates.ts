/**
 * Starter scripts written by the settings panel's "Create one for me". They
 * exist to show the contract (which variables arrive, where you are) rather than
 * to do anything: every command is commented out and the user keeps what applies.
 */
export const SCRIPT_TEMPLATES: Record<'setup' | 'teardown', string> = {
  setup: `#!/usr/bin/env bash
# Runs after Stack creates a worktree, from inside it.
#
# Available:
#   STACK_REPO_ROOT        the main checkout
#   STACK_WORKTREE_PATH    this worktree
#   STACK_BRANCH           its branch
#   STACK_COMPOSE_PROJECT  the docker compose project name Stack uses for it
#   HTTP_PORT, DB_PORT…     one variable per port configured in Stack settings
#   COMPOSE_PROJECT_NAME, COMPOSE_FILE
#                            set when Docker is configured, so a plain
#                            \`docker compose\` here addresses the same stack
#                            Stack shows on the card and stops on delete
set -euo pipefail
cd "$STACK_WORKTREE_PATH"

# Keep what applies:
# cp "$STACK_REPO_ROOT/.env" .env
# npm install
# composer install
# docker compose --project-directory "$STACK_WORKTREE_PATH" up -d
`,
  teardown: `#!/usr/bin/env bash
# Runs before Stack deletes a worktree, from inside it. Same variables as setup.
set -euo pipefail
cd "$STACK_WORKTREE_PATH"

# Keep what applies:
# docker compose down -v
`,
};
