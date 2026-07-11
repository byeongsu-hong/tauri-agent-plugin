use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use tauri::{Runtime, Window};

/// Plugin-owned registry of live webviews, keyed by **webview** label.
///
/// Tauri's `Manager::webview_windows()` silently drops a window from its map
/// the moment a second webview is attached to it (`Window::is_webview_window()`
/// flips to false), so a host calling `window.add_child(...)` used to evict a
/// perfectly healthy guest registration for the original webview (#39).
///
/// Entries are added from the plugin's `on_webview_ready` hook and removed
/// only when their host window is destroyed, scoped to that exact window — an
/// unrelated webview joining a window can never disturb an existing entry.
pub(crate) struct WebviewRegistry<R: Runtime> {
    entries: Mutex<HashMap<String, Window<R>>>,
}

impl<R: Runtime> Default for WebviewRegistry<R> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<R: Runtime> WebviewRegistry<R> {
    pub(crate) fn register(&self, webview_label: &str, window: Window<R>) {
        self.lock().insert(webview_label.to_string(), window);
    }

    /// Evict every webview hosted by the destroyed window, and nothing else.
    // ponytail: tauri emits no per-webview destroy event, so a bare child
    // webview closed before its window leaves a stale entry until the window
    // dies; bridge calls to it fail with a timeout instead of WINDOW_NOT_FOUND.
    pub(crate) fn remove_window(&self, window_label: &str) {
        self.lock()
            .retain(|_, window| window.label() != window_label);
    }

    pub(crate) fn contains(&self, webview_label: &str) -> bool {
        self.lock().contains_key(webview_label)
    }

    pub(crate) fn window(&self, webview_label: &str) -> Option<Window<R>> {
        self.lock().get(webview_label).cloned()
    }

    /// All registered `(webview label, host window)` pairs.
    pub(crate) fn entries(&self) -> Vec<(String, Window<R>)> {
        self.lock()
            .iter()
            .map(|(label, window)| (label.clone(), window.clone()))
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Window<R>>> {
        self.entries.lock().expect("webview registry mutex")
    }
}
