//! Tauri commands: the webview's view of the tmux control connections (one
//! per tmux session) and of stackd.
//!
//! Pane output goes over a `Channel` (see `subscribe_output`) as raw binary frames; events:
//! `tmux://layout`
//! ({session}: re-list that session's panes), `tmux://exit` ({session}),
//! `stackd://status` ({running, socket}) and `stackd://state` (the snapshot).

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager, State};
use tmux_cc::{Client, Config, Event, Mode};
use tokio::sync::Mutex;

use std::time::{Duration, Instant};

use crate::bridge::{self, Action, Coalescer, Flow, Gate, PaneInfo, PaneOwners};
use crate::stackd;

#[derive(Default)]
pub struct Bridge {
    conns: Mutex<HashMap<String, Conn>>,
    owners: StdMutex<PaneOwners>,
    /// Where pane output goes: the webview's channel (`subscribe_output`).
    sink: StdMutex<Option<Channel<InvokeResponseBody>>>,
    gate: Gate,
}

struct Conn {
    client: Client,
    flow: Arc<StdMutex<Flow>>,
}

impl Bridge {
    async fn client_for_pane(&self, pane: &str) -> Result<Client, String> {
        let session = self.owners.lock().unwrap().owner(pane).map(str::to_string).ok_or_else(|| format!("pane {pane} is not in a connected session"))?;
        self.conns.lock().await.get(&session).map(|c| c.client.clone()).ok_or_else(|| format!("not connected to {session}"))
    }

    async fn client_for_session(&self, session: &str) -> Result<Client, String> {
        self.conns.lock().await.get(session).map(|c| c.client.clone()).ok_or_else(|| format!("not connected to {session}"))
    }

    async fn list(&self, session: &str) -> Result<Vec<PaneInfo>, String> {
        let client = self.client_for_session(session).await?;
        // `-s`: every pane of the session, not just the current window.
        let text = client.run(&format!("list-panes -s -F '{}'", bridge::LIST_FORMAT)).await.map_err(err)?;
        let mut panes = bridge::parse_panes(&text);
        if panes.is_empty() {
            log_line("warn".into(), format!("list-panes for {session} gave no panes; reply: {text:?}"));
        }
        for p in &mut panes {
            p.session = session.to_string();
        }
        self.owners.lock().unwrap().set_session(session, panes.iter().map(|p| p.id.clone()));
        Ok(panes)
    }
}

/// Sends what is waiting, one frame per pane, each after the ack gate lets it through.
async fn flush(app: &AppHandle, coal: &mut Coalescer) {
    let bridge = app.state::<Bridge>();
    for (pane, data) in coal.take() {
        let sink = bridge.sink.lock().unwrap().clone();
        if let (Some(sink), Some(frame)) = (sink, bridge::output_frame(&pane, &data)) {
            bridge.gate.wait().await;
            bridge.gate.sent(data.len());
            let _ = sink.send(InvokeResponseBody::Raw(frame));
        }
    }
}

fn err(e: tmux_cc::Error) -> String {
    e.to_string()
}

/// The webview's output channel; frames are `u32` LE pane number + raw bytes. A new call replaces the old channel.
#[tauri::command]
pub fn subscribe_output(state: State<'_, Bridge>, channel: Channel<InvokeResponseBody>) {
    *state.sink.lock().unwrap() = Some(channel);
    state.gate.reset();
}

/// The webview parsed `bytes` of output; lets the backend send more.
#[tauri::command]
pub fn ack_output(state: State<'_, Bridge>, bytes: usize) {
    state.gate.ack(bytes);
}

