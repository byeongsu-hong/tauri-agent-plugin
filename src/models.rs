use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Enables future release-build socket support. The v0 scaffold does not open a socket.
    #[serde(default)]
    pub allow_release_socket: bool,
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
    pub ref_id: String,
    pub action: AgentAction,
    pub value: Option<String>,
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

        let record = AgentRecordRequest {
            window: None,
            action: Some(RecordAction::Start),
        };
        assert_eq!(
            serde_json::to_value(record).unwrap(),
            serde_json::json!({"window": null, "action": "start"})
        );
    }
}
