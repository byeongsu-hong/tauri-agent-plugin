use std::path::Path;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};

use crate::{Error, Result};

pub(crate) fn write_data_url_to_path(data_url: &str, path: &str) -> Result<()> {
    let bytes = decode_base64_data_url(data_url)?;
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            Error::BridgeUnavailable(format!("failed to create screenshot directory: {error}"))
        })?;
    }
    std::fs::write(path, bytes)
        .map_err(|error| Error::BridgeUnavailable(format!("failed to write screenshot: {error}")))
}

fn decode_base64_data_url(data_url: &str) -> Result<Vec<u8>> {
    let Some((metadata, body)) = data_url.split_once(',') else {
        return Err(Error::BridgeUnavailable(
            "invalid screenshot data URL".into(),
        ));
    };
    if !metadata.starts_with("data:") || !metadata.contains(";base64") {
        return Err(Error::BridgeUnavailable(
            "screenshot data URL must be base64 encoded".into(),
        ));
    }
    BASE64_STANDARD
        .decode(body)
        .map_err(|error| Error::BridgeUnavailable(format!("invalid screenshot data URL: {error}")))
}
