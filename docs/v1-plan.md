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
- [x] **T3b · Extension as `stackd` client.** The extension starts (or
  connects to) `stackd` and reads state / sends commands through its API
  instead of owning the store and hooks; terminals stay VS Code-side
  (attach via `attachTarget`). Keep a migration path for existing users
  (first run imports their Memento state). Done when sidebar, review,
  new task and the manager MCP work as before on top of `stackd`.

**Checkpoint A** — user reviews before Phase 1.

## Phase 1 — Desktop prototype (Tauri v2 + xterm.js)

- [x] **T4 · tmux control-mode client.** `desktop/` with a Tauri v2 app
  (`desktop/src-tauri`) and a Rust crate `tmux-cc` in the same cargo
  workspace: spawn `tmux -CC` on a given `-L` socket, parse
  `%begin/%end/%error`, `%output`, `%extended-output`, `%window-add/close`,
  `%layout-change`, `%exit`; send commands; enable `pause-after` flow
  control. Tests over recorded fixtures plus one against an isolated tmux.
- [x] **T5 · Terminals in the webview.** One xterm.js (WebGL addon) per pane,
  fed from `tmux-cc` `%output` through Tauri events; keystrokes back via
  `send-keys -H`; resize → `refresh-client -C`. Bounded scrollback
  (~2000 lines), older history via `capture-pane` on demand. Manager strip
  = last N lines of the Manager pane's xterm buffer.
- [x] **T6 · Full layout.** React UI reusing `src/webview` pieces where
  possible: worktree sidebar with every session (state from `stackd`
  `/state` + `/events` over its Unix socket, proxied by the Rust side),
  active session in the centre, Manager column. Clicking a session shows it.
- [x] **T7 · Measure.** 8 live sessions, one flooding logs; record RSS/CPU of
  the app, its webview and `stackd` here.

**Checkpoint B** — GPUI or Tauri; then plan windows (Full/Half/Float),
notifications, shortcuts.

## T7 results

Release build, macOS (Apple silicon-class Mac, WKWebView), isolated stackd + `tmux -L stackbench`, 8 worktrees each with a fake bash agent (idle loop), sampled every 2 s (CPU % from CPU-time deltas, 100 = one core; RSS summed per group). Phases: 30 s idle, 60 s flood (`yes <160-char base64 line>`, ~unthrottled) in the last worktree (hidden), 60 s flood in the first worktree (the one the app shows by default; the GUI was not clicked). Rerun: `desktop/bench/run.sh [idle_s] [flood_s]`.

| scenario | process | RSS MB min/avg/max | CPU % min/avg/max |
|---|---|---|---|
| a idle (8 sessions) | app | 101/101/101 | 0/0/0 |
| a idle (8 sessions) | webcontent | 84/84/85 | 0/0/1 |
| a idle (8 sessions) | gpu | 44/44/44 | 0/0/0 |
| a idle (8 sessions) | networking | 16/16/16 | 0/0/0 |
| a idle (8 sessions) | stackd | 61/62/63 | 1/1/2 |
| a idle (8 sessions) | tmux-server | 4/4/4 | 0/0/1 |
| a idle (8 sessions) | tmux-clients | 8/8/8 | 0/0/0 |
| b flood (hidden pane) | app | 101/101/101 | 0/0/0 |
| b flood (hidden pane) | webcontent | 85/86/87 | 0/0/0 |
| b flood (hidden pane) | gpu | 44/44/44 | 0/0/0 |
| b flood (hidden pane) | networking | 16/16/16 | 0/0/0 |
| b flood (hidden pane) | stackd | 63/64/65 | 0/1/2 |
| b flood (hidden pane) | tmux-server | 4/6/6 | 81/85/93 |
| b flood (hidden pane) | tmux-clients | 8/8/8 | 0/0/0 |
| c flood (visible pane) | app | 101/102/102 | 61/77/82 |
| c flood (visible pane) | webcontent | 86/164/170 | 92/99/104 |
| c flood (visible pane) | gpu | 44/48/48 | 4/5/5 |
| c flood (visible pane) | networking | 16/16/16 | 0/0/0 |
| c flood (visible pane) | stackd | 65/65/66 | 1/1/2 |
| c flood (visible pane) | tmux-server | 6/7/7 | 56/70/73 |
| c flood (visible pane) | tmux-clients | 8/8/8 | 0/0/0 |

