pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_agent::init())
        .run(tauri::generate_context!())
        .expect("failed to run tauri-agent fixture app");
}
