//! The app's presence outside its window: native notifications, the menu-bar (tray) item and the
//! global shortcuts. What to notify and when lives in the webview (src/notify/policy.ts); this
//! side only delivers, and turns clicks into events.
//!
//! Notifications have no action buttons (no Apple Developer account yet). tauri-plugin-notification
//! cannot report a click on desktop, so a click is recognised by its effect: the app is activated
//! shortly after a notification was shown, and the session it was about gets selected.
//! In `tauri dev` the notification is posted under Terminal's identity (there is no bundle yet);
//! if delivery fails, the error is logged and returned to the webview, which shows it in-app.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_notification::NotificationExt;

const TRAY_ID: &str = "stack";
/// A focus this soon after a notification is taken as a click on it.
const CLICK_WINDOW: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct Shell {
    last_notice: Mutex<Option<(String, Instant)>>,
    last_model: Mutex<Option<TrayModel>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrayEntry {
    #[serde(rename = "worktreeId")]
    pub worktree_id: String,
    pub label: String,
    pub allow: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TrayModel {
    pub title: String,
    pub needs: Vec<TrayEntry>,
    pub review: Vec<TrayEntry>,
    pub dnd: bool,
    /// "Start stackd at login" is on (filled in here from the plist, not sent by the webview).
    #[serde(default)]
    pub login: bool,
}

/// One line of the tray menu, before it becomes a native item.
#[derive(Debug, Clone, PartialEq)]
pub enum Row {
    Header(String),
    Item { id: String, text: String },
    Check { id: String, text: String, on: bool },
    Separator,
}

pub const SHOW_LABEL: &str = "Show Stack  ⌃⌥⌘S";
pub const MANAGER_LABEL: &str = "Manager  ⌃⌥⌘M";

/// Needing you (each with Allow when it is a permission prompt), ready for review, then the fixed items.
pub fn menu_rows(m: &TrayModel) -> Vec<Row> {
    let mut rows = Vec::new();
    if !m.needs.is_empty() {
        rows.push(Row::Header("Needs you".into()));
        for e in &m.needs {
            rows.push(Row::Item { id: format!("go:{}", e.worktree_id), text: e.label.clone() });
            if let Some(i) = e.allow {
                rows.push(Row::Item { id: format!("allow:{i}:{}", e.worktree_id), text: format!("    Allow · {}", e.label) });
            }
        }
        rows.push(Row::Separator);
    }
    if !m.review.is_empty() {
        rows.push(Row::Header("Ready for review".into()));
        rows.extend(m.review.iter().map(|e| Row::Item { id: format!("go:{}", e.worktree_id), text: e.label.clone() }));
        rows.push(Row::Separator);
    }
    rows.push(Row::Item { id: "show".into(), text: SHOW_LABEL.into() });
    rows.push(Row::Item { id: "manager".into(), text: MANAGER_LABEL.into() });
    rows.push(Row::Check { id: "dnd".into(), text: "Do not disturb".into(), on: m.dnd });
    rows.push(Row::Check { id: "login".into(), text: "Start stackd at login".into(), on: m.login });
    rows.push(Row::Separator);
    rows.push(Row::Item { id: "quit".into(), text: "Quit".into() });
    rows
}

#[derive(Debug, PartialEq)]
pub enum MenuAction {
    Go(String),
    Allow(String, u32),
    Show,
    Manager,
    Dnd,
    Login,
    Quit,
}

pub fn parse_menu_id(id: &str) -> Option<MenuAction> {
    match id {
        "show" => Some(MenuAction::Show),
        "manager" => Some(MenuAction::Manager),
        "dnd" => Some(MenuAction::Dnd),
        "login" => Some(MenuAction::Login),
        "quit" => Some(MenuAction::Quit),
        _ => {
            if let Some(rest) = id.strip_prefix("go:") {
                return Some(MenuAction::Go(rest.to_string()));
            }
            let rest = id.strip_prefix("allow:")?;
            let (idx, wt) = rest.split_once(':')?;
            Some(MenuAction::Allow(wt.to_string(), idx.parse().ok()?))
        }
    }
}

fn build_menu(app: &AppHandle, m: &TrayModel) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    for row in menu_rows(m) {
        match row {
            Row::Header(t) => menu.append(&MenuItem::with_id(app, "header", t, false, None::<&str>)?)?,
            Row::Item { id, text } => menu.append(&MenuItem::with_id(app, id, text, true, None::<&str>)?)?,
            Row::Check { id, text, on } => menu.append(&CheckMenuItem::with_id(app, id, text, true, on, None::<&str>)?)?,
            Row::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
        }
    }
    Ok(menu)
}

/// A lime square, drawn rather than shipped.
fn icon() -> Image<'static> {
    const N: u32 = 18;
    let mut px = Vec::with_capacity((N * N * 4) as usize);
    for y in 0..N {
        for x in 0..N {
            let inside = (3..N - 3).contains(&x) && (3..N - 3).contains(&y);
            px.extend_from_slice(if inside { &[0xa3, 0xe6, 0x35, 0xff] } else { &[0, 0, 0, 0] });
        }
    }
    Image::new_owned(px, N, N)
}

