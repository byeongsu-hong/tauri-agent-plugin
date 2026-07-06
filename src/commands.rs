use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, State};

use crate::bridge::{AgentBridge, AgentBridgeResponse};
use crate::models::{
    AgentAction, AgentActionRequest, AgentAttachRequest, AgentAttachResponse, AgentEventEntry,
    AgentEventsRequest, AgentInspectRequest, AgentInspectResponse, AgentLogEntry, AgentLogRequest,
    AgentRecordRequest, AgentRecordResponse, AgentScreenshotRequest, AgentSnapshotRequest,
    AgentStateRequest, AgentWaitRequest, AgentWaitResponse, WindowInfo,
};
use crate::screenshot::write_data_url_to_path;
use crate::{Error, Result};

#[tauri::command]
pub async fn agent_bridge_response(
    bridge: State<'_, AgentBridge>,
    response: AgentBridgeResponse,
) -> Result<()> {
    bridge.complete(response);
    Ok(())
}

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
    bridge: State<'_, AgentBridge>,
    request: AgentSnapshotRequest,
) -> Result<String> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "tree", &request)?;
    snapshot_text_from_bridge(result)
}

#[tauri::command]
pub async fn agent_action<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentActionRequest,
) -> Result<()> {
    if !matches!(&request.action, AgentAction::Press) {
        match request.ref_id.as_deref() {
            Some(ref_id) if ref_id.starts_with('@') => {}
            Some(ref_id) => return Err(Error::StaleRef(ref_id.to_string())),
            None => {
                return Err(Error::BridgeUnavailable(
                    "agent_action requires ref for click and fill".into(),
                ))
            }
        }
    }
    let method = match &request.action {
        AgentAction::Click => "click",
        AgentAction::Fill => "fill",
        AgentAction::Press => "press",
    };
    request_bridge(&bridge, &app, request.window.as_deref(), method, &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_inspect<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentInspectRequest,
) -> Result<AgentInspectResponse> {
    let result = request_bridge(
        &bridge,
        &app,
        request.window.as_deref(),
        "inspect",
        &request,
    )?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_screenshot<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentScreenshotRequest,
) -> Result<String> {
    let path = request.path.clone();
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "shot", &request)?;
    screenshot_return_value(result, path.as_deref())
}

#[tauri::command]
pub async fn agent_logs<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentLogRequest,
) -> Result<Vec<AgentLogEntry>> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "logs", &request)?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_events<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentEventsRequest,
) -> Result<Vec<AgentEventEntry>> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "events", &request)?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_windows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WindowInfo>> {
    Ok(collect_windows(&app))
}

#[tauri::command]
pub async fn agent_wait<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentWaitRequest,
) -> Result<AgentWaitResponse> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "wait", &request)?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_state<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentStateRequest,
) -> Result<serde_json::Value> {
    let key = request.key.clone();
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "state", &request)?;
    Ok(match key {
        Some(key) => result.get(&key).cloned().unwrap_or(Value::Null),
        None => result,
    })
}

#[tauri::command]
pub async fn agent_record<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentRecordRequest,
) -> Result<AgentRecordResponse> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "record", &request)?;
    decode_bridge_result(result)
}

fn request_bridge<R: Runtime, T: Serialize>(
    bridge: &AgentBridge,
    app: &AppHandle<R>,
    window: Option<&str>,
    method: &str,
    request: &T,
) -> Result<Value> {
    let params = serde_json::to_value(request)
        .map_err(|_| Error::BridgeUnavailable("failed to serialize agent bridge request".into()))?;
    bridge.request_webview(app, window, method, params)
}

fn snapshot_text_from_bridge(result: Value) -> Result<String> {
    result
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| Error::BridgeUnavailable("snapshot bridge returned no text".into()))
}

fn screenshot_return_value(result: Value, path: Option<&str>) -> Result<String> {
    let data_url = result
        .get("dataUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::BridgeUnavailable("screenshot bridge returned no dataUrl".into()))?;
    let Some(path) = path else {
        return Ok(data_url.to_string());
    };
    write_data_url_to_path(data_url, path)?;
    Ok(path.to_string())
}

fn decode_bridge_result<T: DeserializeOwned>(result: Value) -> Result<T> {
    serde_json::from_value(result)
        .map_err(|_| Error::BridgeUnavailable("malformed bridge result".into()))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_helpers_decode_bridge_results() {
        let screenshot_path = std::env::temp_dir().join(format!(
            "tauri-agent-command-shot-{}.svg",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&screenshot_path);
        let screenshot_path = screenshot_path.to_string_lossy().into_owned();

        assert_eq!(
            snapshot_text_from_bridge(serde_json::json!({"text": "main \"Ducktape\""})).unwrap(),
            "main \"Ducktape\""
        );
        assert_eq!(
            screenshot_return_value(
                serde_json::json!({
                    "dataUrl": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
                    "mime": "image/svg+xml"
                }),
                None,
            )
            .unwrap(),
            "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="
        );
        assert_eq!(
            screenshot_return_value(
                serde_json::json!({
                    "dataUrl": "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
                    "mime": "image/svg+xml"
                }),
                Some(&screenshot_path),
            )
            .unwrap(),
            screenshot_path
        );
        let _ = std::fs::remove_file(&screenshot_path);

        let logs = decode_bridge_result::<Vec<AgentLogEntry>>(serde_json::json!([
            {
                "level": "info",
                "message": "booted",
                "timestamp": "2026-07-06T14:00:00.000Z"
            }
        ]))
        .unwrap();
        assert_eq!(logs[0].message, "booted");
        assert_eq!(logs[0].window, None);
    }

    #[test]
    fn command_helpers_fail_clearly_on_malformed_bridge_results() {
        assert_eq!(
            snapshot_text_from_bridge(serde_json::json!({"value": "missing"}))
                .unwrap_err()
                .to_string(),
            "live bridge unavailable: snapshot bridge returned no text"
        );
        assert_eq!(
            screenshot_return_value(serde_json::json!({"mime": "image/svg+xml"}), None)
                .unwrap_err()
                .to_string(),
            "live bridge unavailable: screenshot bridge returned no dataUrl"
        );
        assert_eq!(
            decode_bridge_result::<Vec<AgentLogEntry>>(serde_json::json!({"level": "info"}))
                .unwrap_err()
                .to_string(),
            "live bridge unavailable: malformed bridge result"
        );
    }
}
