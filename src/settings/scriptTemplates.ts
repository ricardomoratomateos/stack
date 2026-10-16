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
#   COMPOSE_PROJECT_NAME, COMPOSE_FILE
#                            set when Docker is configured, so a plain
#                            \`docker compose\` here addresses the same stack
#                            Foreman shows on the card and stops on delete
set -euo pipefail
cd "$FOREMAN_WORKTREE_PATH"

# Keep what applies:
# cp "$FOREMAN_REPO_ROOT/.env" .env
# npm install
# composer install
# docker compose --project-directory "$FOREMAN_WORKTREE_PATH" up -d
`,
  teardown: `#!/usr/bin/env bash
# Runs before Foreman deletes a worktree, from inside it. Same variables as setup.
set -euo pipefail
cd "$FOREMAN_WORKTREE_PATH"

# Keep what applies:
# docker compose down -v
`,
};
