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
- **Scoped to the active worktree** — text search, Quick Open, open editor tabs, and breakpoints are automatically scoped to the worktree you're in, so parallel worktrees don't drown each other out.
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
5. Watch status in the sidebar; switch worktrees to jump between tasks — tabs, search, and breakpoints follow you.

## Settings

| Setting | Default | Description |
|---|---|---|
| `unmess.worktreesDirectory` | `.worktrees` | Where worktrees are created (relative to the workspace root) |
| `unmess.defaultProvider` | `claude` | Agent launched by the main button when none is picked |
| `unmess.claudeCommand` | `claude` | Command to launch Claude Code |
| `unmess.opencodeCommand` | `opencode` | Command to launch opencode |
| `unmess.notifyOnAttention` | `true` | Native OS notification when an agent finishes or asks for permission while VS Code is backgrounded (the sidebar badge always shows) |
| `unmess.scopeSearchToActiveWorktree` | `true` | Hide non-active worktree folders from search and Quick Open |
| `unmess.setupScript` / `unmess.teardownScript` | `""` | Script run on worktree create / delete (e.g. `.unmess/setup.sh`) |
| `unmess.docker` | — | Per-worktree compose file + auto-generated ports (opt-in; see below) |
| `unmess.debugTemplate` | php/xdebug | `launch.json` template generated per worktree (`{{PORT}}`, `{{WORKTREE_PATH}}`) |

## Per-repo configuration

For heavier setups (dedicated Docker stack, dependency prep, debug), point the `unmess.setupScript` / `unmess.teardownScript` and `unmess.docker` settings at your own script and compose files — **anywhere in the repo**, wherever you like to keep them.

When it runs your setup script, Unmess exports `UNMESS_REPO_ROOT`, `UNMESS_WORKTREE_PATH`, `UNMESS_BRANCH`, `UNMESS_COMPOSE_PROJECT` and the worktree's auto-generated ports, so parallel stacks never collide and the matching debug port is wired into the generated `launch.json`. Relative paths resolve against the worktree first, then the main repo.

> Tip: a `.unmess/` folder is a handy place to keep these together, but it's just a convention — no folder is required.

## License

[MIT](LICENSE) © Ricardo Morato
