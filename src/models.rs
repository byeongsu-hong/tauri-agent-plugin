use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Enables future release-build socket support. The v0 scaffold does not open a socket.
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
pub enum AgentAction {
    Click,
    Fill,
    Press,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentScreenshotRequest {
    pub window: Option<String>,
    pub path: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLogRequest {
    pub window: Option<String>,
    pub follow: Option<bool>,
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
    pub text: String,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentWaitResponse {
    pub matched: bool,
    pub text: String,
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
            text: "Registered".into(),
            timeout_ms: Some(250),
        };
        assert_eq!(
            serde_json::to_value(wait).unwrap(),
            serde_json::json!({"window": "main", "text": "Registered", "timeoutMs": 250})
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

        let record = AgentRecordRequest {
            window: None,
            action: Some(RecordAction::Start),
        };
        assert_eq!(
            serde_json::to_value(record).unwrap(),
            serde_json::json!({"window": null, "action": "start"})
        );

        let press = AgentActionRequest {
            window: Some("main".into()),
            ref_id: None,
            action: AgentAction::Press,
            value: Some("Enter".into()),
        };
        assert_eq!(
            serde_json::to_value(press).unwrap(),
            serde_json::json!({
                "window": "main",
                "ref": null,
                "action": "press",
                "value": "Enter"
            })
        );
    }
}
