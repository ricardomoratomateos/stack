#!/usr/bin/env bash
# T7 benchmark: 8 worktrees/sessions with fake agents, one floods output. Fully isolated:
# own stackd config dir/home, own tmux server (-L stackbench), throwaway git repo.
# usage: desktop/bench/run.sh [idle_s=30] [flood_s=60]   (needs a release build: cd desktop && npx tauri build --no-bundle)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO_ROOT="$(cd "$HERE/../.." && pwd)"
APP="$HERE/../target/release/stack-desktop"; IDLE=${1:-30}; FLOOD=${2:-60}; SOCK=stackbench
[ -x "$APP" ] || { echo "build first: cd desktop && npx tauri build --no-bundle"; exit 1; }
[ -f "$REPO_ROOT/dist/stackd.js" ] || { echo "build first: npm run compile"; exit 1; }
if tmux -L $SOCK has-session 2>/dev/null; then echo "tmux -L $SOCK already running; refusing"; exit 1; fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/stackbench.XXXXXX")"; TMP="$(cd "$TMP" && pwd -P)"
export STACKD_CONFIG_DIR="$TMP/cfg" STACKD_TMUX_SOCKET=$SOCK STACKD_HOME="$TMP/home" STACKD_DEFER_IMPORT=1
mkdir -p "$TMP/cfg" "$TMP/home" "$TMP/repo"; chmod 700 "$TMP/cfg"
APP_PID=""; SD_PID=""; TMUX_SOCKFILE=""
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null
  [ -n "$SD_PID" ] && kill "$SD_PID" 2>/dev/null
  sleep 1; [ -n "$SD_PID" ] && kill -9 "$SD_PID" 2>/dev/null
  tmux -L $SOCK kill-server 2>/dev/null; [ -n "$TMUX_SOCKFILE" ] && rm -f "$TMUX_SOCKFILE"
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM
cmd() { curl -s --unix-socket "$STACKD_CONFIG_DIR/stackd.sock" -X POST -H 'content-type: application/json' -d "$2" "http://stackd/commands/$1"; }
state() { curl -s --max-time 2 --unix-socket "$STACKD_CONFIG_DIR/stackd.sock" http://stackd/state; }

# Fake agent: idles (cheap), floods base64 lines while $TMP/flood holds its worktree id.
cat > "$TMP/agent.sh" <<AGENT
#!/bin/bash
LINE="\$(head -c 120 /dev/urandom | base64)"
while :; do
  if [ "\$(cat "$TMP/flood" 2>/dev/null)" = "\$STACK_WORKSPACE_ID" ]; then yes "\$LINE" | head -n 3000; else sleep 0.5; fi
done
AGENT
chmod +x "$TMP/agent.sh"

git -C "$TMP/repo" init -q -b main && git -C "$TMP/repo" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
( cd "$TMP" && exec node "$REPO_ROOT/dist/stackd.js" serve >"$TMP/stackd.log" 2>&1 ) & SD_PID=$!
for _ in $(seq 100); do [ -S "$STACKD_CONFIG_DIR/stackd.sock" ] && break; sleep 0.2; done
cmd setSettings "{\"values\":{\"claudeCommand\":\"$TMP/agent.sh\",\"notifyOnAttention\":false}}" >/dev/null
cmd addRepo "{\"repo\":\"$TMP/repo\"}" >/dev/null
for i in 1 2 3 4 5 6 7; do cmd createTask "{\"repo\":\"$TMP/repo\",\"branch\":\"bench-$i\",\"title\":\"B$i\"}" >/dev/null; done
python3 -I - "$TMP/repo" <<'PY' > "$TMP/ids"
import json, subprocess, sys, os
s = json.loads(subprocess.run(['curl','-s','--unix-socket',os.environ['STACKD_CONFIG_DIR']+'/stackd.sock','http://stackd/state'],capture_output=True,text=True).stdout)
s = s if 'repos' in s else s.get('result', s)
r = [x for x in s['repos'] if x['repoRoot'].endswith('repo')][0]
for w in r['state']['worktrees']: print(w['id'], sum(1 for x in w['sessions'] if x['kind']=='agent'))
PY
# Worktrees without an agent session (the main checkout) get one so all 8 are live.
while read -r id n; do [ "$n" = 0 ] && cmd spawnAgent "{\"worktreeId\":\"$id\"}" >/dev/null; done < "$TMP/ids"
sleep 5
read -r VISIBLE _ < "$TMP/ids"; HIDDEN=$(tail -1 "$TMP/ids" | cut -d' ' -f1)
echo "worktrees: $(wc -l < "$TMP/ids"); app shows (first in list): $VISIBLE; hidden flood: $HIDDEN"
TMUX_SOCKFILE="$(tmux -L $SOCK display -p '#{socket_path}')"
SESSIONS=$(tmux -L $SOCK list-sessions 2>/dev/null | wc -l); echo "tmux sessions: $SESSIONS"

ps -axo pid=,command= | awk '/com.apple.WebKit/{print $1}' > "$TMP/baseline"
"$APP" >"$TMP/app.log" 2>&1 & APP_PID=$!
sleep 12   # let the app connect, size panes and settle
CSV="$HERE/last-samples.csv"; : > "$CSV"
S() { python3 -I "$HERE/sample.py" "$CSV" "$1" "$2" 2 "$APP_PID" "$SD_PID" $SOCK "$TMP/baseline"; }
S "a idle (8 sessions)" "$IDLE"
echo -n "$HIDDEN" > "$TMP/flood"; S "b flood (hidden pane)" "$FLOOD"
echo -n "$VISIBLE" > "$TMP/flood"; S "c flood (visible pane)" "$FLOOD"
: > "$TMP/flood"
for pid in $APP_PID; do footprint "$pid" 2>/dev/null | head -12; done
kill -0 "$APP_PID" 2>/dev/null || echo "WARNING: app died during the run (see below)" ; tail -5 "$TMP/app.log"
python3 -I "$HERE/summarize.py" "$CSV" | tee "$HERE/last-results.md"