pub fn show_app(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn toggle_app(w: &WebviewWindow) {
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
        let _ = w.hide();
    } else {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match parse_menu_id(id) {
        Some(MenuAction::Go(wt)) => {
            show_app(app);
            let _ = app.emit("app://select", wt);
        }
        Some(MenuAction::Allow(wt, idx)) => {
            let body = serde_json::json!({ "worktreeId": wt, "windowIndex": idx, "answer": "allow" });
            tauri::async_runtime::spawn(async move {
                if let Err(e) = crate::stackd::request(&crate::stackd::socket_path(), "POST", "/commands/respondPermission", Some(&body)).await {
                    eprintln!("tray: Allow failed: {e}");
                }
            });
        }
        Some(MenuAction::Show) => show_app(app),
        Some(MenuAction::Manager) => {
            show_app(app);
            let _ = app.emit("app://manager", ());
        }
        Some(MenuAction::Dnd) => {
            let _ = app.emit("tray://dnd", ());
        }
        Some(MenuAction::Login) => {
            let on = crate::launchd::home_dir().map(|h| crate::launchd::is_installed(&h)).unwrap_or(false);
            if let Err(e) = set_login(app, !on) {
                eprintln!("tray: start stackd at login failed: {e}");
                let _ = app.emit("stackd://login-error", e);
            }
        }
        Some(MenuAction::Quit) => app.exit(0),
        None => {}
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let model = TrayModel { title: "◆ 0  ◇ 0".into(), needs: vec![], review: vec![], dnd: false, login: false };
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon())
        .icon_as_template(false)
        .title(&model.title)
        .tooltip("Stack")
        .menu(&build_menu(app, &model)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .build(app)
}

/// Hardcoded for now: ⌃⌥⌘ + J / M / S.
fn setup_shortcuts(app: &AppHandle) {
    let mods = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER;
    let keys = [Code::KeyJ, Code::KeyM, Code::KeyS];
    for code in keys {
        if let Err(e) = app.global_shortcut().register(Shortcut::new(Some(mods), code)) {
            eprintln!("global shortcut {code:?} not registered: {e}");
        }
    }
}

fn on_shortcut(app: &AppHandle, shortcut: &Shortcut) {
    match shortcut.key {
        Code::KeyJ => {
            show_app(app);
            let _ = app.emit("app://next", ());
        }
        Code::KeyM => {
            show_app(app);
            let _ = app.emit("app://manager", ());
        }
        Code::KeyS => {
            if let Some(w) = app.get_webview_window("main") {
                toggle_app(&w);
            }
        }
        _ => {}
    }
}

pub fn global_shortcut_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                on_shortcut(app, shortcut);
            }
        })
        .build()
}

pub fn setup(app: &AppHandle) {
    if let Err(e) = setup_tray(app) {
        eprintln!("menu-bar item not created: {e}");
    }
    setup_shortcuts(app);
    if let Some(w) = app.get_webview_window("main") {
        let handle = app.clone();
        w.on_window_event(move |ev| {
            if let WindowEvent::Focused(true) = ev {
                take_click(&handle);
            }
        });
    }
}

