// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;
mod stackd;

fn main() {
    tauri::Builder::default()
        .manage(commands::Bridge::default())
        .manage(commands::StackdLatest::default())
        .setup(|app| {
            commands::start_stackd_watch(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::disconnect,
            commands::list_panes,
            commands::set_visible,
            commands::write,
            commands::resize,
            commands::capture,
            commands::stackd_latest,
            commands::stackd_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stack desktop");
}
