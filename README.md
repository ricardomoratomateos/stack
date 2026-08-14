# Unmess

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/unmess.unmess?label=marketplace&color=c8ff00)](https://marketplace.visualstudio.com/items?itemName=unmess.unmess)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/unmess.unmess?color=c8ff00)](https://marketplace.visualstudio.com/items?itemName=unmess.unmess)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/unmess.unmess)](https://marketplace.visualstudio.com/items?itemName=unmess.unmess&ssr=false#review-details)
[![CI](https://github.com/ricardomoratomateos/unmess/actions/workflows/ci.yml/badge.svg)](https://github.com/ricardomoratomateos/unmess/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

**Run multiple AI coding agents in parallel — each in its own git worktree, its own tmux session, its own environment — without the mess.**

Unmess turns VS Code into a control panel for delegated work: spin up a git worktree per task, launch an AI coding agent (Claude Code, opencode, …) in it, and keep every session alive, isolated, and glanceable from one sidebar.

<!-- TODO: add a demo GIF here before publishing — e.g. ![Unmess](assets/demo.gif) -->

## Why

Working on several things at once with AI agents gets messy fast: branches collide, terminals get lost on reload, you don't know which agent is waiting on you. Unmess gives each task a real git worktree and a persistent tmux-backed session, and surfaces their state so you always know what needs you.

## Features

- **Worktree manager in the sidebar** — create, rename, and delete git worktrees; each one is an isolated checkout you can work in independently.
- **Agents per worktree** — launch Claude Code or opencode (pluggable providers) in any worktree. Multiple agent + shell sessions per worktree, each tracked separately.
- **Sessions survive reloads** — agents run in tmux, so they keep working across VS Code window reloads and reconnect automatically.
- **State at a glance** — per-session status (working / waiting / needs permission / idle) with live task titles pulled from the agent, plus a sidebar badge and optional native notification when an agent needs you.
- **Scoped to the active worktree** — text search, Quick Open, and breakpoints are automatically scoped to the worktree you're in, so parallel worktrees don't drown each other out. Editor tabs can be scoped too — see [Switching worktrees](#switching-worktrees).
- **Diff review panel** — review a worktree's changes with per-line comments and feed them straight back to the agent, no PR round-trip needed.
- **Per-worktree debugging** *(optional)* — each worktree gets its own `launch.json` on a unique debug port, wired to its container, so you can step-debug several worktrees at once without ports colliding.
- **Per-worktree Docker** *(optional)* — start/stop a dedicated compose stack per worktree with auto-generated, collision-free ports.
- **Per-worktree setup/teardown** *(optional)* — run a repo-local script when a worktree is created or removed (install deps, copy env, boot services).

## Requirements

- **VS Code** 1.85 or newer
- **[tmux](https://github.com/tmux/tmux)** — sessions are multiplexed and survive reloads through it (Unmess prompts to install it if missing)
- **git** with worktree support
- An **agent CLI** on your `PATH` — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) and/or [opencode](https://opencode.ai) (`opencode`)

> **Platform:** macOS and Linux. Native OS notifications are macOS-only; everything else works on both. Windows is supported only via WSL (tmux required).

## Getting started

1. Install tmux and an agent CLI (`claude` or `opencode`).
2. Open a git repository in VS Code and open the **Unmess** view in the activity bar.
3. Hit **+** to create a worktree for your task.
4. Click the agent button on the worktree card to launch Claude Code / opencode in it.
5. Watch status in the sidebar; switch worktrees to jump between tasks — switching is instant, and search and breakpoints follow you.

## Settings

| Setting | Default | Description |
|---|---|---|
| `unmess.worktreesDirectory` | `.worktrees` | Where worktrees are created (relative to the workspace root) |
| `unmess.defaultBaseBranch` | `develop` | Branch new worktrees start from, preselected in the New Task form. Falls back to the main repo's current branch when this branch doesn't exist |
| `unmess.defaultProvider` | `claude` | Primary agent: the one the big launch button starts. The chevron beside it opens the rest |
| `unmess.claudeCommand` | `claude` | Command to launch Claude Code |
| `unmess.codexCommand` | `codex` | Command to launch Codex CLI |
| `unmess.grokCommand` | `grok` | Command to launch Grok Build |
| `unmess.opencodeCommand` | `opencode` | Command to launch opencode |
| `unmess.notifyOnAttention` | `true` | Native OS notification when an agent finishes or asks for permission while VS Code is backgrounded (the sidebar badge always shows) |
| `unmess.scopeSearchToActiveWorktree` | `true` | Hide non-active worktree folders from search and Quick Open |
| `unmess.focusMode` | `false` | Clean-slate switching: close the other worktrees' editor tabs and agent terminals so only the active worktree is on screen (see [Switching worktrees](#switching-worktrees)) |
| `unmess.setupScript` / `unmess.teardownScript` | `""` | Script run on worktree create / delete (e.g. `.unmess/setup.sh`) |
| `unmess.docker` | — | Per-worktree compose file + auto-generated ports (opt-in; see below) |
| `unmess.xdebugBasePort` | `9898` | First debug port; each worktree takes the next free slot above it |
| `unmess.debugTemplate` | php/xdebug | `launch.json` template generated per worktree (`{{PORT}}`, `{{WORKTREE_PATH}}`) |

## Agents

Four are supported: **Claude Code**, **Codex CLI**, **Grok Build** and **opencode**. Each worktree card carries a split button — the big half launches your primary agent (`unmess.defaultProvider`), the chevron opens the rest. Agents whose command isn't on your `PATH` are shown dimmed; clicking one offers the install command instead of launching it.

Unmess registers a notify hook with each agent so the sidebar can show live state (thinking / waiting / needs attention). Two caveats worth knowing:

- **Codex's hook system is experimental and off by default.** Unmess writes the hooks, but Codex ignores them — silently, so its sessions simply never change state — until you enable the feature yourself in `~/.codex/config.toml`:

  ```toml
  [features]
  codex_hooks = true
  ```

  Codex also has no session-end event, so a Codex session settles on *waiting* rather than ever showing *terminated*.
- **Codex and Grok require you to trust hooks** before they run (`/hooks` and `/hooks-trust` respectively). Unmess's notify script is byte-identical on every install for exactly this reason — the endpoint lives in a sibling file, so a restart never changes the script's hash and never costs you that trust.

Grok has no permission-request event; its `Notification` event is what drives the attention badge instead.

## Switching worktrees

Clicking a worktree in the sidebar switches to it. There are two behaviours, trading screen tidiness against churn.

**Reveal (default).** Switching brings the worktree's agent terminal to the front and re-applies search scoping and explorer dimming. Nothing is closed or recreated, so switching is instant and flicker-free, and VS Code keeps your editor tabs exactly where you left them. No file is opened for you — that kept the terminal and the editor fighting over the foreground. The cost: tabs and agent terminals from the worktrees you've visited stay open.

**Focus mode** (`"unmess.focusMode": true`). Switching gives you a clean slate: the other worktrees' editor tabs are closed and their agent terminals detached, so only the active worktree is on screen. Each worktree's open files are remembered and reopened, in order, when you come back to it. The cost: visible churn on every switch, since tabs and a terminal really are torn down and rebuilt. Unsaved work is saved first, because tabs are about to close.

> Neither mode ever interrupts an agent: agents run in tmux, so detaching a terminal leaves them working. Only deleting a worktree or killing a session explicitly stops one.

## Per-repo configuration

For heavier setups (dedicated Docker stack, dependency prep, debug), point the `unmess.setupScript` / `unmess.teardownScript` and `unmess.docker` settings at your own script and compose files — **anywhere in the repo**, wherever you like to keep them.

When it runs your setup script, Unmess exports `UNMESS_REPO_ROOT`, `UNMESS_WORKTREE_PATH`, `UNMESS_BRANCH`, `UNMESS_COMPOSE_PROJECT` and the worktree's auto-generated ports, and the matching debug port is wired into the generated `launch.json`. Relative paths resolve against the worktree first, then the main repo.

Ports are checked against the machine, not just against Unmess's own bookkeeping: every port a worktree will bind is probed before the slot is handed out, and probed again right before a setup script or `compose up` runs. If something has taken one in the meantime — another project's container, a leftover stack from a deleted worktree, a local dev server — the worktree moves to a free slot, its `launch.json` follows, and you get a toast naming the port that was busy. Re-run your setup script afterwards if it bakes the port into a generated file such as `.env`.

> Tip: a `.unmess/` folder is a handy place to keep these together, but it's just a convention — no folder is required.

## License

[MIT](LICENSE) © Ricardo Morato
