use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Discovery record for the human-facing VNC/noVNC visual surface. The plugin
/// only advertises where the stream lives; the VNC server itself (for example
/// `x11vnc`/`websockify` against the app's virtual display) is run by the
/// surrounding harness.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncEndpoint {
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub novnc_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum AgentEndpointDescriptor {
    #[serde(rename = "unix")]
    #[serde(rename_all = "camelCase")]
    Unix {
        app_id: String,
        pid: u32,
        path: PathBuf,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vnc: Option<VncEndpoint>,
    },
    #[serde(rename = "tcp")]
    #[serde(rename_all = "camelCase")]
    Tcp {
        app_id: String,
        pid: u32,
        host: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vnc: Option<VncEndpoint>,
    },
}

impl AgentEndpointDescriptor {
    pub fn unix(app_id: impl Into<String>, pid: u32, path: PathBuf) -> Self {
        Self::Unix {
            app_id: app_id.into(),
            pid,
            path,
            vnc: None,
        }
    }

    pub fn tcp(app_id: impl Into<String>, pid: u32, host: impl Into<String>, port: u16) -> Self {
        Self::Tcp {
            app_id: app_id.into(),
            pid,
            host: host.into(),
            port,
            vnc: None,
        }
    }

    pub fn app_id(&self) -> &str {
        match self {
            Self::Unix { app_id, .. } | Self::Tcp { app_id, .. } => app_id,
        }
    }

    /// The advertised VNC surface, if this app publishes one.
    pub fn vnc(&self) -> Option<&VncEndpoint> {
        match self {
            Self::Unix { vnc, .. } | Self::Tcp { vnc, .. } => vnc.as_ref(),
        }
    }

    /// Attach (or clear) the advertised VNC surface, consuming self.
    pub fn with_vnc(mut self, endpoint: Option<VncEndpoint>) -> Self {
        match &mut self {
            Self::Unix { vnc, .. } | Self::Tcp { vnc, .. } => *vnc = endpoint,
        }
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EndpointRegistryError {
    #[error("endpoint registry not found for app: {0}")]
    NotFound(String),
    #[error("endpoint registry I/O error at {path:?}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("invalid endpoint registry at {path:?}: {source}")]
    Json {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
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

pub fn write_endpoint_registry(
    descriptor: &AgentEndpointDescriptor,
    runtime_base: Option<PathBuf>,
) -> Result<(), EndpointRegistryError> {
    let runtime_dir = endpoint_runtime_dir(descriptor.app_id(), runtime_base.clone());
    std::fs::create_dir_all(&runtime_dir).map_err(|source| EndpointRegistryError::Io {
        path: runtime_dir.clone(),
        source,
    })?;

    let path = endpoint_registry_path(descriptor.app_id(), runtime_base);
    let contents =
        serde_json::to_string_pretty(descriptor).map_err(|source| EndpointRegistryError::Json {
            path: path.clone(),
            source,
        })?;
    std::fs::write(&path, format!("{contents}\n")).map_err(|source| EndpointRegistryError::Io {
        path: path.clone(),
        source,
    })
}

pub fn read_endpoint_registry(
    app_id: &str,
    runtime_base: Option<PathBuf>,
) -> Result<AgentEndpointDescriptor, EndpointRegistryError> {
    let path = endpoint_registry_path(app_id, runtime_base);
    let contents = std::fs::read_to_string(&path).map_err(|source| {
        if source.kind() == std::io::ErrorKind::NotFound {
            EndpointRegistryError::NotFound(app_id.to_string())
        } else {
            EndpointRegistryError::Io {
                path: path.clone(),
                source,
            }
        }
    })?;

    serde_json::from_str(&contents).map_err(|source| EndpointRegistryError::Json { path, source })
}

pub fn remove_endpoint_registry(
    app_id: &str,
    runtime_base: Option<PathBuf>,
) -> Result<(), EndpointRegistryError> {
    let path = endpoint_registry_path(app_id, runtime_base);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(EndpointRegistryError::Io { path, source }),
    }
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
