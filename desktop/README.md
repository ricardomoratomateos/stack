# Stack desktop

A native macOS window for Stack: worktrees, agent terminals, a Manager strip, notifications, a menu-bar item. It is a client of `stackd` (the Stack core without VS Code); the VS Code extension talks to the same daemon.

## Prerequisites (fresh Mac)

- macOS 12+ (the bundle's minimum), Apple silicon or Intel.
- Xcode Command Line Tools: `xcode-select --install` (also gives you git).
- Node 20+ (stackd is built for node20; it runs on your own Node, it is not bundled).
- Rust via rustup: `curl https://sh.rustup.rs -sSf | sh`, then `. "$HOME/.cargo/env"` (cargo is not on the default PATH).
- tmux (`brew install tmux`).
- Agent CLIs on your login shell's PATH: `claude` and/or `codex`.
- Optional: the VS Code `code` CLI, only to install the `.vsix`.

## Build from a fresh clone

```sh
git clone https://github.com/ricardomoratomateos/stack.git && cd stack
git checkout v1
npm install                    # root: extension, stackd, MCP bridge
npm --prefix desktop install   # desktop: Vite/React UI + Tauri CLI
. "$HOME/.cargo/env"
```

Root `npm run compile` (esbuild.js) writes `dist/`: `extension.js`, the webview panels, `stack-mcp.js` (MCP bridge) and `stackd.js` (daemon). Use `npm run watch` while developing.

VS Code extension (optional):

```sh
npm run package                               # stack-agents-<version>.vsix in the repo root
code --install-extension stack-agents-*.vsix  # or Extensions > ... > Install from VSIX
```

### Desktop

Dev mode (hot reload; run `npm run compile` at the root first so `dist/stackd.js` exists):

```sh
cd desktop
npm run tauri dev
```

Release bundle:

```sh
cd desktop
npm run bundle     # = root `npm run compile`, then `tauri build` (first Rust build takes minutes)
```

Output under `desktop/target/release/bundle/`: `macos/Stack.app` and `dmg/Stack_<version>_<arch>.dmg`. `dist/stackd.js` and `dist/stack-mcp.js` are copied into the app (`Contents/Resources/stackd/`). The app is ad-hoc signed (no Developer ID), bundle id `dev.stack.desktop`.

Install:

```sh
cp -R desktop/target/release/bundle/macos/Stack.app /Applications/
```

First open: right-click, **Open**, then **Open** again. If macOS says "damaged": `xattr -dr com.apple.quarantine /Applications/Stack.app`.

Tests: `npm test` (root and `desktop/`); `cargo test` from `desktop/` for the Rust side.

## stackd

The app never starts the daemon by itself. With no daemon running it shows two buttons:

- **Start stackd now**: one detached run, until you log out or reboot.
- **Start stackd at login**: installs a launchd user agent (`~/Library/LaunchAgents/dev.stack.stackd.plist`, runs at login, restarts after a crash, log in `~/.config/stack/stackd.log`). The same switch is in the menu-bar menu; turning it off unloads and removes the agent.

stackd runs on your own Node (it is not bundled yet): `STACK_NODE`, else your login shell's `node`, else `~/.nvm`, else Homebrew. The path found is stored in the plist; switch it off and on again after changing Node. Its PATH is your login shell's, so tmux, git and the agent CLIs are found.

Socket: `~/.config/stack/stackd.sock` (state in `~/.config/stack/`). By hand, from the repo root: `node dist/stackd.js serve`; `node dist/stackd.js status [repo]` prints worktrees and sessions. Check the LaunchAgent with `launchctl print gui/$(id -u)/dev.stack.stackd`.

## MCP (Claude Code manager)

stackd hands the bridge (`stack-mcp.js`) to the workers it starts. To use the `stack_*` tools from your own Claude Code session, use **Settings › Stack tools in Claude Code › Register** (stackd registers its copy, `~/.config/stack/stack-mcp.js`, with the node it runs on, and installs the `/stack` skill and commands), or register the bridge yourself: `claude mcp add --scope user stack -- node ~/.config/stack/stack-mcp.js`. Then in Claude Code run `/mcp` and reconnect `stack` (or start a new session).

## Logs

- App: `~/Library/Logs/Stack/app.log`
- stackd: `~/.config/stack/stackd.log` (when started by the app or launchd)

## Shortcuts

| Key | Action |
|---|---|
| `⌃Tab` / `⌃⇧Tab` | Agent switcher (forwards / backwards) |
| `⌥⌘↓` / `⌥⌘↑` | Next / previous worktree |
| `⌘1`..`⌘9` | Select worktree N; again on the selected one cycles its session tabs |
| `⌘0` | Focus the Manager; again cycles its tabs |
| `⌥⌘←` / `⌥⌘→` | Previous / next session tab |
| `⌘⇧J` | Next worktree that needs you |
| `⌘⇧1` / `⌘⇧2` / `⌘⇧3` | Full / Half / Float |
| `⌘⇧F` | Cycle window mode |
| `⌘⇧M` | Expand / collapse the Manager |
| `⌘⇧Enter` | Maximize |
| `⌘,` | Settings |
| `⌘⇧[` / `⌘⇧]` | Previous / next |

Global (anywhere): `⌃⌥⌘J` next needing you, `⌃⌥⌘M` Manager, `⌃⌥⌘S` show/hide Stack, `⌃⌥⌘F` Float (again to hide).

## Window modes

- **Full**: sidebar, session area and Manager.
- **Half**: snaps to the left/right half of the screen, narrow sidebar, the Manager as a bottom strip with its last lines.
- **Float**: always-on-top compact list; Allow a permission prompt straight from it.

Notifications ("needs you") have no action buttons for now (no Developer ID): clicking one focuses that session; Allow lives in the Float list and the menu-bar menu.

## Troubleshooting

- **Terminal stuck on "Connecting…"**: tmux is not found or the locale is not UTF-8. Install tmux (`brew install tmux`) so it is on the PATH of your login shell, then relaunch. The app, when opened from Finder, has a bare PATH; try `open -a Stack` from a terminal where `tmux -V` works.
- **Blank terminal**: select another tab and back (or resize the window) to force a redraw; check `~/Library/Logs/Stack/app.log`.
- **No worktrees / "start stackd" buttons**: stackd is not running. Use **Start stackd now**, or `node dist/stackd.js serve` from the repo root; read `~/.config/stack/stackd.log`. "Node.js was not found" means set `STACK_NODE` or install Node 20+.
- **Stale agent paths after changing Node**: switch "Start stackd at login" off and on again (the plist stores the node path).
