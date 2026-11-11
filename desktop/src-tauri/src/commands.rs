//! Tauri commands: the webview's view of a tmux control connection.
//!
//! Events emitted: `tmux://output` ({pane, data: base64}), `tmux://layout`
//! (re-list panes), `tmux://exit`.

use std::sync::{Arc, Mutex as StdMutex};

use tauri::{AppHandle, Emitter, State};
use tmux_cc::{Client, Config, Event, Mode};
use tokio::sync::Mutex;

use crate::bridge::{self, Action, Flow, PaneInfo};

#[derive(Default)]
pub struct Bridge {
    conn: Mutex<Option<Conn>>,
}

struct Conn {
    client: Client,
    flow: Arc<StdMutex<Flow>>,
}

async fn conn(state: &State<'_, Bridge>) -> Result<(Client, Arc<StdMutex<Flow>>), String> {
    state.conn.lock().await.as_ref().map(|c| (c.client.clone(), c.flow.clone())).ok_or_else(|| "not connected".to_string())
}

fn err(e: tmux_cc::Error) -> String {
    e.to_string()
}

/// Attach to `session` on the tmux server `socket` (`-L`; `None` = the
/// default server). With `create`, a missing session is created.
#[tauri::command]
pub async fn connect(
    app: AppHandle,
    state: State<'_, Bridge>,
    socket: Option<String>,
    session: String,
    create: Option<bool>,
) -> Result<Vec<PaneInfo>, String> {
    let mode = if create.unwrap_or(false) {
        Mode::NewSession { name: Some(session), cwd: None, size: None, attach_if_exists: true }
    } else {
        Mode::Attach { target: session }
    };
    let mut config = Config::new(socket.as_deref().filter(|s| !s.is_empty()), mode);
    config.pause_after = Some(1);
    let (client, mut rx) = Client::connect(config).await.map_err(err)?;
    let flow = Arc::new(StdMutex::new(Flow::default()));

    let (task_client, task_flow, task_app) = (client.clone(), flow.clone(), app.clone());
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            match ev {
                Event::Notification(n) => {
                    let actions = task_flow.lock().unwrap().on_notification(n);
                    for a in actions {
                        match a {
                            Action::Output { pane, data } => {
                                let _ = task_app.emit("tmux://output", bridge::output_payload(&pane, &data));
                            }
                            Action::Continue(pane) => {
                                let _ = task_client.continue_pane(&pane).await;
                            }
                            Action::LayoutChanged => {
                                let _ = task_app.emit("tmux://layout", ());
                            }
                            Action::Exit => {}
                        }
                    }
                }
                Event::Closed { .. } => {
                    let _ = task_app.emit("tmux://exit", ());
                    break;
                }
            }
        }
    });

    let panes = list(&client).await?;
    *state.conn.lock().await = Some(Conn { client, flow });
    Ok(panes)
}

async fn list(client: &Client) -> Result<Vec<PaneInfo>, String> {
    // `-s`: every pane of the session, not just the current window.
    let text = client.run(&format!("list-panes -s -F '{}'", bridge::LIST_FORMAT)).await.map_err(err)?;
    Ok(bridge::parse_panes(&text))
}

#[tauri::command]
pub async fn disconnect(state: State<'_, Bridge>) -> Result<(), String> {
    if let Some(c) = state.conn.lock().await.take() {
        let _ = c.client.detach().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn list_panes(state: State<'_, Bridge>) -> Result<Vec<PaneInfo>, String> {
    let (client, _) = conn(&state).await?;
    list(&client).await
}

/// The panes the UI currently renders or reads. Paused ones among them are
/// resumed; panes that are not listed stay paused when tmux pauses them.
#[tauri::command]
pub async fn set_visible(state: State<'_, Bridge>, panes: Vec<String>) -> Result<(), String> {
    let (client, flow) = conn(&state).await?;
    let panes: Vec<String> = panes.into_iter().filter(|p| bridge::valid_id(p, '%')).collect();
    let resume = flow.lock().unwrap().set_visible(panes);
    for p in resume {
        client.continue_pane(&p).await.map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn write(state: State<'_, Bridge>, pane: String, data: Vec<u8>) -> Result<(), String> {
    check(&pane, '%')?;
    let (client, _) = conn(&state).await?;
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
    let (client, _) = conn(&state).await?;
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
    let (client, _) = conn(&state).await?;
    client.run(&bridge::capture_command(&pane, start, end)).await.map_err(err)
}

fn check(id: &str, sigil: char) -> Result<(), String> {
    if bridge::valid_id(id, sigil) {
        Ok(())
    } else {
        Err(format!("invalid id {id:?}"))
    }
}
