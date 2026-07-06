use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::{commands, Error};

pub(crate) const BRIDGE_REQUEST_EVENT: &str = "tauri-agent://request";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBridgeResponse {
    pub id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentBridgeRequest {
    id: String,
    method: String,
    params: serde_json::Value,
}

pub type BridgeResult = Result<serde_json::Value, String>;

#[derive(Default)]
pub(crate) struct AgentBridge {
    pending: Mutex<HashMap<String, Sender<BridgeResult>>>,
    next_id: AtomicU64,
}

impl AgentBridge {
    pub(crate) fn request_webview<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        window: Option<&str>,
        method: &str,
        params: serde_json::Value,
    ) -> crate::Result<serde_json::Value> {
        commands::ensure_window(app, window)?;
        let target = target_window(app, window)?;
        let id = format!("bridge-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let pending = self.insert_pending(id.clone());

        target.emit(
            BRIDGE_REQUEST_EVENT,
            AgentBridgeRequest {
                id: id.clone(),
                method: method.into(),
                params,
            },
        )?;

        match pending.recv_timeout(Duration::from_secs(2)) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(Error::BridgeUnavailable(error)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(&id);
                Err(Error::BridgeUnavailable(
                    "guest bridge timed out waiting for webview response".into(),
                ))
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(Error::BridgeUnavailable(
                "guest bridge response channel disconnected".into(),
            )),
        }
    }

    pub(crate) fn insert_pending(&self, id: String) -> Receiver<BridgeResult> {
        let (tx, rx) = channel();
        self.pending
            .lock()
            .expect("agent bridge pending mutex")
            .insert(id, tx);
        rx
    }

    pub(crate) fn complete(&self, response: AgentBridgeResponse) -> bool {
        let Some(sender) = self
            .pending
            .lock()
            .expect("agent bridge pending mutex")
            .remove(&response.id)
        else {
            return false;
        };

        let result = match response.error {
            Some(error) => Err(error),
            None => Ok(response.result.unwrap_or(serde_json::Value::Null)),
        };
        sender.send(result).is_ok()
    }

    fn remove_pending(&self, id: &str) {
        self.pending
            .lock()
            .expect("agent bridge pending mutex")
            .remove(id);
    }
}

fn target_window<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<&str>,
) -> crate::Result<tauri::WebviewWindow<R>> {
    let mut windows = app.webview_windows().into_iter().collect::<Vec<_>>();
    windows.sort_by(|a, b| a.0.cmp(&b.0));
    if let Some(label) = label {
        return windows
            .into_iter()
            .find(|(window_label, _)| window_label == label)
            .map(|(_, window)| window)
            .ok_or_else(|| Error::WindowNotFound(label.to_string()));
    }

    windows
        .into_iter()
        .next()
        .map(|(_, window)| window)
        .ok_or_else(|| Error::WindowNotFound("main".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_completes_pending_response() {
        let bridge = AgentBridge::default();
        let pending = bridge.insert_pending("req-1".into());

        assert!(bridge.complete(AgentBridgeResponse {
            id: "req-1".into(),
            result: Some(serde_json::json!({"ok": true})),
            error: None,
        }));

        assert_eq!(
            pending.recv().unwrap().unwrap(),
            serde_json::json!({"ok": true})
        );
    }
}
