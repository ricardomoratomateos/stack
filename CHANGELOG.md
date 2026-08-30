# Changelog

All notable changes to Foreman are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A settings panel.** The gear beside **+** in the Worktrees header opens one editor-area page for everything Foreman can be told: the project half (worktree folder, base branch, setup/teardown scripts, a Docker stack per worktree, a debugger per worktree) saves to `.foreman/config.json`; the personal half (primary agent and its commands, notifications, focus mode, search scoping) saves to your own VS Code settings. It prefills from the repository — compose files and the `${HTTP_PORT}`-style variables inside them, the language stack for a debugger preset (Node, PHP/Xdebug, Python, Go) — offers native file pickers, writes starter scripts on request, and reads the saved file back through the same validator the extension uses so problems show up where they were made. It also says when your own settings.json overrides the file for this repo, with a button to clear those.
- **Drop a screenshot on the agent's terminal and it reaches the agent.** Agent viewers are terminal editors, and VS Code claims file drops on the editor area — the image opened as a tab and the terminal never saw it, which is why the sidebar drop zone exists. Foreman now watches for an image tab opening, works out which agent viewer sits in that editor group, closes the tab and pastes the path into that agent — so the drop targets whichever agent you dropped on, not just the active one. Only images that look freshly captured (written in the last two minutes, or from the macOS screenshots folder) are taken, and only when an agent can receive them; a toast offers "Open instead". The sidebar's "Screenshot drop" view is gone: the drop now goes where the eye already puts it.
- **A Get started walkthrough** (opens on install; later under Help → Welcome, or `Foreman: Getting Started`) covering tmux, the first agent, switching, review, and the settings panel. Steps tick themselves as you do them.
- **A one-time offer, per repository,** to set up Docker and debugging when Foreman first sees a compose file or a PHP stack and no `.foreman/config.json`.
- **Creating a worktree selects it,** the way clicking its card would: search, Quick Open and breakpoints scope to it at once, and in focus mode the others clear out. And the first prompt reaches the agent as soon as it is up: Foreman detected the agent through tmux's `pane_current_command`, which never changes for a command a shell launched, so every launch sat out a 10-second timeout and then pasted the prompt unsent. It now looks at the pane's child processes, and then holds the prompt until the agent's own first hook event (SessionStart) says it is listening — before that a paste sits in the tty's line buffer and a multi-line prompt submits line by line. The agent's terminal also appears before that wait, so the seconds an agent takes to boot are watched instead of spent looking at nothing.
- **The New agent form is a full editor panel** instead of a modal squeezed into the sidebar, and opens on its own when a repo window has no tabs open.
- **Missing tmux is a panel, not a toast.** The Worktrees view states the requirement and installs it in one click; the extension used to abort silently behind a notification that vanished.
- **The Explorer's root folder is labelled by its branch,** like the sidebar, instead of by the directory name.

### Fixed

- **A prompt with `${...}` or backticks in it no longer reaches the shell.** The initial prompt was passed as an argument on the launch line, and tmux runs that line through `sh -c` — so `${user.id}` aborted the whole command and the agent never started, and backticks were run as command substitution and *silently removed the text they wrapped*. That second one had a guaranteed victim: review comments quote the line they are about in backticks, so "send to a new agent" from the review panel delivered every comment with its code missing, with nothing to show anything had gone wrong. Prompts are now pasted into the agent once it owns the pane, the same route the review panel already used for a live agent. If the agent never starts, the text is left sitting there unsent rather than submitted to the shell underneath.
- **The review panel compares against the branch the worktree was actually cut from.** It resolved the base to the first of `main`/`master`/`develop` that existed, ignoring the base recorded on the worktree — so a worktree cut from `release/3.2` in a repo that also has `main` showed every commit `release/3.2` carries over `main` mixed in with the handful written in the worktree, while the card beside it measured drift against the right branch. The recorded base is tried first now, with the old candidates behind it so a base branch deleted since still resolves.

### Changed

- **The per-worktree debugger stopped calling itself Xdebug.** Nothing about it was ever PHP-specific — the port is a slot number and `debugTemplate` is handed to VS Code whole — but every name around it said otherwise: `foreman.xdebugBasePort`, `XDEBUG_PORT`, and a template that shipped `"type": "php"`. Anyone whose stack was not PHP read that as "not for me" and skipped the one thing no other worktree tool does. The setting is now `foreman.debugBasePort`, the docker env var is `DEBUG_PORT`, and the default template attaches to Node. Xdebug is documented as one example among others.

  **Breaking.** Rename `foreman.xdebugBasePort` to `foreman.debugBasePort` in your settings and in `.foreman/config.json` — the old key is now reported as unknown rather than read. Rename `XDEBUG_PORT` to `DEBUG_PORT` in `foreman.docker.ports` and in whatever compose file consumes it. Worktrees created by an earlier build carry the old field in the extension's store and will show no debug port until they are recreated.

## [0.1.3] — 2026-08-28

### Changed

- **New icon.** Three threads enter tangled, cross once, and leave as parallel lines — the product's name, drawn. It replaces a letter "U", which said nothing about what the extension does and competed with every other extension starting with the same letter. The marketplace icon carries the same mark on the existing lime.

## [0.1.2] — 2026-08-28

### Fixed

