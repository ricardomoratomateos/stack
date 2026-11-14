# Stack

[![CI](https://github.com/ricardomoratomateos/stack/actions/workflows/ci.yml/badge.svg)](https://github.com/ricardomoratomateos/stack/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

Stack runs AI coding agents (Claude Code, opencode) in parallel, one task per git worktree, each agent in its own tmux session, and shows you which one needs you.

It has two parts:

- **stackd**, a background process per user (`dist/stackd.js`). It owns the tasks, receives the agents' hooks, serves the MCP tools and a local API on `~/.config/stack/stackd.sock`. Agents run in tmux, not in stackd, so they keep working when stackd or the app restarts.
- **Stack.app**, the macOS desktop app (`desktop/`). It shows tasks, agent terminals, the Manager, notifications and a menu-bar item. It starts stackd when it opens.

## Requirements

- macOS 12 or later
- [tmux](https://github.com/tmux/tmux) (`brew install tmux`)
- Node 20 or later (stackd runs on your own Node)
- git, and [Rust](https://rustup.rs) to build the app
- At least one agent CLI on your login shell's `PATH`: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) or [opencode](https://opencode.ai) (`opencode`)

## Install and run from a clone

```sh
git clone https://github.com/ricardomoratomateos/stack.git && cd stack
npm install && npm --prefix desktop install
npm --prefix desktop run bundle          # builds dist/ (stackd, MCP bridge) and Stack.app
cp -R desktop/target/release/bundle/macos/Stack.app /Applications/
```

The first open needs right-click, then **Open** (the app is ad-hoc signed). Rust, dev mode, logs and troubleshooting are covered in [desktop/README.md](desktop/README.md).

You can also run stackd without the app: `node dist/stackd.js serve`. `node dist/stackd.js status [repo]` prints a repo's tasks, and `node dist/stackd.js doctor` runs the [diagnostics](#diagnostics).

## Daily loop

1. **Add repository** (repository picker in the sidebar), then **+ New task**. Give it a name and a description, pick the base branch and the agent. Stack creates the branch and worktree, runs your setup script, and starts the agent with your description.
2. Watch the sidebar. Each task is in one of these groups: *working*, *needs you* (a permission prompt or a question, with the command shown), *ready for review*, or *idle*. `⌘⇧J` jumps to the next task that needs you.
3. Answer in the agent's terminal, or click **Allow** in the Float list or the menu-bar menu. Allow only sends the answer while that exact prompt is still on the agent's screen.
4. Open **Review** on a finished task. Leave comments on lines, then **Send to agent**.
5. Merge the PR as usual, then delete the task. Stack first lists anything you would lose (uncommitted files, unpushed commits).
6. After a reboot, a task whose tmux session is gone shows **Resume**, which reopens the agent's conversation.

## Manager agent (MCP)

stackd provides an MCP server with these tools: `stack_status`, `stack_create_task`, `stack_delete_task`, `stack_send_to_agent`, `stack_read_agent`, `stack_wait`, and for workers `stack_env` and `stack_request_review`. With them, one Claude Code session can turn tickets into tasks, follow the tasks, and answer their agents. The app's Manager is a standing session that already has these tools. Every Claude Code worker that Stack starts gets them for its own task.

To use the tools from any Claude Code session, go to **Settings → "Stack tools in Claude Code" → Register**. This registers `~/.config/stack/stack-mcp.js` at user scope with the node that stackd runs on. It also installs the `stack-manager` skill and the `/stack`, `/stack-task`, `/stack-task-remove` and `/stack-next` commands into `~/.claude`, and it only overwrites files that Stack wrote. If the registration points at another copy, the row says so. Then start a new Claude Code session. To remove it, run `claude mcp remove --scope user stack`.

## Configuration

Your own settings are in `~/.config/stack/settings.json` (Settings in the app, `⌘,`). Keys are written without the `stack.` prefix, though the prefix is also accepted. The project settings below can also be set in a committed `.stack/config.json`, so that everyone who clones the repo gets them. Precedence is: your explicit setting, then the repo file, then the default.

| Setting | Default | Description |
|---|---|---|
| `worktreesDirectory` | `.worktrees` | Where worktrees are created (relative to the repository root) |
| `defaultBaseBranch` | `develop` | Branch new tasks start from. If it doesn't exist, Stack uses the first of `main`/`master`/`develop` it finds, then the current branch |
| `defaultProvider` | `claude` | The agent that new tasks start |
| `claudeCommand` / `opencodeCommand` | `claude` / `opencode` | Command that launches each agent |
| `promptPrefix` | `""` | Text prepended to every agent's first prompt (personal, not for `.stack/config.json`) |
| `notifyOnAttention` | `true` | Native notification when an agent finishes or asks for permission |
| `setupScript` / `teardownScript` | `""` | Script run when a task's worktree is created / before it is deleted. Gets `STACK_REPO_ROOT`, `STACK_WORKTREE_PATH`, `STACK_BRANCH` and the task's ports |
| `setupInTerminal` | `false` | Run the setup script in a terminal you can type into, and start the agent without waiting for it |
| `ports` / `basePort` / `portStride` | `[]` / `20000` / `100` | Env var names to allocate a port per worktree for (e.g. `HTTP_PORT`), from a block of `portStride` ports per worktree starting at `basePort` |
| `debugBasePort` / `debugTemplate` | `9898` / node attach | Debug port per worktree and the `launch.json` template written into each one (`{{PORT}}`, `{{WORKTREE_PATH}}`) |

### Code tab

The Code tab browses a task's worktree read-only. PHP navigation uses [Phpactor](https://phpactor.readthedocs.io): each repository gets one index of its base branch, built in the background and kept in `~/.config/stack/cache`. A task clones that index and re-indexes only the PHP files it changed. JS/TS uses a syntactic index plus `git grep`, and diagnostics come from oxlint and `php -l`. Nothing is written inside a repository.

| Setting | Default | Description |
|---|---|---|
| `phpNavigation` | `true` | PHP navigation and the base index. Off: PHP files are only shown |
| `phpIndexDirs` | `[]` | Directories (or files) Phpactor indexes, e.g. `["lib", "www"]`. Empty: every top-level directory with tracked PHP |
| `phpExcludeDirs` | `["vendor", "node_modules"]` | Directories never indexed (`vendor`, `lib/legacy`). `.git` and the worktrees directory are always excluded. Vendor classes are still found through Composer's class maps |
| `phpExtensions` | `["php"]` | PHP file extensions (`php`, `phtml`, `inc`) |
| `phpAutoloader` | `vendor/autoload.php` | Composer's autoloader, relative to the worktree, falling back to the main checkout's |
| `phpBaseBranch` | `""` | Branch the index is built from. Empty: `defaultBaseBranch` |
| `phpMaxChangedFiles` | `6000` | Past this many PHP files differing from the base, a task is indexed on its own, in full |
| `phpactorOptions` | `{}` | Extra Phpactor settings (`.phpactor.json` keys). They can't turn on anything that writes into the worktree |
| `scriptExcludeDirs` | `["node_modules", "dist", "build", "coverage", "vendor"]` | Skipped by the JS/TS index: a name is skipped anywhere, a path (`apps/legacy`) only at that path |
| `oxlintConfig` | `""` | The repo's oxlint config, relative to the worktree. Empty: Stack's correctness-only rules |
| `phpBaseOnStart` | `true` | *(yours)* Build the base index when stackd starts. Off: the first Code tab builds it |
| `codeIdleMinutes` | `10` | *(yours)* An unused language server is stopped after this many minutes |
| `phpactorPath` / `oxlintPath` / `phpPath` | `""` / `""` / `php` | *(yours)* Where the tools are. Empty: on `PATH`, then `~/.config/stack/tools` |

Changes apply on the next Code tab start. Changing `phpIndexDirs`, `phpExcludeDirs` or `phpExtensions` rebuilds the base index.

`.stack/config.json` accepts the project keys only: `worktreesDirectory`, `defaultBaseBranch`, `setupScript`, `setupInTerminal`, `teardownScript`, `ports`, `basePort`, `portStride`, `debugBasePort`, `debugTemplate`, and the Code tab's settings that aren't marked *(yours)*. If the file has bad JSON, an unknown key or a wrong type, Stack falls back to your own settings and tells you what is wrong.

**Codex CLI is no longer supported.** A `codexCommand` setting is ignored, and a `defaultProvider` of `codex` falls back to Claude. stackd removes the hook entries earlier versions added to `~/.codex/hooks.json` when it starts, and leaves the rest of that file as it is.

## Diagnostics

**Settings → Diagnostics** checks the following:

- tmux is installed, and its version
- Node is 20 or later
- stackd's version matches the app's
- stackd's socket answers
- the hooks of every installed agent are in place, with no hook left over from the VS Code extension
- the MCP registration
- `claude` and `opencode` are on `PATH`

**Copy** gives you the results as plain text you can paste into an issue. From a terminal, `node dist/stackd.js doctor` prints the same results. It asks the running stackd, or runs the checks itself when stackd isn't running, and exits with 1 if any check fails.

## Migrating from the VS Code extension

1. Uninstall the Stack extension from VS Code.
2. Open Stack.app. Your tasks are imported once from the extension's state. The hooks that the extension wrote to `~/.claude/settings.json` are replaced automatically (and removed from `~/.codex/hooks.json`).
3. Register the MCP again: **Settings → "Stack tools in Claude Code" → Register**. The old registration points at the extension's copy.
4. The `docker` config block is ignored. Its `ports`/`basePort`/`portStride` moved to top-level keys; the old values are still read when the new keys are unset.

## License

[MIT](LICENSE) © Ricardo Morato
