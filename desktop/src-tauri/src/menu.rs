//! The native application menu (macOS menu bar): Stack (About, Settings…, Hide, Quit), Edit (so ⌘C / ⌘V
//! work in inputs), View (window modes) and Window. Clicks become events for the webview:
//! `menu://settings`, `menu://mode` (payload "full" / "half" / "float" / "cycle" / "side") and `menu://go` (payload
//! "switch" / "switch-back" / "next" / "prev" / "needs" / "manager"). Go carries ⌃Tab: AppKit swallows it as a key-view
//! loop key before the page sees it, but menu key equivalents are matched first.
//!
//! "Cycle mode" has no accelerator here: ⇧⌘F is already handled by the webview (src/model.ts), and
//! both would toggle it twice.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

const SETTINGS: &str = "app-settings";
const MODE_PREFIX: &str = "app-mode:";
const GO_PREFIX: &str = "app-go:";

/// The payload of `menu://go` for a menu item id, if it is one of the Go items.
pub fn go_of(id: &str) -> Option<&str> {
    id.strip_prefix(GO_PREFIX).filter(|m| matches!(*m, "switch" | "switch-back" | "next" | "prev" | "needs" | "manager"))
}

/// The payload of `menu://mode` for a menu item id, if it is one of the mode items.
pub fn mode_of(id: &str) -> Option<&str> {
    id.strip_prefix(MODE_PREFIX).filter(|m| matches!(*m, "full" | "half" | "float" | "cycle" | "side"))
}

fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let stack = Submenu::with_items(
        app,
        "Stack",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, SETTINGS, "Settings…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let mode = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, format!("{MODE_PREFIX}{id}"), text, true, accel);
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &mode("full", "Full", Some("CmdOrCtrl+Shift+1"))?,
            &mode("half", "Half", Some("CmdOrCtrl+Shift+2"))?,
            &mode("float", "Float", Some("CmdOrCtrl+Shift+3"))?,
            &PredefinedMenuItem::separator(app)?,
            &mode("cycle", "Cycle Mode  ⇧⌘F", None)?,
            &mode("side", "Snap Half to the Other Side", None)?,
        ],
    )?;
    let go_item = |id: &str, text: &str, accel: &str| MenuItem::with_id(app, format!("{GO_PREFIX}{id}"), text, true, Some(accel));
    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &go_item("switch", "Switch Agent", "Ctrl+Tab")?,
            &go_item("switch-back", "Switch Agent Backwards", "Ctrl+Shift+Tab")?,
            &PredefinedMenuItem::separator(app)?,
            &go_item("next", "Next Worktree", "Alt+Cmd+Down")?,
            &go_item("prev", "Previous Worktree", "Alt+Cmd+Up")?,
            &go_item("needs", "Next That Needs You", "Cmd+Shift+J")?,
            &PredefinedMenuItem::separator(app)?,
            &go_item("manager", "Manager", "Cmd+0")?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, Some("Zoom"))?],
    )?;
    Menu::with_items(app, &[&stack, &edit, &view, &go, &window])
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == SETTINGS {
            let _ = app.emit("menu://settings", ());
        } else if let Some(m) = mode_of(id) {
            let _ = app.emit("menu://mode", m);
        } else if let Some(g) = go_of(id) {
            let _ = app.emit("menu://go", g);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn go_ids_map_to_the_payload() {
        assert_eq!(go_of("app-go:switch-back"), Some("switch-back"));
        assert_eq!(go_of("app-go:needs"), Some("needs"));
        assert_eq!(go_of("app-go:nope"), None);
    }

    #[test]
    fn mode_ids_map_to_the_payload() {
        assert_eq!(mode_of("app-mode:float"), Some("float"));
        assert_eq!(mode_of("app-mode:cycle"), Some("cycle"));
        assert_eq!(mode_of("app-mode:nope"), None);
        assert_eq!(mode_of("mode:full"), None);
    }
}