Interpretation:
- Idle with 8 sessions is cheap: ~100 MB app + ~85 MB WebContent + ~45 MB GPU + ~62 MB stackd, all ~0 % CPU.
- Hidden flood: pause-after works. App, WebContent, GPU and stackd stay at 0-1 % CPU and flat RSS; only the tmux server burns CPU (~85 %, one core) because it still reads the pty (and the flooder `yes` itself); that cost is tmux's, not the UI's.
- Visible flood is where base64-over-events shows: app (Rust: parse, base64, emit) ~77 % and WebContent (xterm.js parse + WebGL) ~99 % of a core, i.e. the webview main thread saturates at this output rate, and its RSS grows 85 -> ~165 MB (event queue + scrollback). Fine for agent TUIs, a bottleneck only for raw log floods; the flow control (pause/continue) is what keeps it from running away.
- stackd and the GPU process are irrelevant to the cost (<= 5 %). Not measured: output throughput (lines/s) or latency while flooded; footprint/vmmap only printed for the app at the end.
- Helper processes are found as new `com.apple.WebKit.*` processes after the app starts, so other WebKit apps launched mid-run would be miscounted.

## Phase 2 — Daily driver

- [ ] **T8 · Output path.** Pane output over a Tauri `Channel` as raw bytes
  (no base64 JSON), coalesced per pane and written to xterm once per
  animation frame. Rerun `desktop/bench/run.sh`; add the numbers to T7 results.
- [ ] **T9 · Parity gaps.** New-task dialog uses the extension's real
  new-task panel (`src/newtask/webview`) the same way the sidebar is reused,
  with the base-branch picker wired to stackd; PR / ticket / port links open
  in the default browser; default-provider picker and provider install hint
  work. The review/diff panel is out of scope (not needed).
- [ ] **T10 · Window modes.** Full / Half / Float switch (title-bar control +
  ⌘⇧F). Half: snap to left/right half of the current screen, narrow sidebar,
  Manager as a bottom strip with its last N lines (setting, default 6) + an
  input line; ⌘⇧M expands it. Float: always-on-top window (non-activating
  NSPanel on macOS), compact worktree list with Allow on the one that needs
  you, session area, Manager strip always visible. Same state everywhere.
- [ ] **T11 · Notifications, tray, global shortcuts.** No Apple Developer
  account yet: ad-hoc signed app, native notifications WITHOUT action
  buttons (click → app focuses that session), best-effort with a fallback;
  Allow lives in the app (Float list, menu-bar menu). Notifications for
  "needs you" (grouped within 5 s, never for the
  session on screen, re-notify at 2 and 10 min); menu-bar item with counts;
  global ⌃⌥⌘J (next needing you), ⌃⌥⌘M (Manager), ⌃⌥⌘S (show Stack).
- [ ] **T12 · Packaging.** Ad-hoc signed `.app` (Developer ID + notification
  actions later, when there is an account), `stackd` bundled and run as a
  launchd user agent; the extension defaults `stack.useDaemon` to true when
  a daemon is present.

## Decisions log

- 2026-11-11 · Rust UI + tmux control mode; no forks of tmux or agent TUIs;
  current TS core kept as `stackd`.
