## Heavier setups

The gear in the Worktrees header opens Foreman settings. Three optional things live there, and Foreman prefills them from what it finds in the repository:

- **Docker** — a compose stack per worktree on ports that never collide.
- **Debug** — a `launch.json` per worktree on its own port; Node, PHP, Python, Go or anything VS Code can attach to.
- **Setup / teardown scripts** — install dependencies, copy `.env`, boot services when a worktree is created or removed.
