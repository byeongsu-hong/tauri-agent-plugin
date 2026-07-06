use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("stale ref {0}; run tree again")]
    StaleRef(String),
    #[error("live bridge unavailable: {0}")]
    BridgeUnavailable(&'static str),
    #[error("window not found: {0}")]
    WindowNotFound(String),
    #[error("{0}")]
    Tauri(#[from] tauri::Error),
}

impl serde::Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