/// Attach to `session` on the tmux server `socket` (`-L`; `None` = the
/// default server). With `create`, a missing session is created. Connecting
/// to a session that is already connected just lists its panes again.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, Bridge>,
    socket: Option<String>,
    session: String,
    create: Option<bool>,
) -> Result<Vec<PaneInfo>, String> {
    if state.conns.lock().await.contains_key(&session) {
        return state.list(&session).await;
    }
    let mode = if create.unwrap_or(false) {
        Mode::NewSession { name: Some(session.clone()), cwd: None, size: None, attach_if_exists: true }
    } else {
        Mode::Attach { target: session.clone() }
    };
    let mut config = Config::new(socket.as_deref().filter(|s| !s.is_empty()), mode);
    config.pause_after = Some(1);
    let (client, mut rx) = Client::connect(config).await.map_err(err)?;
    let flow = Arc::new(StdMutex::new(Flow::default()));

    let (task_client, task_flow, task_app, task_session) = (client.clone(), flow.clone(), app.clone(), session.clone());
    tokio::spawn(async move {
        let mut coal = Coalescer::default();
        loop {
            // With output waiting, a quiet connection still flushes once the oldest byte is 16 ms old.
            let ev = match coal.remaining(Instant::now()) {
                None => rx.recv().await,
                Some(wait) => tokio::select! {
                    ev = rx.recv() => ev,
                    _ = tokio::time::sleep(wait) => {
                        flush(&task_app, &mut coal).await;
                        continue;
                    }
                },
            };
            let Some(ev) = ev else { break };
            match ev {
                Event::Notification(n) => {
                    let actions = task_flow.lock().unwrap().on_notification(n);
                    for a in actions {
                        match a {
                            Action::Output { pane, data } => {
                                coal.push(&pane, &data, Instant::now());
                                if coal.remaining(Instant::now()) == Some(Duration::ZERO) {
                                    flush(&task_app, &mut coal).await;
                                }
                            }
                            Action::Continue(pane) => {
                                // not awaited here: the reader that answers it may be waiting on this loop
                                let c = task_client.clone();
                                tokio::spawn(async move {
                                    let _ = c.continue_pane(&pane).await;
                                });
                            }
                            Action::LayoutChanged => {
                                let _ = task_app.emit("tmux://layout", SessionPayload { session: task_session.clone() });
                            }
                            Action::Exit => {}
                        }
                    }
                }
                Event::Closed { .. } => break,
            }
        }
        flush(&task_app, &mut coal).await;
        let bridge = task_app.state::<Bridge>();
        bridge.conns.lock().await.remove(&task_session);
        bridge.owners.lock().unwrap().remove_session(&task_session);
        let _ = task_app.emit("tmux://exit", SessionPayload { session: task_session });
    });

    state.conns.lock().await.insert(session.clone(), Conn { client, flow });
    state.list(&session).await
}

#[derive(Serialize, Clone)]
struct SessionPayload {
    session: String,
}

