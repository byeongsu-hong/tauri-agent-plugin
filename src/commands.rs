use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, State, WebviewWindow};

use crate::bridge::{AgentBridge, AgentBridgeResponse};
use crate::models::{
    AgentAction, AgentActionRequest, AgentAttachRequest, AgentAttachResponse, AgentBlurRequest,
    AgentCheckRequest, AgentCookiesRequest, AgentCookiesResponse, AgentDialogRequest,
    AgentDragRequest, AgentEvalRequest, AgentEventEntry, AgentEventsRequest, AgentExpectRequest,
    AgentExpectResponse, AgentFindRequest, AgentFindResponse, AgentFocusRequest, AgentHoverRequest,
    AgentInspectRequest, AgentInspectResponse, AgentIpcEntry, AgentIpcRequest,
    AgentLocationRequest, AgentLocationResponse, AgentLogEntry, AgentLogRequest, AgentNetworkEntry,
    AgentNetworkRequest, AgentRecordRequest, AgentRecordResponse, AgentScreenshotRequest,
    AgentScrollRequest, AgentSelectRequest, AgentSnapshotRequest, AgentStateRequest,
    AgentStorageRequest, AgentStorageResponse, AgentStreamRequest, AgentStreamResponse,
    AgentTypeRequest, AgentUploadRequest, AgentWaitRequest, AgentWaitResponse, AgentWindowRequest,
    ScreenshotBackend, WindowAction, WindowInfo,
};
use crate::screenshot::{capture_native_screenshot, write_data_url_to_path};
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
pub async fn agent_find<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentFindRequest,
) -> Result<AgentFindResponse> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "find", &request)?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_action<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentActionRequest,
) -> Result<()> {
    // A malformed ref (not `@N`) is a caller mistake, not a stale snapshot, so
    // report InvalidParams rather than StaleRef — the two imply different fixes
    // (correct the argument vs. re-run tree). `press` may omit the ref entirely,
    // but if it supplies one it must still be well-formed.
    let requires_ref = !matches!(&request.action, AgentAction::Press);
    match request.ref_id.as_deref() {
        Some(ref_id) if ref_id.starts_with('@') => {}
        Some(ref_id) => {
            return Err(Error::InvalidParams(format!(
                "malformed ref {ref_id:?}; refs look like @3 from a tree/find snapshot"
            )))
        }
        None if requires_ref => {
            return Err(Error::InvalidParams(
                "click and fill require a ref from a tree/find snapshot".into(),
            ))
        }
        None => {}
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
pub async fn agent_eval<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentEvalRequest,
) -> Result<Value> {
    request_bridge(&bridge, &app, request.window.as_deref(), "eval", &request)
}

#[tauri::command]
pub async fn agent_select<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentSelectRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "select", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_type<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentTypeRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "type", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_check<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentCheckRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "check", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_upload<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentUploadRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "upload", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_dialog<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentDialogRequest,
) -> Result<Value> {
    request_bridge(&bridge, &app, request.window.as_deref(), "dialog", &request)
}

#[tauri::command]
pub async fn agent_hover<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentHoverRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "hover", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_focus<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentFocusRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "focus", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_blur<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentBlurRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "blur", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_scroll<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentScrollRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "scroll", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_drag<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentDragRequest,
) -> Result<()> {
    request_bridge(&bridge, &app, request.window.as_deref(), "drag", &request)?;
    Ok(())
}

#[tauri::command]
pub async fn agent_screenshot<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentScreenshotRequest,
) -> Result<String> {
    let path = request.path.clone();
    let result = resolve_screenshot(
        effective_screenshot_backend(&request),
        || request_bridge(&bridge, &app, request.window.as_deref(), "shot", &request),
        || capture_native_screenshot_for_request(&app, &request),
    )?;
    screenshot_return_value(result, path.as_deref())
}

/// Element-scoped captures (`ref`) are a DOM-backend concept — the native
/// backend grabs whole-window pixels and cannot crop to a semantic ref — so any
/// request carrying a `ref` is served by the DOM backend regardless of the
/// requested `backend`.
pub(crate) fn effective_screenshot_backend(request: &AgentScreenshotRequest) -> ScreenshotBackend {
    if request.ref_id.is_some() {
        ScreenshotBackend::Dom
    } else {
        request.backend.unwrap_or(ScreenshotBackend::Dom)
    }
}

