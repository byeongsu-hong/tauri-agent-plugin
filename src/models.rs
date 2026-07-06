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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    pub title: Option<String>,
    pub focused: bool,
    pub visible: bool,
}
