use tauri::{AppHandle, Manager, Runtime};

use crate::models::{
    AgentActionRequest, AgentAttachRequest, AgentAttachResponse, AgentEventEntry,
    AgentEventsRequest, AgentLogEntry, AgentLogRequest, AgentRecordRequest, AgentRecordResponse,
    AgentScreenshotRequest, AgentSnapshotRequest, AgentStateRequest, AgentWaitRequest,
    AgentWaitResponse, WindowInfo,
};
use crate::{Error, Result};

#[tauri::command]
pub async fn agent_attach<R: Runtime>(
    app: AppHandle<R>,
    request: AgentAttachRequest,
) -> Result<AgentAttachResponse> {
    ensure_window(&app, request.window.as_deref())?;
    Ok(AgentAttachResponse {
        attached: true,
        windows: collect_windows(&app),
    })
}

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
pub async fn agent_logs<R: Runtime>(
    app: AppHandle<R>,
    request: AgentLogRequest,
) -> Result<Vec<AgentLogEntry>> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_logs needs guest console instrumentation and is not active in Rust bridge v0",
    ))
}

#[tauri::command]
pub async fn agent_events<R: Runtime>(
    app: AppHandle<R>,
    request: AgentEventsRequest,
) -> Result<Vec<AgentEventEntry>> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_events needs a stream transport and is not active in v0",
    ))
}

#[tauri::command]
pub async fn agent_windows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WindowInfo>> {
    Ok(collect_windows(&app))
}

#[tauri::command]
pub async fn agent_wait<R: Runtime>(
    app: AppHandle<R>,
    request: AgentWaitRequest,
) -> Result<AgentWaitResponse> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_wait needs guest text waiters and is not active in Rust bridge v0",
    ))
}

#[tauri::command]
pub async fn agent_state<R: Runtime>(
    app: AppHandle<R>,
    request: AgentStateRequest,
) -> Result<serde_json::Value> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_state needs guest state probes and is not active in Rust bridge v0",
    ))
}

#[tauri::command]
pub async fn agent_record<R: Runtime>(
    app: AppHandle<R>,
    request: AgentRecordRequest,
) -> Result<AgentRecordResponse> {
    ensure_window(&app, request.window.as_deref())?;
    Err(Error::BridgeUnavailable(
        "agent_record needs guest action recording and is not active in Rust bridge v0",
    ))
}

pub(crate) fn collect_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<WindowInfo> {
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
    windows
}

pub(crate) fn ensure_window<R: Runtime>(app: &AppHandle<R>, label: Option<&str>) -> Result<()> {
    if let Some(label) = label {
        if !app.webview_windows().contains_key(label) {
            return Err(Error::WindowNotFound(label.to_string()));
        }
    }
    Ok(())
}