/// Shared Dom/Native/Auto screenshot dispatch for both the direct command and
/// the inline server. `auto` tries native first, then dom, and — unlike the old
/// paths — surfaces the swallowed native error as context when dom also fails.
pub(crate) fn resolve_screenshot(
    backend: ScreenshotBackend,
    dom: impl FnOnce() -> Result<Value>,
    native: impl FnOnce() -> Result<Value>,
) -> Result<Value> {
    match backend {
        ScreenshotBackend::Dom => dom(),
        ScreenshotBackend::Native => native(),
        ScreenshotBackend::Auto => native().or_else(|native_error| {
            dom().map_err(|dom_error| {
                Error::BridgeUnavailable(format!(
                    "auto screenshot failed: native ({native_error}); dom ({dom_error})"
                ))
            })
        }),
    }
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
pub async fn agent_network<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentNetworkRequest,
) -> Result<Vec<AgentNetworkEntry>> {
    let result = request_bridge(
        &bridge,
        &app,
        request.window.as_deref(),
        "network",
        &request,
    )?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_ipc<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentIpcRequest,
) -> Result<Vec<AgentIpcEntry>> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "ipc", &request)?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_storage<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentStorageRequest,
) -> Result<AgentStorageResponse> {
    let result = request_bridge(
        &bridge,
        &app,
        request.window.as_deref(),
        "storage",
        &request,
    )?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_cookies<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentCookiesRequest,
) -> Result<AgentCookiesResponse> {
    let result = request_bridge(
        &bridge,
        &app,
        request.window.as_deref(),
        "cookies",
        &request,
    )?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_location<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentLocationRequest,
) -> Result<AgentLocationResponse> {
    let result = request_bridge(
        &bridge,
        &app,
        request.window.as_deref(),
        "location",
        &request,
    )?;
    decode_bridge_result(result)
}

#[tauri::command]
pub async fn agent_windows<R: Runtime>(app: AppHandle<R>) -> Result<Vec<WindowInfo>> {
    Ok(collect_windows(&app))
}

#[tauri::command]
pub async fn agent_window<R: Runtime>(
    app: AppHandle<R>,
    request: AgentWindowRequest,
) -> Result<WindowInfo> {
    control_window(&app, request)
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
pub async fn agent_expect<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentExpectRequest,
) -> Result<AgentExpectResponse> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "expect", &request)?;
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

#[tauri::command]
pub async fn agent_stream<R: Runtime>(
    app: AppHandle<R>,
    bridge: State<'_, AgentBridge>,
    request: AgentStreamRequest,
) -> Result<AgentStreamResponse> {
    let result = request_bridge(&bridge, &app, request.window.as_deref(), "stream", &request)?;
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
    let Some(path) = path else {
        if let Some(data_url) = result.get("dataUrl").and_then(Value::as_str) {
            return Ok(data_url.to_string());
        }
        if let Some(path) = result.get("path").and_then(Value::as_str) {
            return Ok(path.to_string());
        }
        return Err(Error::BridgeUnavailable(
            "screenshot bridge returned no dataUrl".into(),
        ));
    };
    if let Some(data_url) = result.get("dataUrl").and_then(Value::as_str) {
        write_data_url_to_path(data_url, path)?;
        return Ok(path.to_string());
    }
    if let Some(path) = result.get("path").and_then(Value::as_str) {
        return Ok(path.to_string());
    }
    Err(Error::BridgeUnavailable(
        "screenshot bridge returned no dataUrl".into(),
    ))
}

pub(crate) fn capture_native_screenshot_for_request<R: Runtime>(
    app: &AppHandle<R>,
    request: &AgentScreenshotRequest,
) -> Result<Value> {
    let window = target_webview_window(app, request.window.as_deref())?;
    capture_native_screenshot(&window, request.path.as_deref())
}

fn decode_bridge_result<T: DeserializeOwned>(result: Value) -> Result<T> {
    serde_json::from_value(result)
        .map_err(|_| Error::BridgeUnavailable("malformed bridge result".into()))
}

pub(crate) fn collect_windows<R: Runtime>(app: &AppHandle<R>) -> Vec<WindowInfo> {
    let mut windows = app
        .webview_windows()
        .into_values()
        .map(|window| window_info(&window))
        .collect::<Vec<_>>();
    // Multi-webview (opt-in `unstable-multiwebview`): surface any child webview
    // that is not itself a webview-window so agents can address it by label.
    // Without the feature this adds nothing and the listing is unchanged.
    windows.extend(child_webview_infos(app));
    windows.sort_by(|a, b| a.label.cmp(&b.label));
    windows
}