/// The app was just activated: if a notification was shown a moment ago, that was its click.
fn take_click(app: &AppHandle) {
    let shell = app.state::<Shell>();
    let hit = shell.last_notice.lock().unwrap().take();
    if let Some((id, at)) = hit {
        if at.elapsed() <= CLICK_WINDOW {
            let _ = app.emit("app://select", id);
        }
    }
}

/// Turns the launchd agent on or off (the real `launchctl`), then refreshes the tray's check mark.
pub fn set_login(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let home = crate::launchd::home_dir()?;
    if enabled {
        let rd = app.path().resource_dir().ok();
        let setup = crate::launchd::real_setup(rd.as_deref())?;
        crate::launchd::enable(&crate::launchd::RealRunner, &setup)?;
    } else {
        crate::launchd::disable(&crate::launchd::RealRunner, &home, crate::launchd::current_uid())?;
    }
    let model = app.state::<Shell>().last_model.lock().unwrap().clone();
    if let Some(m) = model {
        let _ = apply_tray(app, m);
    }
    let _ = app.emit("stackd://login", enabled);
    Ok(enabled)
}

fn apply_tray(app: &AppHandle, mut model: TrayModel) -> Result<(), String> {
    model.login = crate::launchd::home_dir().map(|h| crate::launchd::is_installed(&h)).unwrap_or(false);
    *app.state::<Shell>().last_model.lock().unwrap() = Some(model.clone());
    let tray = app.tray_by_id(TRAY_ID).ok_or("no menu-bar item")?;
    tray.set_title(Some(&model.title)).map_err(|e| e.to_string())?;
    tray.set_menu(Some(build_menu(app, &model).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_tray(app: AppHandle, model: TrayModel) -> Result<(), String> {
    apply_tray(&app, model)
}

/// Shows a notification about worktree `id`. Err(why) when the system would not take it.
#[tauri::command]
pub fn notify_show(app: AppHandle, shell: State<'_, Shell>, title: String, body: String, id: String) -> Result<(), String> {
    *shell.last_notice.lock().unwrap() = Some((id, Instant::now()));
    app.notification().builder().title(title).body(body).sound("default").show().map_err(|e| {
        let why = format!("notification not delivered: {e}");
        eprintln!("{why}");
        why
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, allow: Option<u32>) -> TrayEntry {
        TrayEntry { worktree_id: id.into(), label: format!("repo · {id}"), allow }
    }

    #[test]
    fn menu_lists_needs_with_allow_then_review_then_fixed_items() {
        let m = TrayModel { title: String::new(), needs: vec![entry("a", Some(2)), entry("b", None)], review: vec![entry("c", None)], dnd: true, login: false };
        let rows = menu_rows(&m);
        let ids: Vec<&str> = rows.iter().filter_map(|r| match r { Row::Item { id, .. } | Row::Check { id, .. } => Some(id.as_str()), _ => None }).collect();
        assert_eq!(ids, ["go:a", "allow:2:a", "go:b", "go:c", "show", "manager", "dnd", "login", "quit"]);
        assert!(rows.contains(&Row::Check { id: "dnd".into(), text: "Do not disturb".into(), on: true }));
    }

    #[test]
    fn empty_menu_has_only_the_fixed_items() {
        let m = TrayModel { title: String::new(), needs: vec![], review: vec![], dnd: false, login: false };
        assert!(!menu_rows(&m).iter().any(|r| matches!(r, Row::Header(_))));
        assert_eq!(menu_rows(&m).len(), 6);
    }

    #[test]
    fn menu_ids_round_trip_even_with_colons_in_the_worktree_id() {
        assert_eq!(parse_menu_id("allow:3:/a:b"), Some(MenuAction::Allow("/a:b".into(), 3)));
        assert_eq!(parse_menu_id("go:/a:b"), Some(MenuAction::Go("/a:b".into())));
        assert_eq!(parse_menu_id("quit"), Some(MenuAction::Quit));
        assert_eq!(parse_menu_id("allow:x:y"), None);
        assert_eq!(parse_menu_id("header"), None);
    }

    #[test]
    fn icon_is_a_lime_square_on_transparent() {
        let i = icon();
        assert_eq!(i.rgba().len(), (i.width() * i.height() * 4) as usize);
        assert_eq!(&i.rgba()[0..4], &[0, 0, 0, 0]);
    }
}
