// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod commands;

fn main() {
    tauri::Builder::default()
        .manage(commands::Bridge::default())
        .invoke_handler(tauri::generate_handler![
            commands::connect,
            commands::disconnect,
            commands::list_panes,
            commands::set_visible,
            commands::write,
            commands::resize,
            commands::capture,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Stack desktop");
}
