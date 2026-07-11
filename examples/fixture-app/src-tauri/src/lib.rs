use std::time::{Duration, Instant};

use tauri::{Manager, Runtime};

/// When set, the fixture drives its in-webview bridge self-test on boot and
/// exits with a code (0 pass, 1 fail, 2 timeout) — the cheapest real end-to-end
/// check that a live WKWebView/webkit2gtk webview answers the agent bridge.
const SELF_TEST_ENV: &str = "TAURI_AGENT_SELF_TEST";
const EXTERNAL_TEST_ENV: &str = "TAURI_AGENT_EXTERNAL_TEST";
const TEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_agent_plugin::init())
        .on_page_load(|webview, payload| {
            if std::env::var(SELF_TEST_ENV).is_err() || webview.label() != "main" {
                return;
            }
            // Nudge the frontend into autorun mode by adding the `selfTest`
            // query param (a one-time reload the frontend then detects).
            let already = payload
                .url()
                .query()
                .map(|query| query.contains("selfTest"))
                .unwrap_or(false);
            if !already {
                let _ = webview.eval(
                    "if (!location.search.includes('selfTest')) { const url = new URL(location.href); url.searchParams.set('selfTest', '1'); location.replace(url.toString()); }",
                );
            }
        })
        .setup(|app| {
            if std::env::var(SELF_TEST_ENV).is_ok() {
                spawn_test_watcher(app.handle().clone(), "SELFTEST");
            } else if std::env::var(EXTERNAL_TEST_ENV).is_ok() {
                spawn_test_watcher(app.handle().clone(), "EXTERNALTEST");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri-agent fixture app");
}

/// Poll the main window title for a test sentinel, then exit normally so plugin
/// lifecycle cleanup (including endpoint removal) runs.
fn spawn_test_watcher<R: Runtime>(app: tauri::AppHandle<R>, prefix: &'static str) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + TEST_TIMEOUT;
        let pass = format!("{prefix}:PASS");
        let fail = format!("{prefix}:FAIL");
        loop {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(title) = window.title() {
                    if title.contains(&pass) {
                        app.exit(0);
                        return;
                    }
                    if title.contains(&fail) {
                        eprintln!("fixture {prefix} reported failure");
                        app.exit(1);
                        return;
                    }
                }
            }
            if Instant::now() >= deadline {
                eprintln!("fixture {prefix} timed out after {TEST_TIMEOUT:?}");
                app.exit(2);
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}
