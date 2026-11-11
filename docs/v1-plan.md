# Stack v1 — desktop app plan

Branch: `v1`. Goal: take Stack out of VS Code into a native desktop app
(Rust, GPUI + `alacritty_terminal`, tmux in control mode), keeping the
current TypeScript core as a daemon (`stackd`). The VS Code extension must
keep working on this branch at every step.

Design: the "v1" row of the Stack layout canvas — Full (worktree sidebar +
active session + Manager column), Half (narrow sidebar + session + Manager
strip with its last N lines), Float (always-on-top window, Manager strip
always visible), native notifications with Allow / View.

## Rules for every task

- Work on branch `v1`, directly (no worktrees). One task = one commit.
- Before committing: `npm run compile`, `npm test` and `npx tsc --noEmit` pass (no ESLint config exists; `npm run lint` is not used)
  (Rust tasks: `cargo build`, `cargo test`, `cargo clippy`).
- Rust: run `. "$HOME/.cargo/env"` first; `cargo` is not on the default PATH.
- Don't change user-visible behaviour of the extension unless the task says so.
- Commit message: conventional (`refactor(core): …`, `feat(stackd): …`).
- Final report: ≤10 lines — what changed, files touched, test results,
  anything left open or decided on the way. Mark the task `[x]` below.

## Phase 0 — Core out of VS Code (TypeScript)

Files importing `vscode` today (non-webview): `adapters/VsCodeNotifyAdapter`,
`config/ConfigManager`, `diff/DiffPanelManager`, `extension`,
`newtask/NewTaskPanelManager`, `onboarding/TmuxGateView`,
`session/AgentSessionManager`, `session/AttentionNotifier`,
`session/SessionTerminals`, `settings/SettingsPanelManager`,
`sidebar/*`, `terminal/*`, `workspace/namedWorkspace`,
`worktree/BreakpointManager`, `worktree/TabManager`, `worktree/WorktreeStore`.
Panels, sidebar, terminal links, breakpoints, tabs and diff stay
VS Code-only; they are not part of the core.

- [x] **T1 · `AgentSessionManager` without `vscode`.** Split it so the
  session/state model (windows, hook events, `getSessions`, attention) lives
  in a module that does not import `vscode`: Node `EventEmitter` (or a tiny
  typed emitter) instead of `vscode.EventEmitter`; a `KeyValueStore`
  interface instead of `vscode.Memento`, with a VS Code implementation
  (wraps Memento) and a JSON-file implementation (for `stackd`). Everything
  that touches `vscode.Terminal` (attaching, revealing, tabs) moves to a
  VS Code-side wrapper/adapter (e.g. next to `SessionTerminals`). Same for
  `AttentionNotifier` and `WorktreeStore` (their `vscode` use is
  EventEmitter/Memento only). Done when: those core modules have no
  `vscode` import, compile/test/lint pass, new unit tests cover the JSON
  store, and the extension behaves the same.
- [x] **T2 · `stackd` entry point.** `src/daemon/main.ts` composes the core
  (WorktreeApplicationService, TmuxManager, HookServer, MCP tools, GitWatcher,
  Docker) with Node adapters (JSON store, `OsaNotifyAdapter`, settings from
  `~/.config/stack/settings.json` + `.stack/config.json`). Build target in
  `esbuild.js` → `dist/stackd.js`. CLI: `node dist/stackd.js status [repo]`
  prints worktrees, sessions and states. Done when it runs outside VS Code
  and its output matches the sidebar for the same repo.
- [x] **T3 · `stackd` owns state + API.** `stackd` becomes the single owner:
  `stackd serve` runs as a long-lived daemon (one per user, all repos),
  state in `~/.config/stack/state.json` (`JsonFileStore`; one-time import
  from the VS Code store read by T2), HookServer + MCP + GitWatcher started
  here, and it receives the agents' hooks (adapt `HookRoutes`/`discovery` so
  hook scripts reach `stackd`). Local API (Unix socket or localhost HTTP with
  a token, like HookServer): `GET /state`, an event stream (SSE or WebSocket)
  of state changes, commands `createTask`, `deleteTask`, `spawnAgent`,
  `spawnShell`, `killWindow`, `sendToAgent`, `respondPermission` (v1:
  `sendKeys` to the pane), `attachTarget` (returns tmux session/window).
  `stackd status` uses the API when the daemon runs. Integration tests
  against a real tmux (isolated tmux socket, `-L`). Until T3b, the extension
  and `stackd` must not run on the same repo at once (document it).
