use std::path::PathBuf;

use serde::{Deserialize, Deserializer, Serialize};

/// Discovery record for the human-facing VNC/noVNC visual surface. The plugin
/// only advertises where the stream lives; the VNC server itself (for example
/// `x11vnc`/`websockify` against the app's virtual display) is run by the
/// surrounding harness.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VncEndpoint {
    #[serde(deserialize_with = "deserialize_non_empty_string")]
    pub host: String,
    #[serde(deserialize_with = "deserialize_positive_u16")]
    pub port: u16,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_non_empty_string"
    )]
    pub novnc_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "transport", rename_all = "camelCase")]
pub enum AgentEndpointDescriptor {
    #[serde(rename = "unix")]
    #[serde(rename_all = "camelCase")]
    Unix {
        #[serde(deserialize_with = "deserialize_non_empty_string")]
        app_id: String,
        #[serde(deserialize_with = "deserialize_positive_u32")]
        pid: u32,
        #[serde(deserialize_with = "deserialize_non_empty_path")]
        path: PathBuf,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_optional_non_empty_string"
        )]
        token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vnc: Option<VncEndpoint>,
    },
    #[serde(rename = "tcp")]
    #[serde(rename_all = "camelCase")]
    Tcp {
        #[serde(deserialize_with = "deserialize_non_empty_string")]
        app_id: String,
        #[serde(deserialize_with = "deserialize_positive_u32")]
        pid: u32,
        #[serde(deserialize_with = "deserialize_non_empty_string")]
        host: String,
        #[serde(deserialize_with = "deserialize_positive_u16")]
        port: u16,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "deserialize_optional_non_empty_string"
        )]
        token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vnc: Option<VncEndpoint>,
    },
}

fn deserialize_non_empty_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    if value.trim().is_empty() {
        return Err(serde::de::Error::custom("expected a non-empty string"));
    }
    Ok(value)
}

fn deserialize_optional_non_empty_string<'de, D>(
    deserializer: D,
) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<String>::deserialize(deserializer)?;
    if value
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(serde::de::Error::custom("expected a non-empty string"));
    }
    Ok(value)
}

fn deserialize_positive_u16<'de, D>(deserializer: D) -> Result<u16, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u16::deserialize(deserializer)?;
    if value == 0 {
        return Err(serde::de::Error::custom("expected a positive integer"));
    }
    Ok(value)
}

fn deserialize_positive_u32<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let value = u32::deserialize(deserializer)?;
    if value == 0 {
        return Err(serde::de::Error::custom("expected a positive integer"));
    }
    Ok(value)
}

fn deserialize_non_empty_path<'de, D>(deserializer: D) -> Result<PathBuf, D::Error>
where
    D: Deserializer<'de>,
{
    let value = PathBuf::deserialize(deserializer)?;
    if value.to_string_lossy().trim().is_empty() {
        return Err(serde::de::Error::custom("expected a non-empty path"));
    }
    Ok(value)
}

impl AgentEndpointDescriptor {
    pub fn unix(app_id: impl Into<String>, pid: u32, path: PathBuf) -> Self {
        Self::Unix {
            app_id: app_id.into(),
            pid,
            path,
            token: None,
            vnc: None,
        }
    }

    pub fn tcp(app_id: impl Into<String>, pid: u32, host: impl Into<String>, port: u16) -> Self {
        Self::Tcp {
            app_id: app_id.into(),
            pid,
            host: host.into(),
            port,
            token: None,
            vnc: None,
        }
    }

    pub fn app_id(&self) -> &str {
        match self {
            Self::Unix { app_id, .. } | Self::Tcp { app_id, .. } => app_id,
        }
    }

    /// The per-session auth token a client must present, if this server requires one.
    pub fn token(&self) -> Option<&str> {
        match self {
            Self::Unix { token, .. } | Self::Tcp { token, .. } => token.as_deref(),
        }
    }

    /// Attach (or clear) the required auth token, consuming self.
    pub fn with_token(mut self, value: Option<String>) -> Self {
        match &mut self {
            Self::Unix { token, .. } | Self::Tcp { token, .. } => *token = value,
        }
        self
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
    #[error("endpoint registry app id mismatch at {path:?}: expected {expected}, found {actual}")]
    AppIdMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
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

    // Write to a pid-scoped temp file, tighten permissions, then atomically
    // rename into place so a concurrent reader never observes partial JSON.
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    let write_result = std::fs::write(&tmp, format!("{contents}\n"))
        .map_err(|source| EndpointRegistryError::Io {
            path: tmp.clone(),
            source,
        })
        .and_then(|()| restrict_registry_permissions(&tmp))
        .and_then(|()| {
            std::fs::rename(&tmp, &path).map_err(|source| EndpointRegistryError::Io {
                path: path.clone(),
                source,
            })
        });
    if write_result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    write_result
}

/// Restrict the registry file to owner-only read/write so the embedded auth
/// token is not world-readable. No-op on non-Unix platforms, where the user
/// temp/runtime directory is already per-user.
#[cfg(unix)]
fn restrict_registry_permissions(path: &std::path::Path) -> Result<(), EndpointRegistryError> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|source| {
        EndpointRegistryError::Io {
            path: path.to_path_buf(),
            source,
        }
    })
}

#[cfg(not(unix))]
fn restrict_registry_permissions(_path: &std::path::Path) -> Result<(), EndpointRegistryError> {
    Ok(())
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

    let descriptor =
        serde_json::from_str::<AgentEndpointDescriptor>(&contents).map_err(|source| {
            EndpointRegistryError::Json {
                path: path.clone(),
                source,
            }
        })?;
    if descriptor.app_id() != app_id {
        return Err(EndpointRegistryError::AppIdMismatch {
            path,
            expected: app_id.to_string(),
            actual: descriptor.app_id().to_string(),
        });
    }
    Ok(descriptor)
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
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    if app_id.is_empty() {
        return "~".to_string();
    }
    let encode_dots = app_id.bytes().all(|byte| byte == b'.');
    let mut encoded = String::with_capacity(app_id.len());
    for &byte in app_id.as_bytes() {
        let safe = byte.is_ascii_alphanumeric()
            || matches!(byte, b'_' | b'-')
            || (byte == b'.' && !encode_dots);
        if safe {
            encoded.push(char::from(byte));
        } else {
            encoded.push('~');
            encoded.push(char::from(HEX[usize::from(byte >> 4)]));
            encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    encoded
}
