//! The native application menu (macOS menu bar): Stack (About, Settings…, Hide, Quit), Edit (so ⌘C / ⌘V
//! work in inputs), View (window modes) and Window. Clicks become events for the webview:
//! `menu://settings` and `menu://mode` (payload "full" / "half" / "float" / "cycle" / "side").
//!
//! "Cycle mode" has no accelerator here: ⇧⌘F is already handled by the webview (src/model.ts), and
//! both would toggle it twice.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

const SETTINGS: &str = "app-settings";
const MODE_PREFIX: &str = "app-mode:";

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
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, Some("Zoom"))?],
    )?;
    Menu::with_items(app, &[&stack, &edit, &view, &window])
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    app.set_menu(build(app)?)?;
    app.on_menu_event(|app, event| {
        let id = event.id().as_ref();
        if id == SETTINGS {
            let _ = app.emit("menu://settings", ());
        } else if let Some(m) = mode_of(id) {
            let _ = app.emit("menu://mode", m);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_ids_map_to_the_payload() {
        assert_eq!(mode_of("app-mode:float"), Some("float"));
        assert_eq!(mode_of("app-mode:cycle"), Some("cycle"));
        assert_eq!(mode_of("app-mode:nope"), None);
        assert_eq!(mode_of("mode:full"), None);
    }
}