/// Resolve the event target for a bridge request. A label matching a
/// webview-window emits to that window; with `unstable-multiwebview`, a label
/// matching a bare child webview emits to that webview; no label falls back to
/// the default window. This is what lets bridge methods address a specific
/// webview within a window.
pub(crate) fn resolve_bridge_event_target<R: Runtime>(
    app: &AppHandle<R>,
    window: Option<&str>,
) -> Result<tauri::EventTarget> {
    if let Some(label) = window {
        if app.webview_windows().contains_key(label) {
            return Ok(tauri::EventTarget::window(label));
        }
        if child_webview_label_exists(app, label) {
            return Ok(tauri::EventTarget::webview(label));
        }
        return Err(Error::WindowNotFound(label.to_string()));
    }
    let target = target_webview_window(app, None)?;
    Ok(tauri::EventTarget::window(target.label().to_string()))
}

#[cfg(feature = "unstable-multiwebview")]
fn child_webview_infos<R: Runtime>(app: &AppHandle<R>) -> Vec<WindowInfo> {
    use tauri::Manager;
    let window_labels: std::collections::HashSet<String> =
        app.webview_windows().keys().cloned().collect();
    app.webviews()
        .into_iter()
        .filter(|(label, _)| !window_labels.contains(label))
        .map(|(_, webview)| {
            let window = webview.window();
            WindowInfo {
                label: webview.label().to_string(),
                title: window.title().ok(),
                focused: window.is_focused().unwrap_or(false),
                visible: window.is_visible().unwrap_or(false),
                minimized: None,
                maximized: None,
                scale_factor: window.scale_factor().ok(),
                inner_bounds: None,
                outer_bounds: None,
            }
        })
        .collect()
}

#[cfg(not(feature = "unstable-multiwebview"))]
fn child_webview_infos<R: Runtime>(_app: &AppHandle<R>) -> Vec<WindowInfo> {
    Vec::new()
}

#[cfg(feature = "unstable-multiwebview")]
pub(crate) fn child_webview_label_exists<R: Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    use tauri::Manager;
    app.webviews().contains_key(label)
}

#[cfg(not(feature = "unstable-multiwebview"))]
pub(crate) fn child_webview_label_exists<R: Runtime>(_app: &AppHandle<R>, _label: &str) -> bool {
    false
}

pub(crate) fn control_window<R: Runtime>(
    app: &AppHandle<R>,
    request: AgentWindowRequest,
) -> Result<WindowInfo> {
    let window = target_webview_window(app, request.window.as_deref())?;
    match request.action.unwrap_or(WindowAction::Get) {
        WindowAction::Get => {}
        WindowAction::Focus => window.set_focus()?,
        WindowAction::Show => window.show()?,
        WindowAction::Hide => window.hide()?,
        WindowAction::Minimize => window.minimize()?,
        WindowAction::Unminimize => window.unminimize()?,
        WindowAction::Maximize => window.maximize()?,
        WindowAction::Unmaximize => window.unmaximize()?,
        WindowAction::SetSize => window.set_size(required_window_size(&request)?)?,
        WindowAction::SetPosition => window.set_position(required_window_position(&request)?)?,
    }
    Ok(window_info(&window))
}

/// Resolve the target webview window. With an explicit label, that window or an
/// error. Without one, prefer a window labelled `main`, then the focused window,
/// then the lexicographically-first label for determinism. Shared by the direct
/// commands and the guest bridge so both surfaces agree on the default.
pub(crate) fn target_webview_window<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<&str>,
) -> Result<WebviewWindow<R>> {
    if let Some(label) = label {
        return app
            .get_webview_window(label)
            .ok_or_else(|| Error::WindowNotFound(label.to_string()));
    }

    let windows = app.webview_windows();
    if let Some(main) = windows.get("main") {
        return Ok(main.clone());
    }

    let mut sorted = windows.into_values().collect::<Vec<_>>();
    sorted.sort_by(|a, b| a.label().cmp(b.label()));
    if let Some(focused) = sorted
        .iter()
        .find(|window| window.is_focused().unwrap_or(false))
    {
        return Ok(focused.clone());
    }
    sorted
        .into_iter()
        .next()
        .ok_or_else(|| Error::WindowNotFound("main".into()))
}

fn required_window_size(request: &AgentWindowRequest) -> Result<PhysicalSize<u32>> {
    let width = request
        .width
        .filter(|width| *width > 0)
        .ok_or_else(|| Error::InvalidParams("window setSize requires positive width".into()))?;
    let height = request
        .height
        .filter(|height| *height > 0)
        .ok_or_else(|| Error::InvalidParams("window setSize requires positive height".into()))?;
    Ok(PhysicalSize { width, height })
}

