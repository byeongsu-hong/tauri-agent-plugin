use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Runtime};

use crate::{commands, Error};

pub(crate) const BRIDGE_REQUEST_EVENT: &str = "tauri-agent://request";
const DEFAULT_BRIDGE_RESPONSE_TIMEOUT: Duration = Duration::from_secs(2);
const WAIT_BRIDGE_RESPONSE_MARGIN: Duration = Duration::from_millis(500);

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
        let target_label = target.label().to_string();
        let id = format!("bridge-{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let pending = self.insert_pending(id.clone());
        let response_timeout = bridge_response_timeout(method, &params);

        app.emit_to(
            EventTarget::window(target_label),
            BRIDGE_REQUEST_EVENT,
            AgentBridgeRequest {
                id: id.clone(),
                method: method.into(),
                params,
            },
        )?;

        match pending.recv_timeout(response_timeout) {
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

fn bridge_response_timeout(method: &str, params: &serde_json::Value) -> Duration {
    // `wait` and `stream` both long-poll in the guest for up to a caller-
    // supplied `timeoutMs`, so the bridge must outlast that budget.
    if method != "wait" && method != "stream" {
        return DEFAULT_BRIDGE_RESPONSE_TIMEOUT;
    }

    let requested = params
        .get("timeoutMs")
        .and_then(serde_json::Value::as_u64)
        .map(Duration::from_millis)
        .unwrap_or_default()
        + WAIT_BRIDGE_RESPONSE_MARGIN;

    requested.max(DEFAULT_BRIDGE_RESPONSE_TIMEOUT)
}

fn target_window<R: Runtime>(
    app: &AppHandle<R>,
    label: Option<&str>,
) -> crate::Result<tauri::WebviewWindow<R>> {
    let mut windows = app.webview_windows().into_iter().collect::<Vec<_>>();
    windows.sort_by(|a, b| a.1.label().cmp(b.1.label()));
    if let Some(label) = label {
        return windows
            .into_iter()
            .find(|(_, window)| window.label() == label)
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

    #[test]
    fn bridge_response_timeout_extends_for_wait_timeout_ms() {
        assert_eq!(
            bridge_response_timeout("wait", &serde_json::json!({"timeoutMs": 4_500})),
            Duration::from_millis(5_000)
        );
    }

    #[test]
    fn bridge_response_timeout_keeps_default_for_non_wait_methods() {
        assert_eq!(
            bridge_response_timeout("eval", &serde_json::json!({"timeoutMs": 4_500})),
            Duration::from_secs(2)
        );
    }
}
