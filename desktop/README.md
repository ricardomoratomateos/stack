# Stack desktop

A native macOS window for Stack: worktrees, agent terminals, a Manager strip, notifications, a menu-bar item. It is a client of `stackd` (the Stack core without VS Code); the VS Code extension talks to the same daemon.

## Build

Needs Rust (`. "$HOME/.cargo/env"`), Node 20+ and tmux.

```sh
cd desktop
npm install
npm run bundle     # compiles ../dist/stackd.js, then `tauri build`
```

Output, under `desktop/target/release/bundle/`: `macos/Stack.app` and `dmg/Stack_<version>_<arch>.dmg`. The app is ad-hoc signed (no Developer ID yet), bundle id `dev.stack.desktop`.

## Install

1. Drag `Stack.app` (or the one in the dmg) to `/Applications`.
2. First open: right-click, **Open**, then **Open** again. macOS refuses a double-click on an ad-hoc signed app the first time. If it still says "damaged": `xattr -dr com.apple.quarantine /Applications/Stack.app`.

## stackd

The app never starts the daemon by itself. With no daemon running it shows two buttons:

- **Start stackd now**: one detached run, until you log out or reboot.
- **Start stackd at login**: installs a launchd user agent (`~/Library/LaunchAgents/dev.stack.stackd.plist`, runs at login, restarts after a crash, log in `~/.config/stack/stackd.log`). The same switch is in the menu-bar menu; turning it off unloads and removes the agent.

stackd runs on your own Node (it is not bundled yet): `STACK_NODE`, else your login shell's `node`, else `~/.nvm`, else Homebrew. The path found is stored in the plist; switch it off and on again after changing Node. Its PATH is your login shell's, so tmux, git and the agent CLIs are found.

With a daemon running, the VS Code extension (`stack.useDaemon` unset) becomes its client too, after a reload; set it to `false` to keep VS Code standalone.

## Shortcuts

In the window: `⌘1`..`⌘9` select a session, `⌘⇧[` / `⌘⇧]` previous/next, `⌘⇧J` next needing you, `⌘0` focus the Manager, `⌘⇧M` expand/collapse it, `⌘⇧F` cycle window mode.

Global (anywhere): `⌃⌥⌘J` next needing you, `⌃⌥⌘M` Manager, `⌃⌥⌘S` show/hide Stack.

## Window modes

- **Full**: sidebar, session area and Manager.
- **Half**: snaps to the left/right half of the screen, narrow sidebar, the Manager as a bottom strip with its last lines.
- **Float**: always-on-top compact list; Allow a permission prompt straight from it.

Notifications ("needs you") have no action buttons for now (no Developer ID): clicking one focuses that session; Allow lives in the Float list and the menu-bar menu.
