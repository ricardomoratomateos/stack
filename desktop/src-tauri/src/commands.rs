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

use crate::bridge::{self, Action, Flow, Gate, PaneInfo, PaneOwners};
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
        for p in &mut panes {
            p.session = session.to_string();
        }
        self.owners.lock().unwrap().set_session(session, panes.iter().map(|p| p.id.clone()));
        Ok(panes)
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
        while let Some(ev) = rx.recv().await {
            match ev {
                Event::Notification(n) => {
                    let actions = task_flow.lock().unwrap().on_notification(n);
                    for a in actions {
                        match a {
                            Action::Output { pane, data } => {
                                let bridge = task_app.state::<Bridge>();
                                let sink = bridge.sink.lock().unwrap().clone();
                                if let (Some(sink), Some(frame)) = (sink, bridge::output_frame(&pane, &data)) {
                                    bridge.gate.wait().await;
                                    bridge.gate.sent(data.len());
                                    let _ = sink.send(InvokeResponseBody::Raw(frame));
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

/// Starts the watcher; it only ever connects to an existing socket.
pub fn start_stackd_watch(app: AppHandle) {
    let socket = stackd::socket_path();
    tauri::async_runtime::spawn(async move {
        let sink_app = app.clone();
        let sock_name = socket.display().to_string();
        stackd::watch(socket, std::time::Duration::from_secs(2), move |u| {
            let latest = sink_app.state::<StackdLatest>();
            match u {
                stackd::Update::Status(running) => {
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

/// The user's VS Code `settings.json` (JSONC, parsed by the frontend), or `None` when there is none.
/// Read-only: the app takes `stack.sidebarStyle` from it.
#[tauri::command]
pub fn vscode_settings() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = std::path::Path::new(&home).join("Library/Application Support/Code/User/settings.json");
    std::fs::read_to_string(path).ok()
}