- **The last two places the global store leaked through.** The tab and breakpoint managers were still handed every worktree the extension had seen. Both attribute an open file to a worktree by path prefix, so a file opened in another project's worktree was saved under that worktree's id — from a window that does not manage it, into state that project's own window then restores. Both are now scoped like everything else.
- **Paths compare the same way everywhere.** `path.normalize` keeps a trailing separator, so "/repo/" and "/repo" were unequal — and these paths arrive from three sources that disagree about it: git's output, the workspace folder list, and a hand-written config file. A mismatch showed up as a window silently listing nothing. One canonical form now, shared by the sidebar filter, the workspace-folder pruning and the worktree reconciler.

## [0.1.1] — 2026-08-28

### Fixed

- **One window, one repository.** The sidebar listed every worktree the extension had ever seen, in every window: the worktree store is global, and nothing filtered it. Invisible while only one project was ever open, so installing 0.1.0 and opening a second repository beside the first was what surfaced it — the second repo's checkout arrived at the top of the first one's list as "main". The list is now scoped to the repository open in the window, along with explorer dimming, next/previous cycling, search scoping, drag-and-drop, and the worktree a palette command falls back to. A window with no repository shows nothing rather than everything.
- **The explorer, the watchers and the pollers are scoped too.** `loadWorktreesForRepo` used the whole store for the workspace folders it adds, the git watches, and the docker and PR polling — so a window opened on one project filled its explorer with another's worktrees and ran a file watcher, a `docker compose ps` loop and a `gh` call for each of them. Removal was narrowed at the same time: Foreman now takes back only folders it is responsible for, and leaves anything it does not recognise, or another repository's checkout, where the user put it.
- **Reconciling one repository no longer rewrites another's entries.** `reconcile` decided `isMain` for every worktree in the store from whether its path matched the root it was called with, so opening a second repo concluded the first one's checkout had stopped being a main worktree and demoted it out of the top slot — in that repo's own window.

## [0.1.0] — 2026-08-28

Initial public release.

### Added

- **Worktree manager** in the sidebar — create, rename, and delete git worktrees, branching off a configurable base (`foreman.defaultBaseBranch`, default `develop`) rather than whatever the main checkout happens to be parked on.
- **AI agents per worktree** — launch Claude Code, Codex CLI or opencode (pluggable providers); multiple agent and shell sessions per worktree, each tracked separately. The card's split button starts your primary agent and its chevron opens an in-sidebar menu for the others, dimming any whose command is not on `PATH`.
- **tmux-backed sessions** that survive VS Code window reloads and reconnect automatically.
- **State at a glance** — per-session status with live task titles, a sidebar attention badge, and an optional native notification when an agent needs you.
- **Active-worktree scoping** for text search, Quick Open, and breakpoints — plus editor tabs and terminals via the opt-in `foreman.focusMode`.
- **Instant worktree switching** — switching reveals the target worktree's agent terminal without tearing down tabs or terminals, so there is no flicker and VS Code keeps your tab order. `foreman.focusMode` restores the clean-slate behaviour (close and reopen everything) for those who prefer it.
- **Diff review panel** with per-line comments fed back to the agent.
- **Per-worktree debugging** — a `launch.json` generated per worktree on a unique debug port, wired to its container.
- **Per-worktree Docker** orchestration with auto-generated ports (opt-in). Ports are validated by binding them, so a slot is only handed out when the whole block is actually free on the machine — not merely unused by Foreman. The check runs again just before a stack comes up, and a worktree whose port was taken in the meantime moves to a free slot instead of failing minutes later inside `docker compose`.
- **Per-worktree setup/teardown scripts** with `FOREMAN_*` environment variables.
- **Drift against the base branch** — each card shows how far its branch has fallen behind the one it was cut from (`origin/develop ↓12`), which is a different question from ahead/behind against your own upstream. The base is recorded at creation, so it survives the setting changing later. Foreman never fetches on its own: it compares against `origin/<base>` when the ref exists and the local branch otherwise, names which it used, and fetches only when you click the row.
- **Renameable sessions** — name any agent or shell row from the card (the shell running redis becomes "redis"). The name is stored by Foreman and survives reloads; it is dropped when its window is, since tmux reuses window indexes.
- **Shell sessions say what they are running** — a shell row shows its current process (`npm`, `vim`, `psql`) under its name, the way an agent row shows its live task. Read from tmux, so no shell configuration is involved; idle shells stay quiet.
- **Ports on the card** — each worktree lists the ports it owns under Docker, clickable to open `http://localhost:<port>`. Derived from the same function that builds the compose environment, so the card cannot disagree with what the container publishes; visible while the stack is down, which is when you need it.
- **Committable repo configuration** — a `.foreman/config.json` carries the settings that describe the project (worktree location, base branch, setup scripts, compose files, port ranges) so a teammate who clones the repo inherits a working setup instead of a paste of someone else's `settings.json`. **Foreman: Create Repo Config File** generates it from what is currently in effect. Precedence is your own explicit setting, then the repo file, then the shipped default; per-user settings such as which agent you prefer are refused rather than silently applied.

[0.1.3]: https://github.com/ricardomoratomateos/foreman/releases/tag/v0.1.3
[0.1.2]: https://github.com/ricardomoratomateos/foreman/releases/tag/v0.1.2
[0.1.1]: https://github.com/ricardomoratomateos/foreman/releases/tag/v0.1.1
[0.1.0]: https://github.com/ricardomoratomateos/foreman/releases/tag/v0.1.0
