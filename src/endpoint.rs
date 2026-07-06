use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum AgentEndpointDescriptor {
    #[serde(rename = "unix")]
    #[serde(rename_all = "camelCase")]
    Unix {
        app_id: String,
        pid: u32,
        path: PathBuf,
    },
    #[serde(rename = "tcp")]
    #[serde(rename_all = "camelCase")]
    Tcp {
        app_id: String,
        pid: u32,
        host: String,
        port: u16,
    },
}

impl AgentEndpointDescriptor {
    pub fn unix(app_id: impl Into<String>, pid: u32, path: PathBuf) -> Self {
        Self::Unix {
            app_id: app_id.into(),
            pid,
            path,
        }
    }

    pub fn tcp(app_id: impl Into<String>, pid: u32, host: impl Into<String>, port: u16) -> Self {
        Self::Tcp {
            app_id: app_id.into(),
            pid,
            host: host.into(),
            port,
        }
    }
}

pub fn endpoint_runtime_dir(app_id: &str, runtime_base: Option<PathBuf>) -> PathBuf {
    runtime_base
        .unwrap_or_else(default_runtime_base)
        .join("tauri-agent")
        .join(safe_app_id(app_id))
}

pub fn endpoint_registry_path(app_id: &str, runtime_base: Option<PathBuf>) -> PathBuf {
    endpoint_runtime_dir(app_id, runtime_base).join("endpoint.json")
}

fn default_runtime_base() -> PathBuf {
    std::env::var_os("XDG_RUNTIME_DIR")
        .or_else(|| std::env::var_os("TMPDIR"))
        .or_else(|| std::env::var_os("TEMP"))
        .or_else(|| std::env::var_os("TMP"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

fn safe_app_id(app_id: &str) -> String {
    app_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}