- [ ] **T3b · Extension as `stackd` client.** The extension starts (or
  connects to) `stackd` and reads state / sends commands through its API
  instead of owning the store and hooks; terminals stay VS Code-side
  (attach via `attachTarget`). Keep a migration path for existing users
  (first run imports their Memento state). Done when sidebar, review,
  new task and the manager MCP work as before on top of `stackd`.

**Checkpoint A** — user reviews before Phase 1.

## Phase 1 — Desktop prototype (Tauri v2 + xterm.js)

- [ ] **T4 · tmux control-mode client.** `desktop/` with a Tauri v2 app
  (`desktop/src-tauri`) and a Rust crate `tmux-cc` in the same cargo
  workspace: spawn `tmux -CC` on a given `-L` socket, parse
  `%begin/%end/%error`, `%output`, `%extended-output`, `%window-add/close`,
  `%layout-change`, `%exit`; send commands; enable `pause-after` flow
  control. Tests over recorded fixtures plus one against an isolated tmux.
- [ ] **T5 · Terminals in the webview.** One xterm.js (WebGL addon) per pane,
  fed from `tmux-cc` `%output` through Tauri events; keystrokes back via
  `send-keys -H`; resize → `refresh-client -C`. Bounded scrollback
  (~2000 lines), older history via `capture-pane` on demand. Manager strip
  = last N lines of the Manager pane's xterm buffer.
- [ ] **T6 · Full layout.** React UI reusing `src/webview` pieces where
  possible: worktree sidebar with every session (state from `stackd`
  `/state` + `/events` over its Unix socket, proxied by the Rust side),
  active session in the centre, Manager column. Clicking a session shows it.
- [ ] **T7 · Measure.** 8 live sessions, one flooding logs; record RSS/CPU of
  the app, its webview and `stackd` here.

**Checkpoint B** — GPUI or Tauri; then plan windows (Full/Half/Float),
notifications, shortcuts.

## Decisions log

- 2026-11-11 · Rust UI + tmux control mode; no forks of tmux or agent TUIs;
  current TS core kept as `stackd`.
- 2026-11-11 · State ownership: option 1 — `stackd` owns state and hooks; the extension becomes a client (T3b).
- 2026-11-11 · T3 API: HTTP over a Unix socket (`<configDir>/stackd.sock`, 0600 in a 0700 dir, so no token); SSE (`GET /events`, `event: state` with the full snapshot, debounced 25 ms) rather than WebSocket; commands are `POST /commands/<name>` with JSON bodies, answers `{ok, result|error}`.
- 2026-11-11 · T3 hooks: no change to `HookRoutes`/`discovery`; `stackd` uses `<configDir>` as the storage path, so hook scripts read its `routes/` and `hook-url`, and the MCP bridge finds it through `<configDir>/windows/<pid>.json` (the daemon is one "window" for all repos; tool calls are routed to a repo with `resolveWindow`). The agents' global hooks point at whoever installed them last: extension and `stackd` must not run on the same repo at once until T3b.
- 2026-11-11 · T3 composition: one `WorktreeApplicationService` per repo over a `HeadlessHost` (in-memory workspace folders, scripts to the log) with no-op tab/breakpoint managers; per-repo selection keys are prefixed `repo:<path>:` in `state.json`. `TmuxManager` takes an optional `-L` socket (`STACKD_TMUX_SOCKET`).
- 2026-11-11 · T3 import: first start copies the extension's `stack.*` keys (read-only from VS Code's sqlite) into `state.json`, never overwriting, once (`stackd.imported`). `respondPermission` in v1: `answer` allow = Enter, deny = Escape, or explicit `keys`. `attachTarget` returns the `tmux [-L sock] attach -t =<session>` argv and selects the window.

- 2026-11-11 · Desktop UI: Tauri v2 + xterm.js for now (GPUI later if needed); `tmux-cc` stays a standalone Rust crate.