- 2026-11-11 · State ownership: option 1 — `stackd` owns state and hooks; the extension becomes a client (T3b).
- 2026-11-11 · T3 API: HTTP over a Unix socket (`<configDir>/stackd.sock`, 0600 in a 0700 dir, so no token); SSE (`GET /events`, `event: state` with the full snapshot, debounced 25 ms) rather than WebSocket; commands are `POST /commands/<name>` with JSON bodies, answers `{ok, result|error}`.
- 2026-11-11 · T3 hooks: no change to `HookRoutes`/`discovery`; `stackd` uses `<configDir>` as the storage path, so hook scripts read its `routes/` and `hook-url`, and the MCP bridge finds it through `<configDir>/windows/<pid>.json` (the daemon is one "window" for all repos; tool calls are routed to a repo with `resolveWindow`). The agents' global hooks point at whoever installed them last: extension and `stackd` must not run on the same repo at once until T3b.
- 2026-11-11 · T3 composition: one `WorktreeApplicationService` per repo over a `HeadlessHost` (in-memory workspace folders, scripts to the log) with no-op tab/breakpoint managers; per-repo selection keys are prefixed `repo:<path>:` in `state.json`. `TmuxManager` takes an optional `-L` socket (`STACKD_TMUX_SOCKET`).
- 2026-11-11 · T3 import: first start copies the extension's `stack.*` keys (read-only from VS Code's sqlite) into `state.json`, never overwriting, once (`stackd.imported`). `respondPermission` in v1: `answer` allow = Enter, deny = Escape, or explicit `keys`. `attachTarget` returns the `tmux [-L sock] attach -t =<session>` argv and selects the window.

