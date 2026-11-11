// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod shell;
mod stackd;
mod window;

fn main() {
    tauri::Builder::default()
        .manage(commands::Bridge::default())
        .manage(commands::StackdLatest::default())
        .manage(shell::Shell::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(shell::global_shortcut_plugin())
        .setup(|app| {
            commands::start_stackd_watch(app.handle().clone());
            shell::setup(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::subscribe_output,
            commands::ack_output,
            commands::connect,
            commands::disconnect,
            commands::list_panes,
            commands::set_visible,
            commands::write,
            commands::resize,
            commands::capture,
            commands::stackd_latest,
            commands::stackd_command,
            commands::vscode_settings,
            commands::open_url,
            shell::set_tray,
            shell::notify_show,
            window::window_frame,
            window::set_window_mode,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stack desktop");
}
