# Changelog

All notable changes to Unmess are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

Initial public release.

### Added

- **Worktree manager** in the sidebar — create, rename, and delete git worktrees.
- **AI agents per worktree** — launch Claude Code or opencode (pluggable providers); multiple agent and shell sessions per worktree, each tracked separately.
- **tmux-backed sessions** that survive VS Code window reloads and reconnect automatically.
- **State at a glance** — per-session status with live task titles, a sidebar attention badge, and an optional native notification when an agent needs you.
- **Active-worktree scoping** for text search, Quick Open, and breakpoints — plus editor tabs and terminals via the opt-in `unmess.focusMode`.
- **Instant worktree switching** — switching reveals the target worktree's agent terminal without tearing down tabs or terminals, so there is no flicker and VS Code keeps your tab order. `unmess.focusMode` restores the clean-slate behaviour (close and reopen everything) for those who prefer it.
- **Diff review panel** with per-line comments fed back to the agent.
- **Per-worktree debugging** — a `launch.json` generated per worktree on a unique debug port, wired to its container.
- **Per-worktree Docker** orchestration with auto-generated, collision-free ports (opt-in).
- **Per-worktree setup/teardown scripts** with `UNMESS_*` environment variables.

[0.1.0]: https://github.com/ricardomoratomateos/unmess/releases/tag/v0.1.0
