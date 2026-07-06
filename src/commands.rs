use tauri::{AppHandle, Manager, Runtime};

use crate::models::{AgentActionRequest, AgentScreenshotRequest, AgentSnapshotRequest, WindowInfo};
use crate::{Error, Result};

#[tauri::command]
pub async fn agent_snapshot<R: Runtime>(
    app: AppHandle<R>,
    request: AgentSnapshotRequest,
) -> Result<String> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_snapshot is reserved for the guest JS semantic-tree bridge in v0",
    ))
}

#[tauri::command]
pub async fn agent_action<R: Runtime>(
    app: AppHandle<R>,
    request: AgentActionRequest,
) -> Result<()> {
    ensure_window(&app, request.window.as_deref())?;
    if !request.ref_id.starts_with('@') {
        return Err(Error::StaleRef(request.ref_id));
    }
    Err(Error::BridgeUnavailable(
        "agent_action is reserved for the guest JS ref registry in v0",
    ))
}

#[tauri::command]
pub async fn agent_screenshot<R: Runtime>(
    app: AppHandle<R>,
    request: AgentScreenshotRequest,
) -> Result<String> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_screenshot will use native capture after the bridge is wired",
    ))
}

#[tauri::command]
pub async fn agent_events<R: Runtime>(app: AppHandle<R>, window: Option<String>) -> Result<()> {
    ensure_window(&app, window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_events needs a stream transport and is not active in v0",
    ))
}

#[tauri::command]
pub async fn agent_windows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WindowInfo>> {
    let mut windows = app
        .webview_windows()
        .into_values()
        .map(|window| WindowInfo {
            label: window.label().to_string(),
            title: window.title().ok(),
            focused: window.is_focused().unwrap_or(false),
            visible: window.is_visible().unwrap_or(false),
        })
        .collect::<Vec<_>>();
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(windows)
}

fn ensure_window<R: Runtime>(app: &AppHandle<R>, label: Option<&str>) -> Result<()> {
    if let Some(label) = label {
        if !app.webview_windows().contains_key(label) {
            return Err(Error::WindowNotFound(label.to_string()));
        }
    }
    Ok(())
}
