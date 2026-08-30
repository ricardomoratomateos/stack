# Changelog

All notable changes to Foreman are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-08-30

First release.

### Added

- **Worktree manager** in the sidebar — create, rename, and delete git worktrees, branching off a configurable base (`foreman.defaultBaseBranch`, default `develop`) rather than whatever the main checkout happens to be parked on. The Explorer's root folder is labelled by its branch, like the sidebar, instead of by the directory name.
- **AI agents per worktree** — launch Claude Code, Codex CLI or opencode (pluggable providers); multiple agent and shell sessions per worktree, each tracked separately. The card's split button starts your primary agent and its chevron opens an in-sidebar menu for the others, dimming any whose command is not on `PATH`.
- **tmux-backed sessions** that survive VS Code window reloads and reconnect automatically. If tmux is missing, the Worktrees view says so and installs it in one click.
- **New agent panel** — a full editor page, not a modal squeezed into the sidebar: title, base branch, and room to write the task. It opens on its own when a repository window has no tabs open. Creating a worktree selects it the way clicking its card would, its terminal appears at once so the agent's boot is watched rather than waited out, and the first prompt is pasted whole and submitted only once the agent's own `SessionStart` hook says it is listening — never through the shell, so `${...}` and backticks survive intact.
- **State at a glance** — per-session status with live task titles, a sidebar attention badge, and an optional native notification when an agent needs you.
- **Active-worktree scoping** for text search, Quick Open, and breakpoints — plus editor tabs and terminals via the opt-in `foreman.focusMode`.
- **Instant worktree switching** — switching reveals the target worktree's agent terminal without tearing down tabs or terminals, so there is no flicker and VS Code keeps your tab order. `foreman.focusMode` restores the clean-slate behaviour (close and reopen everything) for those who prefer it.
- **Diff review panel** comparing against the branch the worktree was actually cut from, with per-line comments fed straight back to the agent.
- **Screenshots go where you drop them.** Drop an image onto an agent's terminal and Foreman hands it to that agent — the one you dropped on, not merely the active one — leaving images you opened on purpose alone; a toast offers "Open instead". `Cmd+Alt+V` in the agent's terminal attaches the latest screenshot from your screenshots folder.
- **Settings panel** behind the gear beside **+**: one editor page for everything Foreman can be told. The project half (worktree folder, base branch, setup/teardown scripts, a Docker stack per worktree, a debugger per worktree) saves to `.foreman/config.json`; the personal half (primary agent and its commands, notifications, focus mode, search scoping) saves to your own VS Code settings. It prefills from the repository — compose files and the `${HTTP_PORT}`-style variables inside them, the language stack for a debugger preset (Node, PHP/Xdebug, Python, Go) — offers native file pickers, writes starter scripts on request, reads the saved file back through the same validator the extension uses, and says when your own settings.json overrides the file for this repo.
- **Per-worktree debugging** — a `launch.json` generated per worktree on a unique debug port, from a template you control; any debugger VS Code supports, Node by default.
- **Per-worktree Docker** orchestration with auto-generated, collision-free ports (opt-in). Ports are validated by binding them, so a slot is only handed out when the whole block is actually free on the machine, and checked again just before a stack comes up; a worktree whose port was taken in the meantime moves to a free slot instead of failing inside `docker compose`. Each card lists the ports it owns, clickable to open `http://localhost:<port>`.
- **Per-worktree setup/teardown scripts** with `FOREMAN_*` environment variables.
- **Committable repo configuration** — `.foreman/config.json` carries the settings that describe the project so a teammate who clones the repo inherits a working setup. Precedence is your own explicit setting, then the repo file, then the shipped default; per-user settings such as which agent you prefer are refused rather than silently applied.
- **Drift against the base branch** — each card shows how far its branch has fallen behind the one it was cut from (`origin/develop ↓12`), a different question from ahead/behind against your own upstream. Foreman never fetches on its own; it names which ref it compared against and fetches only when you click the row.
- **Renameable sessions** and **shell sessions that say what they are running** (`npm`, `vim`, `psql`), read from tmux.
- **A Get started walkthrough** (opens on install; later under Help → Welcome, or `Foreman: Getting Started`), and a one-time offer, per repository, to set up Docker and debugging when Foreman first sees a compose file or a PHP stack.

[Unreleased]: https://github.com/ricardomoratomateos/foreman/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ricardomoratomateos/foreman/releases/tag/v0.1.0
