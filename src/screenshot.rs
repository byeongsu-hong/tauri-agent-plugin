use std::path::Path;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine};
use serde_json::{json, Value};
use tauri::{Runtime, WebviewWindow};

use crate::{Error, Result};

// Only referenced by the macOS native-capture path; the test module also
// exercises the PNG helpers cross-platform, so keep them compiled everywhere.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const NATIVE_SCREENSHOT_TIMEOUT: Duration = Duration::from_secs(5);

pub(crate) fn write_data_url_to_path(data_url: &str, path: &str) -> Result<()> {
    let bytes = decode_base64_data_url(data_url)?;
    create_screenshot_parent_dir(path)?;
    std::fs::write(path, bytes)
        .map_err(|error| Error::BridgeUnavailable(format!("failed to write screenshot: {error}")))
}

pub(crate) fn capture_native_screenshot<R: Runtime>(
    window: &WebviewWindow<R>,
    path: Option<&str>,
) -> Result<Value> {
    capture_native_screenshot_impl(window, path)
}

#[cfg(target_os = "macos")]
fn capture_native_screenshot_impl<R: Runtime>(
    window: &WebviewWindow<R>,
    path: Option<&str>,
) -> Result<Value> {
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let window_for_task = window.clone();
    window
        .run_on_main_thread(move || {
            let result = window_for_task
                .ns_window()
                .map_err(Error::from)
                .and_then(capture_macos_window_png)
                .map_err(|error| error.to_string());
            let _ = sender.send(result);
        })
        .map_err(|error| {
            Error::BridgeUnavailable(format!("failed to schedule native screenshot: {error}"))
        })?;
    let bytes = receiver
        .recv_timeout(NATIVE_SCREENSHOT_TIMEOUT)
        .map_err(|error| {
            Error::BridgeUnavailable(format!("native screenshot task did not finish: {error}"))
        })?
        .map_err(Error::BridgeUnavailable)?;
    let result = native_screenshot_result_from_png_bytes(bytes.clone(), path)?;
    if let Some(path) = path {
        create_screenshot_parent_dir(path)?;
        std::fs::write(path, &bytes).map_err(|error| {
            Error::BridgeUnavailable(format!("failed to write native screenshot: {error}"))
        })?;
    }
    Ok(result)
}

#[cfg(not(target_os = "macos"))]
fn capture_native_screenshot_impl<R: Runtime>(
    _window: &WebviewWindow<R>,
    _path: Option<&str>,
) -> Result<Value> {
    Err(Error::BridgeUnavailable(
        "native screenshot backend is not implemented on this platform".into(),
    ))
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn native_screenshot_result_from_png_bytes(
    bytes: Vec<u8>,
    path: Option<&str>,
) -> Result<Value> {
    let (width, height) = png_dimensions(&bytes).ok_or_else(|| {
        Error::BridgeUnavailable("native screenshot did not produce a PNG image".into())
    })?;

    let mut response = serde_json::Map::new();
    if let Some(path) = path {
        response.insert("path".into(), json!(path));
    } else {
        response.insert(
            "dataUrl".into(),
            json!(format!(
                "data:image/png;base64,{}",
                BASE64_STANDARD.encode(bytes)
            )),
        );
    }
    response.insert("mime".into(), json!("image/png"));
    response.insert("width".into(), json!(width));
    response.insert("height".into(), json!(height));
    Ok(Value::Object(response))
}

#[cfg(target_os = "macos")]
fn capture_macos_window_png(ns_window: *mut std::ffi::c_void) -> Result<Vec<u8>> {
    use objc2::{rc::autoreleasepool, runtime::AnyObject};
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRepPropertyKey, NSWindow};
    use objc2_foundation::NSDictionary;

    if ns_window.is_null() {
        return Err(Error::BridgeUnavailable(
            "native screenshot window handle was null".into(),
        ));
    }

    autoreleasepool(|_| {
        let window = unsafe { &*(ns_window.cast::<NSWindow>()) };
        window.displayIfNeeded();

        let content_view = window.contentView().ok_or_else(|| {
            Error::BridgeUnavailable("native screenshot window has no content view".into())
        })?;
        content_view.layoutSubtreeIfNeeded();
        content_view.displayIfNeeded();

        let bounds = content_view.bounds();
        let bitmap = content_view
            .bitmapImageRepForCachingDisplayInRect(bounds)
            .ok_or_else(|| {
                Error::BridgeUnavailable(
                    "native screenshot could not allocate a bitmap representation".into(),
                )
            })?;
        content_view.cacheDisplayInRect_toBitmapImageRep(bounds, &bitmap);

        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
        let data = unsafe {
            bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        }
        .ok_or_else(|| {
            Error::BridgeUnavailable("native screenshot could not encode PNG data".into())
        })?;
        let bytes = unsafe { data.as_bytes_unchecked() }.to_vec();
        if bytes.is_empty() {
            return Err(Error::BridgeUnavailable(
                "native screenshot produced empty PNG data".into(),
            ));
        }
        Ok(bytes)
    })
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

fn create_screenshot_parent_dir(path: &str) -> Result<()> {
    if let Some(parent) = Path::new(path)
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent).map_err(|error| {
            Error::BridgeUnavailable(format!("failed to create screenshot directory: {error}"))
        })?;
    }
    Ok(())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_png_screenshot_results_from_native_bytes() {
        let mut png = vec![0_u8; 33];
        png[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png[16..20].copy_from_slice(&32_u32.to_be_bytes());
        png[20..24].copy_from_slice(&24_u32.to_be_bytes());

        let result = native_screenshot_result_from_png_bytes(png.clone(), None).unwrap();
        assert_eq!(result["mime"], "image/png");
        assert_eq!(result["width"], 32);
        assert_eq!(result["height"], 24);
        assert!(result["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));

        let result = native_screenshot_result_from_png_bytes(png, Some("/tmp/app.png")).unwrap();
        assert_eq!(result["path"], "/tmp/app.png");
        assert_eq!(result["mime"], "image/png");
        assert_eq!(result["width"], 32);
        assert_eq!(result["height"], 24);
        assert_eq!(
            native_screenshot_result_from_png_bytes(Vec::new(), Some("/tmp/app.png"))
                .unwrap_err()
                .to_string(),
            "live bridge unavailable: native screenshot did not produce a PNG image"
        );
    }
}