- 2026-11-11 · Desktop UI: Tauri v2 + xterm.js for now (GPUI later if needed); `tmux-cc` stays a standalone Rust crate.
- 2026-11-11 · T3b switch: client mode is behind `stack.useDaemon` (default `false` on `v1`, reload to apply); the old in-process path is untouched and falls out of `buildLocal()`, both build a `Backend` that the shared UI code (sidebar, panels, commands, attention, settings, image drop, MCP registration) uses. If the daemon cannot start, the window warns and runs in-process.
- 2026-11-11 · T3b service surface: `RemoteService` (vscode-free, `src/daemon/client/`) mirrors the part of `WorktreeApplicationService` the UI calls; prompts, confirms, terminal tabs, workspace folders and the window's selection stay client-side, everything else is a daemon command. The selection is per window (workspaceState `stack.activeWorktreeId`), not in the daemon.
- 2026-11-11 · T3b starting the daemon: `spawnDaemon` runs `dist/stackd.js serve` detached with `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (VS Code's node, no PATH lookup), logs to `<configDir>/stackd.log`, `STACKD_DEFER_IMPORT=1`; two windows racing is safe (the loser fails at the socket before touching anything). `DaemonClient` reconnects the SSE stream and, through `revive`, restarts a daemon that went away.
- 2026-11-11 · T3b import ordering: a daemon started by the extension skips the sqlite import; the extension sends its live Memento (`importState`: global `stack.*` keys, plus the window's workspaceState keys stored as `repo:<path>:…`) before anything reads state, once, never overwriting (markers `stackd.imported`, `stackd.imported:<repo>`), and the daemon then loads every repo found in the imported store. A daemon started by the CLI still imports from sqlite at start, as in T3.
- 2026-11-11 · T3b settings: VS Code settings the user set explicitly (not defaults) are pushed with `setSettings` and sit between `settings.json` (wins) and `.stack/config.json` in `NodeConfig`; daemon-wide, so a workspace-scoped value of one window applies to all repos for now.
- 2026-11-11 · T3b extra commands: `importState`, `setSettings`, `message` (whitelisted sidebar messages: docker, reorder, setupAction, refreshDrift, forgetWorktree), `renameTask`, `renameSession`, `initTask`, `refreshGit`, `getDiff`, `sendComments`, `paste`, `newTaskInit`. The delete confirm text is `planDelete` (shared pure function) fed by the snapshot's git/PR data.
- 2026-11-11 · T3b notifications: the daemon sends the native "needs you" notification only while no client follows `/events`; with a client the extension's `AttentionNotifier` runs on agent-state changes derived from snapshots (badge always, OS notification when the window is unfocused).
- 2026-11-11 · T3b terminals: `SessionTerminals` (unchanged) attaches to the daemon's tmux sessions; a tab opens for every session that appears after the first snapshot (manager-created tasks included) and closes when its window is gone (3 s grace for a tab just opened). Known gaps in client mode: no focus mode, no folder-scoped search exclusion, no named-workspace switch (worktree folders are just added), `-L` sockets are not used for attach (default tmux server only), setup script output goes to `stackd.log`.
- 2026-11-11 · Tests: sandboxed integration test spawns the built `dist/stackd.js` (own config dir, `-L` tmux socket, temp home); `test/helpers/tmuxSocket.ts` removes the socket file under `/tmp/tmux-<uid>/` that `kill-server` leaves behind (fixes the stale `stackd-test-*` files).
- 2026-11-11 · T4 layout: `desktop/` is a cargo workspace (`tmux-cc`, `src-tauri`) with its own `package.json` (Vite + React + Tauri CLI); root builds ignore it (`.vscodeignore`, `.gitignore`; root tsconfig/vitest/esbuild only look at `src/`, `test/`). `src-tauri` is a blank window for now.
- 2026-11-11 · T4 transport: spawn `tmux -L <sock> -C` over pipes, not `-CC` (`-CC` fails with `tcgetattr` without a tty; same protocol minus the DCS wrapper). New session or `attach-session`, optional `pause-after=N` on connect.
- 2026-11-11 · T4 API: `tmux_cc::protocol` is a pure byte-level `Parser` (blocks swallow `%` lines until their `%end`/`%error`; `%output` and `%extended-output` octal-unescaped; unknown notifications kept as `Other`); `Client::connect` returns a cloneable handle and an `mpsc` stream of `Event` (`Notification` | `Closed`). `command()` replies are paired FIFO; blocks with flags 0 (tmux's own attach block) are ignored. Helpers: `run`, `resize`, `send_bytes` (`send-keys -H`), `continue_pane`, `set_pause_after`, `detach`.
- 2026-11-11 · T4 fixtures: `tests/fixtures/session.raw` is real output from an isolated `tmux -L` server (3.7c); `pause.raw` is hand-written (a real `%pause` needs a client slower than the pane). The integration test uses a unique `-L` socket and removes its file under `/tmp/tmux-<uid>/`.
- 2026-11-11 · T5 bridge: `connect(socket?, session, create?)` attaches with `pause-after=1`; tmux notifications become Tauri events `tmux://output` (`{pane, data: base64}`), `tmux://layout` (re-list panes) and `tmux://exit`. Commands: `connect`, `disconnect`, `list_panes` (`list-panes -s`), `set_visible`, `write` (bytes -> `send-keys -H`), `resize`, `capture`. Pure logic in `src-tauri/src/bridge.rs` (`Flow`, `parse_panes`), glue in `commands.rs`; pane/window ids are validated (`%n`/`@n`) before being spliced into commands.
- 2026-11-11 · T5 flow control: the frontend reports the panes it renders or reads (`set_visible`); on `%pause` only those are auto-`continue`d, others stay paused and are resumed when they become visible. A pane that was hidden is stale: on show it is reset and refilled from `capture-pane -e -S -2000`, with live output queued until that capture is written.
- 2026-11-11 · T5 resize: `resize(pane, cols, rows)` sizes the pane's window with `refresh-client -C @win:CxR` (fallback `resize-window`); one xterm per pane, so with several windows each sets its own window size. Older history: at scroll top the terminal is reset and refilled with 1000 more lines (scrollback grows, cap 20000) since xterm cannot prepend lines.
- 2026-11-11 · T5 frontend: `desktop/src/terminals/` (`TerminalsProvider`/`useTerminals`, `PaneTerminal`, `ManagerStrip`, `TerminalRegistry`, `PaneBook`, `lastLines`); xterm is created lazily, attached to the DOM + WebGL addon only while shown (DOM renderer if WebGL fails), scrollback 2000. The Manager strip reads a headless xterm (not opened) for its pane. `DevPage.tsx` is the throwaway dev UI; vitest lives in `desktop/` (`npm test`). Checked: `tauri dev` starts clean against `-L stackdev`; the GUI itself was not driven.
- 2026-11-11 · T6 stackd client: the Rust side (`src-tauri/src/stackd.rs`) speaks HTTP/1.0 + `Connection: close` over the Unix socket (no chunking, body = read to EOF; SSE = plain lines), follows `GET /events`, keeps the latest snapshot (`stackd_latest`) and emits `stackd://status` / `stackd://state`; `stackd_command(name, body)` proxies `POST /commands/<name>`. Socket = `$STACKD_CONFIG_DIR/stackd.sock`, else `~/.config/stack/stackd.sock`.
- 2026-11-11 · T6 safety: the app never starts stackd; with no socket it shows "stackd not running — start it with `node dist/stackd.js serve`, or enable stack.useDaemon in VS Code" and retries every 2 s.
- 2026-11-11 · T6 tmux: one control connection per tmux session (`connect` is idempotent per session; `disconnect(session?)`; layout/exit events carry `{session}`); `PaneOwners` routes pane-only commands to the owning connection. Pane ids are unique per tmux server, so all connections are assumed to go to the one server stackd reports (`attachTarget.socket`).
- 2026-11-11 · T6 sizing fix: T5 never fitted xterm to its element; now `@xterm/addon-fit` + a `ResizeObserver` per shown pane, and on show the pane's own window is sized explicitly (`refresh-client -C @win:CxR`) before the capture. `set_visible` from several components is now the union (it was last-writer-wins).
- 2026-11-11 · T6 UI: `desktop/src/{App,model}.ts(x)` + `ui/`; shares `derive.ts` and `composer.ts` (`slugify`) from the extension through the `@core` alias instead of copying; centre = selected session via `attachTarget` -> connect -> pane of that window index; Manager = the control session's agent window, always in the right column. New task = `createTask` with branch `slugify(text)`, title/description = the text. Shell rows show `pane_current_command` when that session is connected, else the window name. `DevPage` removed.
- 2026-11-11 · T6 shortcuts (physical keys, capture phase so they beat the focused terminal): ⌘1..9, ⌘⇧[ / ⌘⇧], ⌘⇧J (attention queue, oldest first), ⌘0 focus Manager (reopens it if hidden), ⌘⇧M toggle. The GUI was not driven here (only `tauri dev` starting clean against an isolated stackd + `tmux -L`); `cargo test live -- --ignored` checks the client against a real stackd.
- 2026-11-11 · Desktop sidebar = the extension's own webview: `SidebarHost` renders `@core/webview/App` unchanged (CSS from the new shared `src/webview/css.ts`, codicons via `@codicons`), with `acquireVsCodeApi` shimmed (`sidebar/shim.ts`); the T6 hand-made `Sidebar` is gone.
- 2026-11-11 · Desktop message seam: `sidebar/bridge.ts` (pure, tested) builds the `{type:'state'}` payload from stackd's snapshot (+ app selection as `activeWorktreeId`, style) and turns each `WebMessage` into stackd commands (`spawnAgent`/`spawnShell`/`killWindow`/`renameTask`/`renameSession`/`deleteTask` with the extension's `planDelete` text/`initTask`/`createTask`/`message` for docker, drift, setup, reorder, forget), app actions (select, in-app dialogs) or "not yet in desktop" (review panel, opening PR/ticket/port links, default-provider picker, provider install).
- 2026-11-11 · Desktop theme: `desktop/scripts/gen-vscode-theme.mjs` writes `src/theme/vscode-theme.css` (`--vscode-*` for Dark Modern + font vars + the webview default stylesheet, all read from the local VS Code install: theme + `include`s, `registerColor` defaults of workbench.desktop.main.js, `contributes.colors` of built-in extensions); `--theme/--kind` regenerate for another theme. Chrome (tabs, Manager header, dialogs) and xterm (`terminal.*`, editor font, size 14) use the same variables; centre terminals use editor.background, Manager sideBar.background.
- 2026-11-11 · Desktop `stack.sidebarStyle` comes from the user's VS Code `settings.json` (Tauri `vscode_settings`, JSONC), else `aside`. Dev page: `/?dev=sidebar[&style=claude|mission][&width=]` renders the sidebar on a fixed sample state (`sidebar/fixtures.ts`).
- 2026-11-11 · Sidebar in the app is the extension's own webview (`src/webview`) + generated VS Code theme variables; shared CSS fixes apply to both.
- 2026-11-11 · No Apple Developer account: ad-hoc signing; notifications without action buttons for now.
