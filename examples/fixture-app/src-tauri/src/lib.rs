use std::time::{Duration, Instant};

use tauri::{Manager, Runtime};

/// When set, the fixture drives its in-webview bridge self-test on boot and
/// exits with a code (0 pass, 1 fail, 2 timeout) — the cheapest real end-to-end
/// check that a live WKWebView/webkit2gtk webview answers the agent bridge.
const SELF_TEST_ENV: &str = "TAURI_AGENT_SELF_TEST";
const SELF_TEST_TIMEOUT: Duration = Duration::from_secs(30);

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
                spawn_self_test_watcher(app.handle().clone());
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run tauri-agent fixture app");
}

/// Poll the main window title (which mirrors `document.title`) for the sentinel
/// the frontend writes when the self-test finishes, then exit with its code.
fn spawn_self_test_watcher<R: Runtime>(app: tauri::AppHandle<R>) {
    std::thread::spawn(move || {
        let deadline = Instant::now() + SELF_TEST_TIMEOUT;
        loop {
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(title) = window.title() {
                    if title.contains("SELFTEST:PASS") {
                        app.exit(0);
                        return;
                    }
                    if title.contains("SELFTEST:FAIL") {
                        eprintln!("fixture self-test reported failure");
                        app.exit(1);
                        return;
                    }
                }
            }
            if Instant::now() >= deadline {
                eprintln!("fixture self-test timed out after {SELF_TEST_TIMEOUT:?}");
                app.exit(2);
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    });
}
