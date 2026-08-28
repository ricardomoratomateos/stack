# Changelog

All notable changes to Unmess are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

Initial public release.

### Added

- **Worktree manager** in the sidebar — create, rename, and delete git worktrees, branching off a configurable base (`unmess.defaultBaseBranch`, default `develop`) rather than whatever the main checkout happens to be parked on.
- **AI agents per worktree** — launch Claude Code, Codex CLI, Grok Build or opencode (pluggable providers); multiple agent and shell sessions per worktree, each tracked separately. The card's split button starts your primary agent and its chevron opens an in-sidebar menu for the others, dimming any whose command is not on `PATH`.
- **tmux-backed sessions** that survive VS Code window reloads and reconnect automatically.
- **State at a glance** — per-session status with live task titles, a sidebar attention badge, and an optional native notification when an agent needs you.
- **Active-worktree scoping** for text search, Quick Open, and breakpoints — plus editor tabs and terminals via the opt-in `unmess.focusMode`.
- **Instant worktree switching** — switching reveals the target worktree's agent terminal without tearing down tabs or terminals, so there is no flicker and VS Code keeps your tab order. `unmess.focusMode` restores the clean-slate behaviour (close and reopen everything) for those who prefer it.
- **Diff review panel** with per-line comments fed back to the agent.
- **Per-worktree debugging** — a `launch.json` generated per worktree on a unique debug port, wired to its container.
- **Per-worktree Docker** orchestration with auto-generated ports (opt-in). Ports are validated by binding them, so a slot is only handed out when the whole block is actually free on the machine — not merely unused by Unmess. The check runs again just before a stack comes up, and a worktree whose port was taken in the meantime moves to a free slot instead of failing minutes later inside `docker compose`.
- **Per-worktree setup/teardown scripts** with `UNMESS_*` environment variables.
- **Drift against the base branch** — each card shows how far its branch has fallen behind the one it was cut from (`origin/develop ↓12`), which is a different question from ahead/behind against your own upstream. The base is recorded at creation, so it survives the setting changing later. Unmess never fetches on its own: it compares against `origin/<base>` when the ref exists and the local branch otherwise, names which it used, and fetches only when you click the row.
- **Renameable sessions** — name any agent or shell row from the card (the shell running redis becomes "redis"). The name is stored by Unmess and survives reloads; it is dropped when its window is, since tmux reuses window indexes.
- **Shell sessions say what they are running** — a shell row shows its current process (`npm`, `vim`, `psql`) under its name, the way an agent row shows its live task. Read from tmux, so no shell configuration is involved; idle shells stay quiet.
- **Ports on the card** — each worktree lists the ports it owns under Docker, clickable to open `http://localhost:<port>`. Derived from the same function that builds the compose environment, so the card cannot disagree with what the container publishes; visible while the stack is down, which is when you need it.
- **Committable repo configuration** — a `.unmess/config.json` carries the settings that describe the project (worktree location, base branch, setup scripts, compose files, port ranges) so a teammate who clones the repo inherits a working setup instead of a paste of someone else's `settings.json`. **Unmess: Create Repo Config File** generates it from what is currently in effect. Precedence is your own explicit setting, then the repo file, then the shipped default; per-user settings such as which agent you prefer are refused rather than silently applied.

[0.1.0]: https://github.com/ricardomoratomateos/unmess/releases/tag/v0.1.0