/// Detach one session, or every one when `session` is `None`.
#[tauri::command]
pub async fn disconnect(state: State<'_, Bridge>, session: Option<String>) -> Result<(), String> {
    let taken: Vec<(String, Conn)> = {
        let mut conns = state.conns.lock().await;
        match session {
            Some(s) => conns.remove(&s).map(|c| (s, c)).into_iter().collect(),
            None => conns.drain().collect(),
        }
    };
    for (s, c) in taken {
        state.owners.lock().unwrap().remove_session(&s);
        let _ = c.client.detach().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_panes(state: State<'_, Bridge>, session: String) -> Result<Vec<PaneInfo>, String> {
    state.list(&session).await
}

/// The panes the UI currently renders or reads (across all sessions). Paused
/// ones among them are resumed; the others stay paused when tmux pauses them.
#[tauri::command]
pub async fn set_visible(state: State<'_, Bridge>, panes: Vec<String>) -> Result<(), String> {
    let panes: Vec<String> = panes.into_iter().filter(|p| bridge::valid_id(p, '%')).collect();
    let mut resume: Vec<(Client, String)> = vec![];
    {
        let conns = state.conns.lock().await;
        let parts = state.owners.lock().unwrap().partition(conns.keys().map(String::as_str), &panes);
        for (session, ids) in parts {
            if let Some(c) = conns.get(&session) {
                for p in c.flow.lock().unwrap().set_visible(ids) {
                    resume.push((c.client.clone(), p));
                }
            }
        }
    }
    for (client, p) in resume {
        client.continue_pane(&p).await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn write(state: State<'_, Bridge>, pane: String, data: Vec<u8>) -> Result<(), String> {
    check(&pane, '%')?;
    let client = state.client_for_pane(&pane).await?;
    client.send_bytes(&pane, &data).await.map_err(err)?.into_text().map(|_| ()).map_err(err)
}

/// Size the window that holds `pane` to `cols` x `rows`
/// (`refresh-client -C @win:CxR`, falling back to `resize-window`).
#[tauri::command]
pub async fn resize(state: State<'_, Bridge>, pane: String, cols: u16, rows: u16) -> Result<(), String> {
    check(&pane, '%')?;
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    let client = state.client_for_pane(&pane).await?;
    let window = client.run(&format!("display-message -p -t {pane} '#{{window_id}}'")).await.map_err(err)?;
    let window = window.trim();
    check(window, '@')?;
    let r = client.command(&format!("refresh-client -C {window}:{cols}x{rows}")).await.map_err(err)?;
    if !r.ok {
        client.run(&format!("resize-window -t {window} -x {cols} -y {rows}")).await.map_err(err)?;
    }
    Ok(())
}

/// Text (with SGR escapes) of lines `start..=end` of the pane; negative
/// numbers reach into the scrollback, `end = None` runs to the bottom.
#[tauri::command]
pub async fn capture(state: State<'_, Bridge>, pane: String, start: i32, end: Option<i32>) -> Result<String, String> {
    check(&pane, '%')?;
    let client = state.client_for_pane(&pane).await?;
    client.run(&bridge::capture_command(&pane, start, end)).await.map_err(err)
}

/// Where tmux has the pane's cursor and whether it shows it: `(x, y, visible)`. A capture
/// leaves xterm's cursor after the last character written, and visible.
#[tauri::command]
pub async fn pane_cursor(state: State<'_, Bridge>, pane: String) -> Result<(u16, u16, bool), String> {
    check(&pane, '%')?;
    let client = state.client_for_pane(&pane).await?;
    let out = client
        .run(&format!("display-message -p -t {pane} '#{{cursor_x}} #{{cursor_y}} #{{cursor_flag}}'"))
        .await
        .map_err(err)?;
    bridge::parse_cursor(&out).ok_or_else(|| format!("unexpected cursor reply {out:?}"))
}

/// The terminal modes the pane's program has set, as tmux reports them (space-separated 0/1, in
/// `PANE_MODES` order; parsed by the frontend's `paneModes.ts`). A resync resets xterm, which
/// would otherwise forget them: an agent on the alternate screen with mouse reporting stops
/// getting wheel events and cannot be scrolled.
#[tauri::command]
pub async fn pane_modes(state: State<'_, Bridge>, pane: String) -> Result<String, String> {
    check(&pane, '%')?;
    let client = state.client_for_pane(&pane).await?;
    client.run(&format!("display-message -p -t {pane} '{}'", bridge::PANE_MODES)).await.map_err(err)
}

/// Paste `text` into a pane through tmux (`paste-buffer -p`), so it arrives bracketed when the
/// program asked for bracketed paste. xterm can't know that after a resync, and agents only turn a
/// pasted image path into an attachment when it comes as a paste, not as typing.
#[tauri::command]
pub async fn paste_text(state: State<'_, Bridge>, pane: String, text: String) -> Result<(), String> {
    check(&pane, '%')?;
    if text.is_empty() {
        return Ok(());
    }
    let client = state.client_for_pane(&pane).await?;
    let file = std::env::temp_dir().join(format!("stack-paste-{}-{}", std::process::id(), pane.trim_start_matches('%')));
    std::fs::write(&file, text.as_bytes()).map_err(|e| e.to_string())?;
    let buffer = format!("stack-paste-{}", pane.trim_start_matches('%'));
    let path = file.to_string_lossy().into_owned();
    let loaded = client.run(&format!("load-buffer -b {buffer} {}", tmux_cc::client::quote(&path))).await;
    let _ = std::fs::remove_file(&file);
    loaded.map_err(err)?;
    client.run(&format!("paste-buffer -p -d -b {buffer} -t {pane}")).await.map_err(err)?;
    Ok(())
}

/// Dropped files that live in a macOS temporary drag location (a screenshot's floating thumbnail
/// lands in `…/TemporaryItems/NSIRD_screencaptureui_*`) are gone or unreadable by the time an
/// agent in tmux opens them. Copy those into `~/Library/Caches/Stack/drops/` while this process can
/// still read them, and hand back the paths to use. Other paths come back unchanged.
#[tauri::command]
pub async fn stage_drops(paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(home) = std::env::var_os("HOME") else { return Ok(paths) };
        let dir = std::path::Path::new(&home).join("Library/Caches/Stack/drops");
        Ok(paths.into_iter().map(|p| stage_one(&p, &dir).unwrap_or(p)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn stage_one(path: &str, dir: &std::path::Path) -> Option<String> {
    if !bridge::is_transient_drop(path) {
        return None;
    }
    let src = std::path::Path::new(path);
    let name = src.file_name()?;
    std::fs::create_dir_all(dir).ok()?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_millis();
    let dest = dir.join(format!("{stamp}-{}", name.to_string_lossy()));
    std::fs::copy(src, &dest).ok()?;
    Some(dest.to_string_lossy().into_owned())
}

/// What ⌘V should paste: `image` when the clipboard holds a picture (agents read it themselves
/// on Ctrl+V), otherwise its text. WKWebView gives a paste event no image data, so ask macOS.
#[derive(Serialize)]
pub struct ClipboardPaste {
    image: bool,
    text: String,
}

#[tauri::command]
pub async fn clipboard_paste() -> Result<ClipboardPaste, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let info = std::process::Command::new("osascript").args(["-e", "clipboard info"]).output().map_err(|e| e.to_string())?;
        let info = String::from_utf8_lossy(&info.stdout);
        if bridge::clipboard_has_image(&info) {
            return Ok(ClipboardPaste { image: true, text: String::new() });
        }
        let text = std::process::Command::new("pbpaste").env("LANG", "en_US.UTF-8").output().map_err(|e| e.to_string())?;
        Ok(ClipboardPaste { image: false, text: String::from_utf8_lossy(&text.stdout).into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn check(id: &str, sigil: char) -> Result<(), String> {
    if bridge::valid_id(id, sigil) {
        Ok(())
    } else {
        Err(format!("invalid id {id:?}"))
    }
}

// ── stackd ────────────────────────────────────────────────────────────────

/// What the watcher last saw, for a webview that mounts after the events.
#[derive(Default)]
pub struct StackdLatest {
    inner: StdMutex<(bool, Option<Value>)>,
}

#[derive(Serialize, Clone)]
struct Status {
    running: bool,
    socket: String,
}

#[derive(Serialize)]
pub struct Latest {
    running: bool,
    socket: String,
    snapshot: Option<Value>,
}

/// The start the app makes by itself when it opens and no stackd answers; `stackd://autostart` on change.
#[derive(Default, Clone, Serialize)]
pub struct Autostart {
    attempted: bool,
    done: bool,
    error: Option<String>,
}

#[derive(Default)]
pub struct StackdAutostart(StdMutex<Autostart>);

fn set_autostart(app: &AppHandle, a: Autostart) {
    *app.state::<StackdAutostart>().0.lock().unwrap() = a.clone();
    let _ = app.emit("stackd://autostart", a);
}

/// Starts the watcher. The first time it finds no stackd (the app just opened), it starts one.
pub fn start_stackd_watch(app: AppHandle) {
    let socket = stackd::socket_path();
    let first = std::sync::atomic::AtomicBool::new(true);
    tauri::async_runtime::spawn(async move {
        let sink_app = app.clone();
        let sock_name = socket.display().to_string();
        stackd::watch(socket, std::time::Duration::from_secs(2), move |u| {
            let latest = sink_app.state::<StackdLatest>();
            match u {
                stackd::Update::Status(running) => {
                    if first.swap(false, std::sync::atomic::Ordering::SeqCst) && !running {
                        let app = sink_app.clone();
                        set_autostart(&app, Autostart { attempted: true, ..Default::default() });
                        tauri::async_runtime::spawn_blocking(move || {
                            let res = crate::launchd::real_setup(resource_dir(&app).as_deref())
                                .and_then(|s| crate::launchd::launch(&crate::launchd::RealRunner, &s));
                            set_autostart(&app, Autostart { attempted: true, done: true, error: res.err() });
                        });
                    }
                    let mut g = latest.inner.lock().unwrap();
                    g.0 = running;
                    if !running {
                        g.1 = None;
                    }
                    drop(g);
                    let _ = sink_app.emit("stackd://status", Status { running, socket: sock_name.clone() });
                }
                stackd::Update::State(snapshot) => {
                    latest.inner.lock().unwrap().1 = Some(snapshot.clone());
                    let _ = sink_app.emit("stackd://state", snapshot);
                }
            }
        })
        .await;
    });
}

#[tauri::command]
pub fn stackd_latest(state: State<'_, StackdLatest>) -> Latest {
    let g = state.inner.lock().unwrap();
    Latest { running: g.0, socket: stackd::socket_path().display().to_string(), snapshot: g.1.clone() }
}

/// `POST /commands/<name>`; the answer's `result`, or the daemon's error text.
#[tauri::command]
pub async fn stackd_command(name: String, body: Option<Value>) -> Result<Value, String> {
    if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err(format!("invalid command name {name:?}"));
    }
    let body = body.unwrap_or_else(|| Value::Object(Default::default()));
    stackd::request(&stackd::socket_path(), "POST", &format!("/commands/{name}"), Some(&body)).await
}

// ── stackd as a launchd agent / one-off start (at app open when none runs, or on the user's action) ──

fn resource_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().resource_dir().ok()
}

/// Whether the "Start stackd at login" agent is installed.
#[tauri::command]
pub fn stackd_login_status() -> bool {
    crate::launchd::home_dir().map(|h| crate::launchd::is_installed(&h)).unwrap_or(false)
}

/// Installs (and loads) or removes the launchd user agent.
#[tauri::command]
pub async fn stackd_set_login(app: AppHandle, enabled: bool) -> Result<bool, String> {
    crate::shell::set_login(&app, enabled)
}

/// Starts stackd with the user's node (under the login agent when installed, else detached);
/// the log goes to ~/.config/stack/stackd.log.
#[tauri::command]
pub async fn stackd_start_now(app: AppHandle) -> Result<(), String> {
    let setup = crate::launchd::real_setup(resource_dir(&app).as_deref())?;
    crate::launchd::launch(&crate::launchd::RealRunner, &setup)
}

/// What the app's own start at open did (for the "stackd is not running" screen).
#[tauri::command]
pub fn stackd_autostart(state: State<'_, StackdAutostart>) -> Autostart {
    state.0.lock().unwrap().clone()
}

/// The pid of the process listening on `socket` (`lsof -t`; the first one when several hold it).
fn socket_owner(socket: &std::path::Path) -> Option<i32> {
    let out = std::process::Command::new("/usr/sbin/lsof").arg("-t").arg(socket).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().filter_map(|l| l.trim().parse::<i32>().ok()).find(|&p| p as u32 != std::process::id())
}

/// Stops the running stackd (its pid is in the snapshot) and starts the app's own build of it.
/// Agents keep running: they live in tmux sessions, which outlive stackd.
#[tauri::command]
pub async fn stackd_restart(app: AppHandle) -> Result<(), String> {
    let pid = {
        let latest = app.state::<StackdLatest>();
        let g = latest.inner.lock().unwrap();
        g.1.as_ref().and_then(|s| s.get("pid")).and_then(Value::as_i64).map(|p| p as i32)
    };
    // A stackd from before the snapshot carried its pid: the process holding the socket is it.
    let pid = match pid {
        Some(p) => Some(p),
        None => Some(socket_owner(&crate::stackd::socket_path()).ok_or("could not find stackd's process; quit it and reopen Stack")?),
    };
    let setup = crate::launchd::real_setup(resource_dir(&app).as_deref())?;
    tauri::async_runtime::spawn_blocking(move || crate::launchd::restart(&crate::launchd::RealRunner, &setup, pid))
        .await
        .map_err(|e| e.to_string())?
}

// ── ~/.config/stack/settings.json (what stackd reads; the Settings screen edits it) ──

/// `$STACKD_CONFIG_DIR/settings.json`, else `~/.config/stack/settings.json`.
fn settings_path() -> Result<std::path::PathBuf, String> {
    let dir = match std::env::var_os("STACKD_CONFIG_DIR").filter(|d| !d.is_empty()) {
        Some(d) => std::path::PathBuf::from(d),
        None => std::path::Path::new(&std::env::var_os("HOME").ok_or("HOME is not set")?).join(".config/stack"),
    };
    Ok(dir.join("settings.json"))
}

/// The file's object; anything missing or malformed is `{}` (as stackd reads it).
fn read_object(path: &std::path::Path) -> serde_json::Map<String, Value> {
    match std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(Value::Object(m)) => m,
        _ => serde_json::Map::new(),
    }
}

/// Applies `changes` (key without the `stack.` prefix; `null` = reset to default) to `existing`.
/// Unknown keys stay; a `stack.`-prefixed twin of a changed key is dropped.
pub fn merge_settings(mut existing: serde_json::Map<String, Value>, changes: &serde_json::Map<String, Value>) -> serde_json::Map<String, Value> {
    for (key, value) in changes {
        let key = key.strip_prefix("stack.").unwrap_or(key);
        existing.remove(&format!("stack.{key}"));
        if value.is_null() {
            existing.remove(key);
        } else {
            existing.insert(key.to_string(), value.clone());
        }
    }
    existing
}

/// The user's stackd settings (`{}` when there are none).
#[tauri::command]
pub fn read_settings() -> Result<Value, String> {
    Ok(Value::Object(read_object(&settings_path()?)))
}

/// Merges `changes` into settings.json (created if needed) and writes it atomically; returns the result.
#[tauri::command]
pub fn write_settings(changes: serde_json::Map<String, Value>) -> Result<Value, String> {
    write_settings_at(&settings_path()?, &changes)
}

fn write_settings_at(path: &std::path::Path, changes: &serde_json::Map<String, Value>) -> Result<Value, String> {
    let merged = Value::Object(merge_settings(read_object(path), changes));
    let dir = path.parent().ok_or("bad settings path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".settings.json.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(merged)
}

/// Opens settings.json (created empty if missing) in the default text editor, for the settings the screen does not cover.
#[tauri::command]
pub fn open_settings_file() -> Result<(), String> {
    let path = settings_path()?;
    if !path.exists() {
        write_settings_at(&path, &serde_json::Map::new())?;
    }
    std::process::Command::new("open").arg("-t").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod settings_tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn merge_sets_keeps_unknown_and_drops_prefixed_twin() {
        let out = merge_settings(obj(json!({"stack.claudeCommand": "claude", "other": 1, "defaultBaseBranch": "main"})), &obj(json!({"claudeCommand": "cl", "stack.defaultBaseBranch": "dev"})));
        assert_eq!(Value::Object(out), json!({"claudeCommand": "cl", "other": 1, "defaultBaseBranch": "dev"}));
    }

    #[test]
    fn null_resets_both_spellings() {
        let out = merge_settings(obj(json!({"stack.a": 1, "a": 2, "b": 3})), &obj(json!({"a": null})));
        assert_eq!(Value::Object(out), json!({"b": 3}));
    }

    #[test]
    fn writes_atomically_into_a_new_dir() {
        let dir = std::env::temp_dir().join(format!("stack-settings-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("nested/settings.json");
        write_settings_at(&file, &obj(json!({"claudeCommand": "c"}))).unwrap();
        let out = write_settings_at(&file, &obj(json!({"opencodeCommand": "x"}))).unwrap();
        assert_eq!(out, json!({"claudeCommand": "c", "opencodeCommand": "x"}));
        assert_eq!(read_object(&file).len(), 2);
        assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

// ── <repo>/.stack/config.json (the project settings; the Settings screen's repo tab edits it) ──

/// The keys of a repo's config the screen may write (scalar ones; the file may hold more, which stay).
const REPO_KEYS: [&str; 14] = [
    "worktreesDirectory", "defaultBaseBranch", "setupScript", "setupInTerminal", "teardownScript",
    // The Code tab
    "phpNavigation", "phpIndexDirs", "phpExcludeDirs", "phpExtensions", "phpAutoloader", "phpBaseBranch", "phpMaxChangedFiles",
    "scriptExcludeDirs", "oxlintConfig",
];

/// `<root>/.stack/config.json`, only when `root` is a directory holding `.git` (file or directory).
fn repo_config_path(root: &str) -> Result<std::path::PathBuf, String> {
    let root = std::path::Path::new(root);
    if !root.is_absolute() || !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    if !root.join(".git").exists() {
        return Err(format!("{} is not a git repository", root.display()));
    }
    Ok(root.join(".stack").join("config.json"))
}

/// The repo's `.stack/config.json` object (`{}` when there is none).
#[tauri::command]
pub fn read_repo_config(repo_root: String) -> Result<Value, String> {
    Ok(Value::Object(read_object(&repo_config_path(&repo_root)?)))
}

/// Applies `changes` (`null` = remove the key) to the repo's config, keeping every other key and the
/// order; a new file starts with `"version": 1`. Written atomically as 2-space JSON; returns the result.
#[tauri::command]
pub fn write_repo_config(repo_root: String, changes: serde_json::Map<String, Value>) -> Result<Value, String> {
    write_repo_config_at(&repo_config_path(&repo_root)?, &changes)
}

fn write_repo_config_at(path: &std::path::Path, changes: &serde_json::Map<String, Value>) -> Result<Value, String> {
    if let Some(bad) = changes.keys().find(|k| !REPO_KEYS.contains(&k.as_str())) {
        return Err(format!("{bad} is not a project setting"));
    }
    let existing = read_object(path);
    let mut merged = serde_json::Map::new();
    if !existing.contains_key("version") {
        merged.insert("version".into(), Value::from(1));
    }
    merged.extend(existing);
    for (key, value) in changes {
        if value.is_null() {
            merged.remove(key);
        } else {
            merged.insert(key.clone(), value.clone());
        }
    }
    let merged = Value::Object(merged);
    let dir = path.parent().ok_or("bad config path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!(".config.json.{}.tmp", std::process::id()));
    let text = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(merged)
}

#[cfg(test)]
mod repo_config_tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("stack-repocfg-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn rejects_non_repos_and_relative_paths() {
        let dir = temp_repo("plain");
        assert!(repo_config_path(dir.to_str().unwrap()).is_err());
        assert!(repo_config_path("relative/path").is_err());
        assert!(repo_config_path(dir.join("missing").to_str().unwrap()).is_err());
        std::fs::write(dir.join(".git"), "gitdir: elsewhere").unwrap(); // a worktree's .git file counts
        assert_eq!(repo_config_path(dir.to_str().unwrap()).unwrap(), dir.join(".stack/config.json"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn creates_with_version_keeps_unknown_keys_and_removes_on_null() {
        let dir = temp_repo("write");
        std::fs::create_dir(dir.join(".git")).unwrap();
        let file = repo_config_path(dir.to_str().unwrap()).unwrap();
        let out = write_repo_config_at(&file, &obj(json!({"defaultBaseBranch": "main"}))).unwrap();
        assert_eq!(out, json!({"version": 1, "defaultBaseBranch": "main"}));
        std::fs::write(&file, "{\"version\": 3, \"future\": {\"a\": 1}, \"setupScript\": \"x\"}").unwrap();
        let out = write_repo_config_at(&file, &obj(json!({"setupScript": null, "setupInTerminal": true}))).unwrap();
        assert_eq!(out, json!({"version": 3, "future": {"a": 1}, "setupInTerminal": true}));
        assert!(std::fs::read_to_string(&file).unwrap().contains("\n  \"version\": 3"));
        assert_eq!(std::fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        assert!(write_repo_config_at(&file, &obj(json!({"claudeCommand": "x"}))).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Only these may reach the browser: https links and localhost ports (PR, ticket, dev servers).
pub fn openable(url: &str) -> bool {
    let rest = if let Some(r) = url.strip_prefix("https://") {
        !r.is_empty()
    } else if let Some(r) = url.strip_prefix("http://localhost") {
        r.is_empty() || r.starts_with(':') || r.starts_with('/')
    } else {
        false
    };
    rest && url.len() < 2048 && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// Opens `url` in the default browser (macOS `open`; no shell, the URL is one argument).
#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    if !openable(&url) {
        return Err(format!("refusing to open {url}"));
    }
    std::process::Command::new("open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Opens `path` in VS Code at `line` (`code -g path:line`; falls back to macOS `open`, which ignores the line).
/// Only absolute paths; the path is one argument, never a shell string.
#[tauri::command]
pub fn open_in_editor(path: String, line: Option<u32>) -> Result<(), String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err(format!("refusing to open {path}"));
    }
    let target = match line {
        Some(l) if l > 0 => format!("{path}:{l}"),
        _ => path.clone(),
    };
    let code = std::process::Command::new("code").arg("-g").arg(&target).spawn();
    if code.is_ok() {
        return Ok(());
    }
    std::process::Command::new("open").arg("--").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::openable;

    #[test]
    fn only_https_and_localhost_open() {
        assert!(openable("https://github.com/a/b/pull/1"));
        assert!(openable("http://localhost:3000"));
        assert!(openable("http://localhost/x"));
        assert!(!openable("http://example.com"));
        assert!(!openable("http://localhost.evil.com"));
        assert!(!openable("file:///etc/passwd"));
        assert!(!openable("javascript:alert(1)"));
        assert!(!openable("https://"));
        assert!(!openable("https://a b"));
        assert!(!openable("-a Calculator"));
    }
}

/// One line from the webview into `~/Library/Logs/Stack/app.log` (the bundled app has no console).
#[tauri::command]
pub fn log_line(level: String, message: String) {
    use std::io::Write;
    let Some(home) = std::env::var_os("HOME") else { return };
    let dir = std::path::Path::new(&home).join("Library/Logs/Stack");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join("app.log");
    // keep it small: start over past 1 MiB
    if std::fs::metadata(&path).map(|m| m.len() > 1 << 20).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let level: String = level.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let message: String = message.chars().take(4000).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{secs:.3} {level} {message}");
    }
}
