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
- Before committing: `npm run compile`, `npm test` and `npm run lint` pass
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
- [ ] **T2 · `stackd` entry point.** `src/daemon/main.ts` composes the core
  (WorktreeApplicationService, TmuxManager, HookServer, MCP tools, GitWatcher,
  Docker) with Node adapters (JSON store, `OsaNotifyAdapter`, settings from
  `~/.config/stack/settings.json` + `.stack/config.json`). Build target in
  `esbuild.js` → `dist/stackd.js`. CLI: `node dist/stackd.js status [repo]`
  prints worktrees, sessions and states. Done when it runs outside VS Code
  and its output matches the sidebar for the same repo.
- [ ] **T3 · `stackd` API.** Local socket (Unix socket or localhost HTTP
  with a token, like HookServer): `GET /state`, an event stream (SSE or
  WebSocket) of state changes, and commands: `createTask`, `deleteTask`,
  `spawnAgent`, `spawnShell`, `killWindow`, `sendToAgent`,
  `respondPermission` (v1: `sendKeys` to the pane), `attachTarget`
  (returns tmux session/window). Integration tests against a real tmux.
  Decide (and write down here) how extension and `stackd` avoid both
  claiming the same worktrees' hook routes.

**Checkpoint A** — user reviews before Phase 1.

## Phase 1 — Rust prototype to measure

- [ ] **T4 · tmux control-mode client.** `desktop/` cargo workspace, crate
  `tmux-cc`: spawn `tmux -CC attach`/`new`, parse `%begin/%end/%error`,
  `%output`, `%extended-output`, `%window-add/close`, `%layout-change`,
  `%exit`; send commands; enable `pause-after` flow control. Tests over
  recorded fixtures.
- [ ] **T5 · Terminal engine per pane.** `alacritty_terminal::Term` fed from
  `%output`; resize; `last_lines(n)` (for the Manager strip); bounded
  scrollback (~2000 lines, older history via `capture-pane` on demand).
  Headless tests.
- [ ] **T6 · GPUI window.** One session rendered + Manager strip (last 6
  lines) + typing into the focused pane (`send-keys`). If GPUI is too
  painful, stop and report — fallback is Tauri + xterm.js with the same
  `tmux-cc` crate.
- [ ] **T7 · Measure.** 8 live sessions, one flooding logs; record RSS/CPU of
  the app and `stackd` here.

**Checkpoint B** — GPUI or Tauri; then plan windows (Full/Half/Float),
notifications, shortcuts.

## Decisions log

- 2026-11-11 · Rust UI + tmux control mode; no forks of tmux or agent TUIs;
  current TS core kept as `stackd`.