fn required_window_position(request: &AgentWindowRequest) -> Result<PhysicalPosition<i32>> {
    let x = request
        .x
        .ok_or_else(|| Error::InvalidParams("window setPosition requires x".into()))?;
    let y = request
        .y
        .ok_or_else(|| Error::InvalidParams("window setPosition requires y".into()))?;
    Ok(PhysicalPosition { x, y })
}

fn window_info<R: Runtime>(window: &WebviewWindow<R>) -> WindowInfo {
    WindowInfo {
        label: window.label().to_string(),
        title: window.title().ok(),
        focused: window.is_focused().unwrap_or(false),
        visible: window.is_visible().unwrap_or(false),
        minimized: window.is_minimized().ok(),
        maximized: window.is_maximized().ok(),
        scale_factor: window.scale_factor().ok(),
        inner_bounds: window_bounds(window.inner_position().ok(), window.inner_size().ok()),
        outer_bounds: window_bounds(window.outer_position().ok(), window.outer_size().ok()),
    }
}

fn window_bounds(
    position: Option<PhysicalPosition<i32>>,
    size: Option<PhysicalSize<u32>>,
) -> Option<crate::models::WindowBounds> {
    let (position, size) = (position?, size?);
    Some(crate::models::WindowBounds {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

pub(crate) fn ensure_window<R: Runtime>(app: &AppHandle<R>, label: Option<&str>) -> Result<()> {
    if let Some(label) = label {
        // Accept webview-window labels, plus bare child-webview labels when the
        // `unstable-multiwebview` feature is enabled.
        if !app.webview_windows().contains_key(label) && !child_webview_label_exists(app, label) {
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
            screenshot_return_value(
                serde_json::json!({"mime": "image/svg+xml"}),
                Some("/tmp/missing.svg"),
            )
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

    mod runtime {
        use super::*;
        use tauri::test::{mock_builder, mock_context, noop_assets};
        use tauri::{WebviewUrl, WebviewWindowBuilder};

        fn app_with_windows(labels: &[&str]) -> tauri::App<tauri::test::MockRuntime> {
            let app = mock_builder()
                .build(mock_context(noop_assets()))
                .expect("mock app builds");
            for label in labels {
                WebviewWindowBuilder::new(&app, *label, WebviewUrl::default())
                    .build()
                    .expect("window builds");
            }
            app
        }

        #[test]
        fn target_prefers_the_main_window() {
            let app = app_with_windows(&["about", "main", "zeta"]);
            let target = target_webview_window(app.handle(), None).unwrap();
            assert_eq!(target.label(), "main");
        }

        #[test]
        fn target_without_main_falls_back_to_first_label() {
            let app = app_with_windows(&["zeta", "about"]);
            let target = target_webview_window(app.handle(), None).unwrap();
            assert_eq!(target.label(), "about");
        }

        #[test]
        fn target_reports_missing_labels() {
            let app = app_with_windows(&["main"]);
            assert!(matches!(
                target_webview_window(app.handle(), Some("nope")),
                Err(Error::WindowNotFound(_))
            ));
        }

        #[test]
        fn resolve_bridge_event_target_uses_the_window_for_a_known_label() {
            let app = app_with_windows(&["main", "about"]);
            // A known window label resolves without error; the default (None)
            // resolves to the preferred `main` window.
            assert!(resolve_bridge_event_target(app.handle(), Some("about")).is_ok());
            assert!(resolve_bridge_event_target(app.handle(), None).is_ok());
        }

        #[test]
        fn resolve_bridge_event_target_rejects_unknown_labels() {
            let app = app_with_windows(&["main"]);
            // Without the `unstable-multiwebview` feature there are no child
            // webviews, so an unknown label is a hard WindowNotFound.
            assert!(matches!(
                resolve_bridge_event_target(app.handle(), Some("ghost")),
                Err(Error::WindowNotFound(_))
            ));
        }

        #[test]
        fn collect_windows_returns_sorted_labels() {
            let app = app_with_windows(&["main", "about"]);
            let labels: Vec<_> = collect_windows(app.handle())
                .into_iter()
                .map(|window| window.label)
                .collect();
            assert_eq!(labels, vec!["about", "main"]);
        }

        #[test]
        fn control_window_rejects_setsize_without_dimensions() {
            let app = app_with_windows(&["main"]);
            let error = control_window(
                app.handle(),
                AgentWindowRequest {
                    window: Some("main".into()),
                    action: Some(WindowAction::SetSize),
                    width: None,
                    height: None,
                    x: None,
                    y: None,
                },
            )
            .unwrap_err();
            assert!(matches!(error, Error::InvalidParams(_)));
        }
    }
}
