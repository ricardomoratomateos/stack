# Stack

[![CI](https://github.com/ricardomoratomateos/foreman/actions/workflows/ci.yml/badge.svg)](https://github.com/ricardomoratomateos/foreman/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)

**Run multiple AI coding agents in parallel — each in its own git worktree, its own tmux session, its own environment — without the mess.**

Stack turns VS Code into a control panel for delegated work: spin up a git worktree per task, launch an AI coding agent (Claude Code, Codex CLI, opencode) in it, and keep every session alive, isolated, and glanceable from one sidebar.

> **Stack was called Foreman.** Coming from Foreman? See [Upgrading from Foreman](#upgrading-from-foreman) — your settings, worktrees and running agents come along.

![Stack: a worktree per task, an agent in each, and a sidebar that says who needs you](assets/demo.gif)

## Why

Working on several things at once with AI agents gets messy fast: branches collide, terminals get lost on reload, you don't know which agent is waiting on you. Stack gives each task a real git worktree and a persistent tmux-backed session, and surfaces their state so you always know what needs you.

## Features

- **Worktree manager in the sidebar** — create, rename, and delete git worktrees; each one is an isolated checkout you can work in independently.
- **Agents per worktree** — launch Claude Code, Codex CLI or opencode (pluggable providers) in any worktree. Multiple agent + shell sessions per worktree, each tracked separately.
- **Sessions survive reloads** — agents run in tmux, so they keep working across VS Code window reloads and reconnect automatically.
- **State at a glance** — per-session status (working / needs you / ready for review / idle) with live task titles pulled from the agent. When an agent asks for something, its question is the row's line (`$ composer test`); `Cmd+Alt+J` jumps to the next worktree that needs you — its terminal when an agent is asking, its Review panel when one has finished. A sidebar badge and an optional native notification tell you when you're elsewhere.
- **Three sidebar styles** — *aside* (monochrome, one lime accent), *claude* (terracotta, a prompt-style composer) and *mission* (state counters that filter, an attention queue, cards). Same worktrees and actions in each; pick one in Stack settings › Appearance. Worktrees keep the order you give them (drag to reorder) — they never jump around as agents change state.
- **New task composer** — name the task, describe it, pick the base branch and the agent; the branch is generated from the name (`AS-1234-fix-payments`) and checked as you type. It creates the worktree, waits for the setup script, then starts the agent with your description.
- **A tab per session** — every agent and shell gets its own terminal tab, so you can drag them side by side, split and resize like any editor; see [Sessions side by side](#sessions-side-by-side).
- **PRs and cleanup** — the row shows the branch's PR (open, draft, merged) with a CI dot, and opens it on click. Deleting tells you first what would be lost (uncommitted files, unpushed commits); a merged, clean worktree gets a one-click **Clean up**. A worktree whose folder disappeared shows as *Missing* with a **Forget** button — Stack never deletes one on its own.
- **Scoped to the active worktree** — text search, Quick Open, and breakpoints are automatically scoped to the worktree you're in, so parallel worktrees don't drown each other out. Editor tabs can be scoped too — see [Switching worktrees](#switching-worktrees).
- **Diff review panel** — review a worktree's changes in your theme's diff colours, with a folder tree, a *Viewed* checkbox per file, inline or split view, wrap toggle and keyboard navigation; leave per-line comments and send them straight back to the agent, no PR round-trip needed.
- **Per-worktree debugging** *(optional)* — each worktree gets its own `launch.json` on a unique debug port, wired to its container, so you can step-debug several worktrees at once without ports colliding. Any debugger VS Code supports — Node by default, PHP, Python, Go, whatever your stack runs.
- **Per-worktree Docker** *(optional)* — start/stop a dedicated compose stack per worktree with auto-generated, collision-free ports.
- **Per-worktree setup/teardown** *(optional)* — run a repo-local script when a worktree is created or removed (install deps, copy env, boot services).
- **Manager agent (MCP)** *(optional)* — let a Claude Code session (the VS Code panel included) create Stack tasks from your tickets, watch them and talk to their agents. See [Manager agent (MCP)](#manager-agent-mcp).

## Requirements

- **VS Code** 1.85 or newer
- **[tmux](https://github.com/tmux/tmux)** — sessions are multiplexed and survive reloads through it (Stack prompts to install it if missing)
- **git** with worktree support
- An **agent CLI** on your `PATH` — [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`), [Codex CLI](https://github.com/openai/codex) (`codex`) and/or [opencode](https://opencode.ai) (`opencode`)

> **Platform:** macOS and Linux. Native OS notifications are macOS-only; everything else works on both. Windows is supported only via WSL (tmux required).

## Getting started

1. Install tmux and an agent CLI (`claude`, `codex` or `opencode`).
2. Open a git repository in VS Code and open the **Stack** view in the activity bar.
3. Hit **+** (or the *What should an agent build?* box) and describe the task: Stack creates the branch and worktree and starts the agent on it.
4. More agents or a shell for the same worktree: the agent button on its card (the chevron picks another agent) and the terminal icon.
5. Watch status in the sidebar; switch worktrees to jump between tasks — switching is instant, and search and breakpoints follow you.

The **Get started with Stack** walkthrough (opens on install; later under *Help → Welcome → Walkthroughs*, or `Stack: Getting Started`) walks through the same steps inside VS Code.

Each worktree joins the window as a folder, and the window is named after the project — **aside (Workspace)**, not *Untitled (Workspace)*. The `.code-workspace` file behind it lives in the repository's `.git/stack/` — inside the folder you already trust (so the window never opens in Restricted Mode) and invisible to git; a window that is already untitled is offered the name once, or any time with **Stack: Name This Workspace**.

To hand an agent a screenshot, drop the image straight onto its terminal — VS Code opens it as a tab, Stack closes that tab and attaches the file to the agent in that editor group. `Cmd+Alt+V` in the agent's terminal attaches the latest screenshot from your screenshots folder.

For the heavier setup — Docker per worktree, a debugger port per worktree, setup/teardown scripts — open **Stack settings** with the gear next to **+** in the Worktrees header. It prefills what it finds in the repository (compose files, their `${HTTP_PORT}`-style ports, the language stack) and saves the project half to `.stack/config.json` so the whole team inherits it, and your own preferences to your VS Code settings.

## Shortcuts and commands

| Shortcut / command | What it does |
|---|---|
| `Cmd+Alt+J` · **Stack: Focus Next Worktree Needing Attention** | Jump to the worktree that has waited longest for you |
| **Stack: Focus Next / Previous Worktree** | Walk the worktrees in sidebar order |
| `Cmd+Alt+V` (in an agent's terminal) · **Stack: Attach Latest Screenshot to Agent** | Hand the agent your latest screenshot |
| Alt-click a session row · **Stack: Open Session to the Side** | Put that session's tab beside the current editor |
| **Stack: New Task** | The new task composer |
| **Stack: Settings** | The settings panel (also the gear in the view header) |
| **Stack: Name This Workspace** | Name an "Untitled (Workspace)" window after the project |
| **Stack: Create Repo Config File** | Write your current setup to `.stack/config.json` for the team |
| In the Review panel: `j`/`k` files, `n`/`p` hunks, `c` comment, `v` viewed, `/` filter, `⌘↵` send | |

## Settings

| Setting | Default | Description |
|---|---|---|
| `stack.worktreesDirectory` | `.worktrees` | Where worktrees are created (relative to the workspace root) |
| `stack.defaultBaseBranch` | `develop` | Branch new worktrees start from, preselected in the New Task form. When it doesn't exist, Stack uses the repo's own main line (first of `main`/`master`/`develop` it finds, local or remote), then the current branch |
| `stack.defaultProvider` | `claude` | Primary agent: the one the big launch button starts. The chevron beside it opens the rest |
| `stack.sidebarStyle` | `aside` | How the sidebar looks: `aside` (monochrome, one lime accent), `claude` (terracotta, a prompt-style composer) or `mission` (state counters, attention queue, cards). Switches live; also under **Stack: Switch Sidebar Style** and in the settings panel |
| `stack.claudeCommand` | `claude` | Command to launch Claude Code |
| `stack.codexCommand` | `codex` | Command to launch Codex CLI |
| `stack.opencodeCommand` | `opencode` | Command to launch opencode |
| `stack.notifyOnAttention` | `true` | Native OS notification, with a chime on macOS, when an agent finishes or asks for permission while VS Code is backgrounded (the sidebar badge always shows) |
| `stack.scopeSearchToActiveWorktree` | `true` | Hide non-active worktree folders from search and Quick Open |
| `stack.sessionTabs` | `perSession` | `perSession`: every session opens in its own terminal tab, so an agent and a shell can sit side by side (see [Sessions side by side](#sessions-side-by-side)). `single`: one terminal per worktree that switches between them, as before |
| `stack.focusMode` | `false` | Clean-slate switching: close the other worktrees' editor tabs and agent terminals so only the active worktree is on screen (see [Switching worktrees](#switching-worktrees)) |
| `stack.setupScript` / `stack.teardownScript` | `""` | Script run on worktree create / delete (e.g. `.stack/setup.sh`) |
| `stack.setupInTerminal` | `false` | Run the setup script in a terminal you can type into, without holding the agent back — for scripts that ask questions |
| `stack.docker` | — | Per-worktree compose file + auto-generated ports (opt-in; see below) |
| `stack.debugBasePort` | `9898` | First debug port; each worktree takes the next free slot above it |
| `stack.debugTemplate` | node attach | `launch.json` template generated per worktree (`{{PORT}}`, `{{WORKTREE_PATH}}`); any debugger, see [Debugging](#per-worktree-debugging) |

## Agents

Three are supported: **Claude Code**, **Codex CLI** and **opencode**. Each worktree card carries a split button — the big half launches your primary agent (`stack.defaultProvider`), the chevron opens the rest. Agents whose command isn't on your `PATH` are shown dimmed; clicking one offers the install command instead of launching it.

Any session can be renamed — hover its row and hit the pencil. The shell you started redis in becomes "redis". The name is Stack's own; the tmux window keeps the name that says what is running in it, because that is what identifies an agent when the window reloads. Clearing the name restores the derived one.

### Sessions side by side

Each session — agent or shell — opens in a terminal tab of its own, titled `<worktree> · <session>`. They are ordinary editor tabs: drag one into another editor group to have Claude and a shell open at once, drag the divider to resize, reorder them; VS Code keeps the layout. Clicking a session in the sidebar brings its tab forward (or reopens it), **Stack: Open Session to the Side** moves the focused one beside the active group, and killing a session closes its tab. Closing a tab only hides the session — it keeps running in tmux, and clicking its row brings it back.

Under the hood each tab attaches to a small tmux session of its own that holds just that window, which is what lets two tabs of one worktree show different sessions instead of mirroring each other. These carry the worktree's session name plus `__w<N>`; they disappear with their tab and are swept up on reload. Set `"stack.sessionTabs": "single"` for the previous layout: one terminal per worktree, switching between sessions with tmux's status bar.

Shell sessions carry a subtitle too, in the same slot the agents use for their live task: whatever the shell is running right now — `npm`, `vim`, `psql`, `docker`. A shell sitting at its prompt says nothing rather than repeating its own name. It needs no shell configuration; the reading comes from tmux itself.

Stack registers a notify hook with each agent so the sidebar can show live state (thinking / waiting / needs attention). Two caveats worth knowing:

- **Codex's hook system is experimental and off by default.** Stack writes the hooks, but Codex ignores them — silently, so its sessions simply never change state — until you enable the feature yourself in `~/.codex/config.toml`:

  ```toml
  [features]
  codex_hooks = true
  ```

  Codex also has no session-end event, so a Codex session settles on *waiting* rather than ever showing *terminated*.
- **Codex requires you to trust hooks** before they run (`/hooks`). Stack's notify script is byte-identical on every install for exactly this reason — it looks up which window to report to when it runs, so a restart never changes the script's hash and never costs you that trust. (Upgrading from Foreman changes the script and where it lives once; Codex asks to trust it again.)

The hooks are global — one entry in `~/.claude/settings.json` serves every VS Code window — but each agent reports to the window showing its worktree, so several windows can run side by side, and an agent keeps reporting across a window reload. With no Stack window open the hook does nothing and exits at once. Stack never rewrites an agent config it cannot parse: it leaves the file alone and says so, and the first time it changes one it keeps the original as `<file>.stack-backup`.


## Manager agent (MCP)

Stack ships an MCP server, so one agent can run the others. The intended setup: the official Claude Code panel in VS Code as the *manager*, with your company's Jira / Slack / Linear MCP servers, and Stack's tools to turn tickets into tasks, follow them, and answer their questions.

**Enable it:** switch on **Stack tools in Claude Code** in Stack settings › General (or run **Stack: Enable Manager (MCP)**). It also installs a `stack-manager` skill and three slash commands into `~/.claude` — `/stack` (how are my agents), `/stack-task <ticket or idea>`, `/stack-next` — so you can just ask in plain words; switching it off removes them (only files Stack wrote, never your own). It registers the server with Claude Code at user scope (`claude mcp add --scope user stack -- node <globalStorage>/stack-mcp.js`, replacing an earlier `stack` entry). Start a new Claude Code session and the `stack_*` tools are there. **Stack: Disable Manager (MCP)** removes it. Where VS Code supports it, Copilot's agent mode sees the same server under *Stack*.

Then ask, for example:

- *"Lee AS-1234 en Jira y crea una tarea en Stack para ella."*
- *"Create Stack tasks for every ticket assigned to me in the current sprint, one per ticket, with Claude."*
- *"Wait until any of those tasks needs me or finishes, then tell me what it asked."*
- *"Tell the AS-1234 agent to add a test for the empty cart, and post a summary in #payments when it asks for review."*

| Tool | What it does |
|---|---|
| `stack_status` | Every task: id, name, branch, base, group (needs you / review / working / idle / missing), sessions with state and pending question, diff `+N −M`, PR and CI, ports, ticket |
| `stack_create_task` | New branch + worktree + agent on a prompt. With a `ticket`, the branch is `<KEY>-<slug>`, the ticket shows as a chip beside the task's name, and its text reaches the worker fenced as reference data. Idempotent per ticket key |
| `stack_send_to_agent` | Types a message into a task's running agent and submits it (the same path the Review panel uses); refused when no agent is running. On a permission prompt, this answers it |
| `stack_read_agent` | The last lines (≤ 200) of an agent's terminal |
| `stack_wait` | Blocks until a task goes idle, needs input, or the timeout (≤ 110 s) passes — event-driven, from the agents' own hooks |
| `stack_env` | For workers: worktree path, branch, ports with URLs, the compose project and a ready `docker compose … logs` command, setup/teardown scripts, test command |
| `stack_request_review` | For workers: marks the task ready for review with a one-line summary (shown as its row's line) and opens its Review panel |

**Workers get it too.** Every Claude Code or Codex agent Stack starts is given the same server for its own task (`--mcp-config` / `-c mcp_servers.stack.*`, your own MCP servers untouched), and its first prompt asks it to call `stack_request_review` when done. opencode is started without it.

**How it finds the window.** The server is a small Node script Stack keeps at a fixed path in its storage. Each VS Code window running Stack writes `windows/<pid>.json` (mode 0600) beside it with its port and a per-window token; on every call the server picks the window whose repository contains the `repo` argument, the task, or the agent's working directory (the most specific folder wins, then the most recently focused window), and calls it on `127.0.0.1` with that token. A window that reloads gets a new port and token and the next call simply finds it. Nothing matching is an error naming the open repositories — never a guess.

**Security, kept minimal on purpose.** The window API listens on `127.0.0.1` only, wants the window's token, and refuses requests that carry an `Origin` or a `Host` other than `127.0.0.1:<port>`, so web pages (DNS rebinding included) cannot reach it. Beyond that, anything running as you can drive Stack — the manager creates tasks and sends messages without asking. The hook endpoint the agents report to stays tokenless, because changing the hook script would cost every Codex user a re-trust.

## Switching worktrees

Clicking a worktree in the sidebar switches to it. There are two behaviours, trading screen tidiness against churn.

**Reveal (default).** Switching brings the worktree's agent terminal to the front and re-applies search scoping and explorer dimming. Nothing is closed or recreated, so switching is instant and flicker-free, and VS Code keeps your editor tabs exactly where you left them. No file is opened for you — that kept the terminal and the editor fighting over the foreground. The cost: tabs and agent terminals from the worktrees you've visited stay open.

**Focus mode** (`"stack.focusMode": true`). Switching gives you a clean slate: the other worktrees' editor tabs are closed and their agent terminals detached, so only the active worktree is on screen. Session tabs come back in the editor groups they were in. Each worktree's open files are remembered and reopened, in order, when you come back to it. The cost: visible churn on every switch, since tabs and a terminal really are torn down and rebuilt. Unsaved work is saved first, because tabs are about to close.

> Neither mode ever interrupts an agent: agents run in tmux, so detaching a terminal leaves them working. Only deleting a worktree or killing a session explicitly stops one.

## Staying in sync with the base branch

Each worktree card shows how far its branch has drifted from the branch it was cut from — `origin/develop  ↓12` under Git. That is a different question from ahead/behind, which compares against your own upstream and answers "have I pushed"; this one answers "should I rebase", and it is the number that grows while you work.

The base is recorded when the worktree is created, so a worktree cut from `release/3.2` keeps measuring against `release/3.2` however `stack.defaultBaseBranch` moves afterwards. Worktrees adopted from git carry no such record and fall back to the configured base. Nothing is shown for the main worktree, or for a worktree sitting on the base itself.

**Stack never fetches on its own.** The drift is read on a filesystem watch that fires as you save, and putting a network round trip behind that — on repositories whose remotes may be slow or want credentials — is not something to do uninvited. It compares against `origin/<base>` when that ref exists and the local `<base>` otherwise, and the card always names which, so the answer is never presented as fresher than it is. Keeping the remote ref current is whatever you already use for that: VS Code's own `git.autofetch`, a terminal `git pull` — or clicking the row, which fetches that one branch from `origin` and re-reads.

## Per-repo configuration

For heavier setups (dedicated Docker stack, dependency prep, debug), point the `stack.setupScript` / `stack.teardownScript` and `stack.docker` settings at your own script and compose files — **anywhere in the repo**, wherever you like to keep them.

The setup script runs in the background, its output in the **Stack** output channel, and the new worktree's agent starts once it has finished — so the agent never wakes up without its `vendor/`, `node_modules/` or `.env`. The worktree's row reads "Preparing… 1:42" meanwhile; if the script fails the row says so, with buttons to show the log, retry, or launch the agent anyway. **Init worktree** re-runs it the same way. A script that asks questions needs `stack.setupInTerminal`, which runs it in a terminal as before and starts the agent straight away.

When it runs your setup script, Stack exports `STACK_REPO_ROOT`, `STACK_WORKTREE_PATH`, `STACK_BRANCH`, `STACK_COMPOSE_PROJECT` (also under their Foreman-era names, `FOREMAN_*`, which are deprecated) and the worktree's auto-generated ports, and the matching debug port is wired into the generated `launch.json`. With Docker configured it also exports `COMPOSE_PROJECT_NAME` and `COMPOSE_FILE`, so a plain `docker compose up -d` in the script starts the very stack the card shows and deleting the worktree stops it (add `--project-directory "$STACK_WORKTREE_PATH"` when the compose file lives in the main repo). Relative paths resolve against the worktree first, then the main repo.

The teardown script runs in the background and deleting the worktree waits for it — the directory is only removed once the script is done (or after 10 minutes). Its output goes to the **Stack** output channel; a script that fails is reported, and the delete you asked for still happens.

The ▶ on a card runs `docker compose up -d` itself and waits for it: compose's output goes to the **Stack: Docker** output channel, and a stack that does not come up says why — on the card and in a toast with a *Show output* button. Before starting, Stack asks compose for the merged configuration and checks every port it will publish. Compose *adds* the override's `ports` to the base file's instead of replacing them, so a port hard-coded in the base file (`"27017:27017"`) is published by every worktree and the second stack fails; write it as `"${DB_PORT:-27017}:27017"` and add `DB_PORT` to the generated ports, or replace the list in the override with `ports: !override`.

If the Docker daemon is still starting (Docker Desktop, OrbStack, colima after a reboot), Stack waits a few seconds for it before giving up with a clear message, and nothing it runs against Docker can hang: a stuck `docker compose down` is abandoned after a minute with a warning, so deleting a worktree never sits in "deleting" forever.

Each worktree's ports are listed on its card, under Docker, and clicking one opens `http://localhost:<port>` — the numbers are derived from the same function that builds the compose environment, so the card cannot drift from what the container actually publishes. The debug port is shown when you name `DEBUG_PORT` but is not clickable; a debugger listener answers nothing a browser can render.

Ports are checked against the machine, not just against Stack's own bookkeeping: every port a worktree will bind is probed before the slot is handed out, and probed again right before a setup script or `compose up` runs. If something has taken one in the meantime — another project's container, a leftover stack from a deleted worktree, a local dev server — the worktree moves to a free slot, its `launch.json` follows, and you get a toast naming the port that was busy. Ports held by the worktree's own running stack don't count as taken. Slots are also reserved across VS Code windows, so two windows creating worktrees at the same moment never get the same one. Re-run your setup script afterwards if it bakes the port into a generated file such as `.env`.

> A `.stack/` folder is a handy place to keep these together. Scripts and compose files can live anywhere; only `.stack/config.json` below is a fixed path (a repository set up under Foreman's name keeps working from `.foreman/config.json` — see [Upgrading from Foreman](#upgrading-from-foreman)).

## Per-worktree debugging

Every worktree is handed a debug port of its own — `stack.debugBasePort` plus the worktree's slot — and a `.vscode/launch.json` generated from `stack.debugTemplate` with that port substituted in. Five worktrees means five listeners on five ports, so you can sit on a breakpoint in one while another keeps running.

The template is passed through whole. Stack substitutes `{{PORT}}` and `{{WORKTREE_PATH}}`, fills in a `name` if you left one out, and reads nothing else — so any debugger VS Code supports works the same way. The shipped default attaches to Node:

```json
{
  "type": "node",
  "request": "attach",
  "port": "{{PORT}}"
}
```

PHP with Xdebug against a container, for comparison:

```json
{
  "type": "php",
  "request": "launch",
  "port": "{{PORT}}",
  "pathMappings": { "/var/www": "{{WORKTREE_PATH}}" }
}
```

Name `DEBUG_PORT` in `stack.docker.ports` and the container is handed the same number in its environment, so what your compose file publishes and what the listener waits on cannot drift apart.

## Sharing the setup with your team

Most of the settings above describe the *project*, not you: where worktrees go, which compose files exist, which branch work starts from, what the setup script is called. Keeping them in your own `settings.json` means a teammate who clones the repo gets an extension that does nothing useful until someone pastes them a copy of your config.

Put them in **`.stack/config.json`** instead and commit it:

```json
{
  "version": 1,
  "worktreesDirectory": ".worktrees",
  "defaultBaseBranch": "main",
  "setupScript": ".stack/setup.sh",
  "teardownScript": ".stack/teardown.sh",
  "docker": {
    "composeFile": "docker-compose.yml",
    "overrideFile": "docker-compose.worktree.yml",
    "ports": ["HTTP_PORT", "DB_PORT"],
    "basePort": 20000,
    "portStride": 100
  },
  "debugBasePort": 9898
}
```

Run **Stack: Create Repo Config File** from the command palette to generate it from whatever is currently in effect on your machine — that's the handover: your working setup becomes a file that travels with the code.

**Precedence** is *your explicit setting* → *the repo file* → *the shipped default*. So the repo file gives everyone a sane starting point, and anyone who deliberately sets a value in their own `settings.json` keeps it. Only an explicitly-set value counts; a key you never touched doesn't shadow the repo's.

**Which keys it accepts:** `worktreesDirectory`, `defaultBaseBranch`, `setupScript`, `setupInTerminal`, `teardownScript`, `docker`, `debugBasePort`, `debugTemplate`. Every key is optional, and `docker` merges key by key — naming just your compose file won't reset `basePort`.

**Which it doesn't:** `defaultProvider`, the per-agent commands, `notifyOnAttention`, `focusMode`, `scopeSearchToActiveWorktree`. Which agent you reach for and where its binary lives are properties of your machine, and a repository you cloned has no business overriding them. Put one in the file and Stack tells you so rather than quietly ignoring it.

A broken file never breaks the extension: bad JSON, an unknown key or a wrong type falls back to your own settings and says what was wrong.

## Upgrading from Foreman

Stack is Foreman renamed: a new extension id (`ricardomoratomateos.stack`, was `foreman.foreman`), a new settings section, new command ids. Install Stack (`code --install-extension stack-x.y.z.vsix`), then uninstall Foreman (`code --uninstall-extension foreman.foreman`, or the button Stack offers while Foreman is still installed) and reload. What carries over, and how:

- **Settings.** Every `foreman.*` value you set — user, workspace or multi-root folder level — is copied once to the same `stack.*` key at the same level, never over a `stack.*` value already there. The `foreman.*` entries are left in your `settings.json`; delete them whenever you like.
- **Repo config.** `.stack/config.json` is the file now. A repository that only has `.foreman/config.json` keeps working: it is read (and saved from the settings panel) until a `.stack/config.json` exists, and Stack says so once. To move it, rename the folder to `.stack` and update any script paths inside that point into `.foreman/`; **Stack: Create Repo Config File** writes a fresh `.stack/config.json` instead. Scripts keep working wherever they are.
- **Scripts.** Setup and teardown scripts get `STACK_*` and, deprecated, the same values as `FOREMAN_*` (and the older `UNMESS_*`). Agents get `STACK_*` plus `FOREMAN_*` aliases.
- **Running agents.** Nothing is stopped. A worktree's `foreman-<id>` tmux session is renamed to `stack-<id>` with its agents in it, and its tabs' sessions follow, still attached. Agents Foreman started keep running Foreman's notify hook until they restart, and still report to Stack: it accepts their `X-Foreman-*` requests and keeps Foreman's routing files current. Foreman's entries in `~/.claude/settings.json`, `~/.codex/hooks.json` and its opencode plugin are replaced by Stack's, never left beside them.
- **Codex** asks you to trust the hooks once more (`/hooks`): the notify script moved and changed.
- **Worktrees, tabs, breakpoints, session names.** These live in the extension's own storage, which VS Code keys on the extension id, so a new id starts empty. Stack moves Foreman's keys (`foreman.*` → `stack.*`) when they are present in its storage — copy Foreman's row of VS Code's `state.vscdb` to the new id before the first start to keep them. Without that, worktrees on disk are found again from git under new ids, without aliases or recorded base branches, and Foreman's tmux sessions are not matched to them: their agents keep running, reachable with `tmux attach -t foreman-<id>`.

## License

[MIT](LICENSE) © Ricardo Morato
