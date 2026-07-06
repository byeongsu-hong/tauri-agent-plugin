use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Allows the inline debugger server to bind a local socket in release builds.
    #[serde(default)]
    pub allow_release_socket: bool,
    #[serde(default)]
    pub inline_server: InlineServerConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineServerConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_inline_server_host")]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default = "default_publish_endpoint")]
    pub publish_endpoint: bool,
}

impl Default for InlineServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: default_inline_server_host(),
            port: 0,
            publish_endpoint: default_publish_endpoint(),
        }
    }
}

fn default_inline_server_host() -> String {
    "127.0.0.1".into()
}

fn default_publish_endpoint() -> bool {
    true
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachRequest {
    pub app: Option<String>,
    pub window: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachResponse {
    pub attached: bool,
    pub windows: Vec<WindowInfo>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWindowRequest {
    pub window: Option<String>,
    pub action: Option<WindowAction>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowAction {
    Get,
    Focus,
    Show,
    Hide,
    Minimize,
    Unminimize,
    Maximize,
    Unmaximize,
    SetSize,
    SetPosition,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshotRequest {
    pub window: Option<String>,
    pub scope: Option<String>,
    pub mode: Option<SnapshotMode>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SnapshotMode {
    #[default]
    Compact,
    Verbose,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActionRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: Option<String>,
    pub action: AgentAction,
    pub value: Option<String>,
    pub modifiers: Option<Vec<KeyModifier>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFindRequest {
    pub window: Option<String>,
    pub scope: Option<String>,
    pub role: Option<String>,
    pub name: Option<String>,
    pub text: Option<String>,
    pub limit: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInspectRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInspectResponse {
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub role: String,
    pub name: String,
    pub tag_name: String,
    pub text: String,
    pub value: Option<String>,
    pub attributes: BTreeMap<String, String>,
    pub states: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFindResponse {
    pub matches: Vec<AgentInspectResponse>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvalRequest {
    pub window: Option<String>,
    pub code: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelectRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub value: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCheckRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub checked: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHoverRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentFocusRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBlurRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScrollRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDragRequest {
    pub window: Option<String>,
    #[serde(rename = "ref")]
    pub ref_id: String,
    pub to_ref: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentAction {
    Click,
    Fill,
    Press,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "PascalCase")]
pub enum KeyModifier {
    Alt,
    Control,
    Meta,
    Shift,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScreenshotRequest {
    pub window: Option<String>,
    pub path: Option<String>,
    pub backend: Option<ScreenshotBackend>,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScreenshotBackend {
    Dom,
    Native,
    Auto,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogRequest {
    pub window: Option<String>,
    pub follow: Option<bool>,
    pub clear: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogEntry {
    pub level: String,
    pub message: String,
    pub timestamp: String,
    pub window: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventsRequest {
    pub window: Option<String>,
    pub follow: Option<bool>,
    pub clear: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNetworkRequest {
    pub window: Option<String>,
    pub follow: Option<bool>,
    pub clear: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentNetworkEntry {
    pub id: String,
    #[serde(rename = "type")]
    pub entry_type: String,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub ok: Option<bool>,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub duration_ms: Option<f64>,
    pub request_body_size: Option<u64>,
    pub response_body_size: Option<u64>,
    pub error: Option<String>,
    pub window: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStorageRequest {
    pub window: Option<String>,
    pub area: Option<StorageArea>,
    pub action: Option<StorageAction>,
    pub key: Option<String>,
    pub value: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageArea {
    #[default]
    Local,
    Session,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StorageAction {
    #[default]
    Get,
    Set,
    Remove,
    Clear,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStorageEntry {
    pub area: StorageArea,
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStorageResponse {
    pub area: StorageArea,
    pub entries: Vec<AgentStorageEntry>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCookiesRequest {
    pub window: Option<String>,
    pub action: Option<CookieAction>,
    pub name: Option<String>,
    pub value: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CookieAction {
    #[default]
    Get,
    Set,
    Remove,
    Clear,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCookieEntry {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCookiesResponse {
    pub entries: Vec<AgentCookieEntry>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocationRequest {
    pub window: Option<String>,
    pub action: Option<LocationAction>,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LocationAction {
    #[default]
    Get,
    Push,
    Replace,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLocationResponse {
    pub href: String,
    pub origin: String,
    pub pathname: String,
    pub search: String,
    pub hash: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEventEntry {
    pub kind: String,
    pub timestamp: String,
    pub window: Option<String>,
    pub detail: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWaitRequest {
    pub window: Option<String>,
    pub text: Option<String>,
    pub scope: Option<String>,
    pub role: Option<String>,
    pub name: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWaitResponse {
    pub matched: bool,
    pub text: String,
    #[serde(rename = "match", skip_serializing_if = "Option::is_none")]
    pub match_entry: Option<AgentInspectResponse>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStateRequest {
    pub window: Option<String>,
    pub key: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecordRequest {
    pub window: Option<String>,
    pub action: Option<RecordAction>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecordAction {
    Start,
    Stop,
    #[default]
    Get,
    Clear,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecordEntry {
    pub method: String,
    pub params: Option<serde_json::Value>,
    pub timestamp: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecordResponse {
    pub recording: bool,
    pub entries: Vec<AgentRecordEntry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    pub title: Option<String>,
    pub focused: bool,
    pub visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximized: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inner_bounds: Option<WindowBounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outer_bounds: Option<WindowBounds>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_headless_debugger_models_with_camel_case_fields() {
        let config = Config::default();
        assert!(!config.inline_server.enabled);
        assert_eq!(config.inline_server.host, "127.0.0.1");
        assert_eq!(config.inline_server.port, 0);
        assert!(config.inline_server.publish_endpoint);

        let parsed: Config = serde_json::from_value(serde_json::json!({
            "inlineServer": {
                "enabled": true,
                "port": 45127
            }
        }))
        .unwrap();
        assert!(parsed.inline_server.enabled);
        assert_eq!(parsed.inline_server.host, "127.0.0.1");
        assert_eq!(parsed.inline_server.port, 45127);

        let window = WindowInfo {
            label: "main".into(),
            title: Some("Fixture".into()),
            focused: true,
            visible: true,
            minimized: Some(false),
            maximized: Some(false),
            scale_factor: Some(2.0),
            inner_bounds: Some(WindowBounds {
                x: 10,
                y: 20,
                width: 800,
                height: 600,
            }),
            outer_bounds: Some(WindowBounds {
                x: 4,
                y: 12,
                width: 824,
                height: 648,
            }),
        };
        assert_eq!(
            serde_json::to_value(window).unwrap(),
            serde_json::json!({
                "label": "main",
                "title": "Fixture",
                "focused": true,
                "visible": true,
                "minimized": false,
                "maximized": false,
                "scaleFactor": 2.0,
                "innerBounds": {"x": 10, "y": 20, "width": 800, "height": 600},
                "outerBounds": {"x": 4, "y": 12, "width": 824, "height": 648}
            })
        );

        let window_request = AgentWindowRequest {
            window: Some("main".into()),
            action: Some(WindowAction::SetSize),
            x: None,
            y: None,
            width: Some(800),
            height: Some(600),
        };
        assert_eq!(
            serde_json::to_value(window_request).unwrap(),
            serde_json::json!({
                "window": "main",
                "action": "setSize",
                "x": null,
                "y": null,
                "width": 800,
                "height": 600
            })
        );

        let attach = AgentAttachRequest {
            app: Some("ducktape".into()),
            window: Some("main".into()),
        };
        assert_eq!(
            serde_json::to_value(attach).unwrap(),
            serde_json::json!({"app": "ducktape", "window": "main"})
        );

        let wait = AgentWaitRequest {
            window: Some("main".into()),
            text: Some("Registered".into()),
            scope: None,
            role: None,
            name: None,
            timeout_ms: Some(250),
        };
        assert_eq!(
            serde_json::to_value(wait).unwrap(),
            serde_json::json!({
                "window": "main",
                "text": "Registered",
                "scope": null,
                "role": null,
                "name": null,
                "timeoutMs": 250
            })
        );

        let semantic_wait = AgentWaitRequest {
            window: Some("main".into()),
            text: None,
            scope: Some("main".into()),
            role: Some("button".into()),
            name: Some("Forge".into()),
            timeout_ms: Some(250),
        };
        assert_eq!(
            serde_json::to_value(semantic_wait).unwrap(),
            serde_json::json!({
                "window": "main",
                "text": null,
                "scope": "main",
                "role": "button",
                "name": "Forge",
                "timeoutMs": 250
            })
        );

        let find = AgentFindRequest {
            window: Some("main".into()),
            scope: Some("main".into()),
            role: Some("button".into()),
            name: Some("Forge".into()),
            text: None,
            limit: Some(1),
        };
        assert_eq!(
            serde_json::to_value(find).unwrap(),
            serde_json::json!({
                "window": "main",
                "scope": "main",
                "role": "button",
                "name": "Forge",
                "text": null,
                "limit": 1
            })
        );

        let find_response = AgentFindResponse {
            matches: vec![AgentInspectResponse {
                ref_id: "@1".into(),
                role: "button".into(),
                name: "Forge".into(),
                tag_name: "button".into(),
                text: "Forge".into(),
                value: None,
                attributes: BTreeMap::new(),
                states: Vec::new(),
            }],
        };
        assert_eq!(
            serde_json::to_value(find_response).unwrap(),
            serde_json::json!({
                "matches": [{
                    "ref": "@1",
                    "role": "button",
                    "name": "Forge",
                    "tagName": "button",
                    "text": "Forge",
                    "value": null,
                    "attributes": {},
                    "states": []
                }]
            })
        );

        let semantic_wait_response = AgentWaitResponse {
            matched: true,
            text: "Forge".into(),
            match_entry: Some(AgentInspectResponse {
                ref_id: "@1".into(),
                role: "button".into(),
                name: "Forge".into(),
                tag_name: "button".into(),
                text: "Forge".into(),
                value: None,
                attributes: BTreeMap::new(),
                states: Vec::new(),
            }),
        };
        assert_eq!(
            serde_json::to_value(semantic_wait_response).unwrap(),
            serde_json::json!({
                "matched": true,
                "text": "Forge",
                "match": {
                    "ref": "@1",
                    "role": "button",
                    "name": "Forge",
                    "tagName": "button",
                    "text": "Forge",
                    "value": null,
                    "attributes": {},
                    "states": []
                }
            })
        );

        let inspect = AgentInspectRequest {
            window: Some("main".into()),
            ref_id: "@4".into(),
        };
        assert_eq!(
            serde_json::to_value(inspect).unwrap(),
            serde_json::json!({"window": "main", "ref": "@4"})
        );

        let eval = AgentEvalRequest {
            window: Some("main".into()),
            code: "document.title".into(),
        };
        assert_eq!(
            serde_json::to_value(eval).unwrap(),
            serde_json::json!({"window": "main", "code": "document.title"})
        );

        let select = AgentSelectRequest {
            window: Some("main".into()),
            ref_id: "@4".into(),
            value: Some("remote".into()),
        };
        assert_eq!(
            serde_json::to_value(select).unwrap(),
            serde_json::json!({"window": "main", "ref": "@4", "value": "remote"})
        );

        let check = AgentCheckRequest {
            window: Some("main".into()),
            ref_id: "@6".into(),
            checked: Some(true),
        };
        assert_eq!(
            serde_json::to_value(check).unwrap(),
            serde_json::json!({"window": "main", "ref": "@6", "checked": true})
        );

        let hover = AgentHoverRequest {
            window: Some("main".into()),
            ref_id: "@1".into(),
        };
        assert_eq!(
            serde_json::to_value(hover).unwrap(),
            serde_json::json!({"window": "main", "ref": "@1"})
        );

        let focus = AgentFocusRequest {
            window: Some("main".into()),
            ref_id: "@2".into(),
        };
        assert_eq!(
            serde_json::to_value(focus).unwrap(),
            serde_json::json!({"window": "main", "ref": "@2"})
        );

        let blur = AgentBlurRequest {
            window: Some("main".into()),
            ref_id: "@2".into(),
        };
        assert_eq!(
            serde_json::to_value(blur).unwrap(),
            serde_json::json!({"window": "main", "ref": "@2"})
        );

        let scroll = AgentScrollRequest {
            window: Some("main".into()),
            ref_id: "@7".into(),
            x: Some(3.0),
            y: Some(12.0),
        };
        assert_eq!(
            serde_json::to_value(scroll).unwrap(),
            serde_json::json!({"window": "main", "ref": "@7", "x": 3.0, "y": 12.0})
        );

        let drag = AgentDragRequest {
            window: Some("main".into()),
            ref_id: "@1".into(),
            to_ref: Some("@8".into()),
        };
        assert_eq!(
            serde_json::to_value(drag).unwrap(),
            serde_json::json!({"window": "main", "ref": "@1", "toRef": "@8"})
        );

        let record = AgentRecordRequest {
            window: None,
            action: Some(RecordAction::Start),
        };
        assert_eq!(
            serde_json::to_value(record).unwrap(),
            serde_json::json!({"window": null, "action": "start"})
        );

        let logs = AgentLogRequest {
            window: Some("main".into()),
            follow: Some(true),
            clear: Some(true),
        };
        assert_eq!(
            serde_json::to_value(logs).unwrap(),
            serde_json::json!({"window": "main", "follow": true, "clear": true})
        );

        let events = AgentEventsRequest {
            window: Some("main".into()),
            follow: Some(true),
            clear: Some(true),
        };
        assert_eq!(
            serde_json::to_value(events).unwrap(),
            serde_json::json!({"window": "main", "follow": true, "clear": true})
        );

        let network = AgentNetworkRequest {
            window: Some("main".into()),
            follow: Some(true),
            clear: Some(true),
        };
        assert_eq!(
            serde_json::to_value(network).unwrap(),
            serde_json::json!({"window": "main", "follow": true, "clear": true})
        );

        let network_entry = AgentNetworkEntry {
            id: "fetch-1".into(),
            entry_type: "fetch".into(),
            method: "POST".into(),
            url: "https://example.test/api/agents".into(),
            status: Some(201),
            ok: Some(true),
            started_at: "2026-07-07T00:00:00.000Z".into(),
            ended_at: Some("2026-07-07T00:00:00.050Z".into()),
            duration_ms: Some(50.0),
            request_body_size: Some(8),
            response_body_size: Some(11),
            error: None,
            window: Some("main".into()),
        };
        assert_eq!(
            serde_json::to_value(network_entry).unwrap(),
            serde_json::json!({
                "id": "fetch-1",
                "type": "fetch",
                "method": "POST",
                "url": "https://example.test/api/agents",
                "status": 201,
                "ok": true,
                "startedAt": "2026-07-07T00:00:00.000Z",
                "endedAt": "2026-07-07T00:00:00.050Z",
                "durationMs": 50.0,
                "requestBodySize": 8,
                "responseBodySize": 11,
                "error": null,
                "window": "main"
            })
        );

        let storage = AgentStorageRequest {
            window: Some("main".into()),
            area: Some(StorageArea::Session),
            action: Some(StorageAction::Set),
            key: Some("agent.route".into()),
            value: Some("/agents".into()),
        };
        assert_eq!(
            serde_json::to_value(storage).unwrap(),
            serde_json::json!({
                "window": "main",
                "area": "session",
                "action": "set",
                "key": "agent.route",
                "value": "/agents"
            })
        );

        let storage_response = AgentStorageResponse {
            area: StorageArea::Session,
            entries: vec![AgentStorageEntry {
                area: StorageArea::Session,
                key: "agent.route".into(),
                value: "/agents".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(storage_response).unwrap(),
            serde_json::json!({
                "area": "session",
                "entries": [{
                    "area": "session",
                    "key": "agent.route",
                    "value": "/agents"
                }]
            })
        );

        let cookies = AgentCookiesRequest {
            window: Some("main".into()),
            action: Some(CookieAction::Set),
            name: Some("agent.cookie".into()),
            value: Some("ready".into()),
        };
        assert_eq!(
            serde_json::to_value(cookies).unwrap(),
            serde_json::json!({
                "window": "main",
                "action": "set",
                "name": "agent.cookie",
                "value": "ready"
            })
        );

        let cookies_response = AgentCookiesResponse {
            entries: vec![AgentCookieEntry {
                name: "agent.cookie".into(),
                value: "ready".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(cookies_response).unwrap(),
            serde_json::json!({
                "entries": [{
                    "name": "agent.cookie",
                    "value": "ready"
                }]
            })
        );

        let location = AgentLocationRequest {
            window: Some("main".into()),
            action: Some(LocationAction::Push),
            url: Some("/agents?view=debug#roster".into()),
        };
        assert_eq!(
            serde_json::to_value(location).unwrap(),
            serde_json::json!({
                "window": "main",
                "action": "push",
                "url": "/agents?view=debug#roster"
            })
        );

        let location_response = AgentLocationResponse {
            href: "tauri-agent://static/agents?view=debug#roster".into(),
            origin: "null".into(),
            pathname: "/agents".into(),
            search: "?view=debug".into(),
            hash: "#roster".into(),
        };
        assert_eq!(
            serde_json::to_value(location_response).unwrap(),
            serde_json::json!({
                "href": "tauri-agent://static/agents?view=debug#roster",
                "origin": "null",
                "pathname": "/agents",
                "search": "?view=debug",
                "hash": "#roster"
            })
        );

        let screenshot = AgentScreenshotRequest {
            window: Some("main".into()),
            path: Some("/tmp/app.png".into()),
            backend: Some(ScreenshotBackend::Native),
        };
        assert_eq!(
            serde_json::to_value(screenshot).unwrap(),
            serde_json::json!({
                "window": "main",
                "path": "/tmp/app.png",
                "backend": "native"
            })
        );

        let press = AgentActionRequest {
            window: Some("main".into()),
            ref_id: Some("@2".into()),
            action: AgentAction::Press,
            value: Some("Enter".into()),
            modifiers: Some(vec![KeyModifier::Meta, KeyModifier::Shift]),
        };
        assert_eq!(
            serde_json::to_value(press).unwrap(),
            serde_json::json!({
                "window": "main",
                "ref": "@2",
                "action": "press",
                "value": "Enter",
                "modifiers": ["Meta", "Shift"]
            })
        );
    }
}
