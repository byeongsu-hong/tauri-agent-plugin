use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::screenshot::write_data_url_to_path;
use crate::{
    bridge::AgentBridge, commands, write_endpoint_registry, AgentAttachRequest,
    AgentEndpointDescriptor, EndpointRegistryError, Error, InlineServerConfig, WindowInfo,
};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, thiserror::Error)]
pub(crate) enum InlineServerError {
    #[error("inline debugger server I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Registry(#[from] EndpointRegistryError),
}

#[derive(Debug)]
pub(crate) struct InlineDebuggerServer {
    descriptor: AgentEndpointDescriptor,
    registry_app_id: Option<String>,
    shutdown: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl InlineDebuggerServer {
    pub(crate) fn descriptor(&self) -> &AgentEndpointDescriptor {
        &self.descriptor
    }
}

impl Drop for InlineDebuggerServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(worker) = self
            .worker
            .lock()
            .expect("inline server worker mutex")
            .take()
        {
            let _ = worker.join();
        }
        if let Some(app_id) = &self.registry_app_id {
            let _ = crate::remove_endpoint_registry(app_id, None);
        }
    }
}

pub(crate) trait InlineDebuggerBackend {
    fn windows(&self) -> Vec<WindowInfo>;
    fn ensure_window(&self, label: Option<&str>) -> crate::Result<()>;
    fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
        let _ = (method, params);
        Err(Error::BridgeUnavailable(
            "guest bridge methods are not active in this backend".into(),
        ))
    }
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Value,
    method: String,
    params: Option<Value>,
}

pub(crate) fn respond_to_json_rpc_line(backend: &impl InlineDebuggerBackend, line: &str) -> String {
    let request = match parse_request(line) {
        Ok(request) => request,
        Err(message) => return error_response(json!(0), "INVALID_REQUEST", &message),
    };
    let id = request.id.clone();

    let result = match request.method.as_str() {
        "attach" => handle_attach(backend, request.params),
        "windows" => Ok(json!(backend.windows())),
        "tree" | "click" | "hover" | "focus" | "blur" | "scroll" | "fill" | "select" | "check"
        | "inspect" | "eval" | "press" | "logs" | "events" | "wait" | "state" | "record" => {
            backend.bridge_call(&request.method, request.params.unwrap_or_else(|| json!({})))
        }
        "shot" => handle_shot(backend, request.params.unwrap_or_else(|| json!({}))),
        method => {
            return error_response(
                id,
                "INVALID_REQUEST",
                &format!("unknown agent method: {method}"),
            )
        }
    };

    match result {
        Ok(result) => success_response(id, result),
        Err(error) => error_response(id, error_code(&error), &error.to_string()),
    }
}

pub(crate) fn start_line_json_rpc_server<B>(
    backend: B,
    app_id: String,
    config: &InlineServerConfig,
) -> Result<InlineDebuggerServer, InlineServerError>
where
    B: InlineDebuggerBackend + Send + Sync + 'static,
{
    let listener = TcpListener::bind((config.host.as_str(), config.port))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let descriptor = AgentEndpointDescriptor::tcp(
        app_id.clone(),
        std::process::id(),
        config.host.clone(),
        port,
    );
    if config.publish_endpoint {
        write_endpoint_registry(&descriptor, None)?;
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let backend = Arc::new(backend);
    let worker = thread::spawn(move || {
        accept_loop(listener, backend, worker_shutdown);
    });

    Ok(InlineDebuggerServer {
        descriptor,
        registry_app_id: config.publish_endpoint.then_some(app_id),
        shutdown,
        worker: Mutex::new(Some(worker)),
    })
}

pub(crate) fn start_inline_debugger_server<R: Runtime>(
    app: AppHandle<R>,
    app_id: String,
    config: &InlineServerConfig,
) -> Result<InlineDebuggerServer, InlineServerError> {
    start_line_json_rpc_server(TauriBackend { app }, app_id, config)
}

struct TauriBackend<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> InlineDebuggerBackend for TauriBackend<R> {
    fn windows(&self) -> Vec<WindowInfo> {
        commands::collect_windows(&self.app)
    }

    fn ensure_window(&self, label: Option<&str>) -> crate::Result<()> {
        commands::ensure_window(&self.app, label)
    }

    fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
        let window = params
            .get("window")
            .and_then(Value::as_str)
            .map(str::to_string);
        let bridge = self.app.state::<AgentBridge>();
        bridge.request_webview(&self.app, window.as_deref(), method, params)
    }
}

fn accept_loop<B>(listener: TcpListener, backend: Arc<B>, shutdown: Arc<AtomicBool>)
where
    B: InlineDebuggerBackend + Send + Sync + 'static,
{
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let backend = Arc::clone(&backend);
                thread::spawn(move || handle_stream(stream, backend.as_ref()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

fn handle_stream(stream: TcpStream, backend: &impl InlineDebuggerBackend) {
    let writer = match stream.try_clone() {
        Ok(writer) => writer,
        Err(_) => return,
    };
    let mut writer = std::io::BufWriter::new(writer);
    let reader = BufReader::new(stream);

    for line in reader.lines() {
        let Ok(line) = line else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let response = respond_to_json_rpc_line(backend, &line);
        if writeln!(writer, "{response}")
            .and_then(|_| writer.flush())
            .is_err()
        {
            break;
        }
    }
}

fn parse_request(line: &str) -> Result<JsonRpcRequest, String> {
    let request = serde_json::from_str::<JsonRpcRequest>(line)
        .map_err(|_| "invalid JSON-RPC message".to_string())?;
    if request.jsonrpc != "2.0" || !is_valid_id(&request.id) {
        return Err("invalid JSON-RPC 2.0 message".into());
    }
    Ok(request)
}

fn handle_attach(
    backend: &impl InlineDebuggerBackend,
    params: Option<Value>,
) -> crate::Result<Value> {
    let request = parse_params::<AgentAttachRequest>(params)?;
    backend.ensure_window(request.window.as_deref())?;
    Ok(json!({
        "attached": true,
        "windows": backend.windows()
    }))
}

fn handle_shot(backend: &impl InlineDebuggerBackend, params: Value) -> crate::Result<Value> {
    let path = params
        .get("path")
        .and_then(Value::as_str)
        .map(str::to_string);
    let result = backend.bridge_call("shot", params)?;
    let Some(path) = path else {
        return Ok(result);
    };

    let data_url = result
        .get("dataUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::BridgeUnavailable("screenshot bridge returned no dataUrl".into()))?;
    let mime = result
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    write_data_url_to_path(data_url, &path)?;
    Ok(json!({
        "path": path,
        "mime": mime
    }))
}

fn parse_params<T: DeserializeOwned>(params: Option<Value>) -> crate::Result<T> {
    serde_json::from_value(params.unwrap_or_else(|| json!({}))).map_err(|_| {
        Error::BridgeUnavailable("invalid JSON-RPC params for inline Rust server method".into())
    })
}

fn success_response(id: Value, result: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result
    })
    .to_string()
}

fn error_response(id: Value, code: &str, message: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": code,
            "message": message
        }
    })
    .to_string()
}

fn error_code(error: &Error) -> &'static str {
    match error {
        Error::StaleRef(_) => "STALE_REF",
        Error::BridgeUnavailable(_) => "BRIDGE_UNAVAILABLE",
        Error::WindowNotFound(_) => "WINDOW_NOT_FOUND",
        Error::Tauri(_) => "AGENT_ERROR",
    }
}

fn is_valid_id(id: &Value) -> bool {
    id.is_string() || id.is_number()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;

    use crate::{Error, WindowInfo};

    struct FakeBackend;

    impl InlineDebuggerBackend for FakeBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            vec![WindowInfo {
                label: "main".into(),
                title: Some("Fixture".into()),
                focused: true,
                visible: true,
            }]
        }

        fn ensure_window(&self, label: Option<&str>) -> crate::Result<()> {
            match label {
                Some("main") | None => Ok(()),
                Some(label) => Err(Error::WindowNotFound(label.to_string())),
            }
        }
    }

    struct FakeScreenshotBackend {
        expected_path: String,
    }

    impl InlineDebuggerBackend for FakeScreenshotBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "shot");
            assert_eq!(params["path"], self.expected_path);
            Ok(serde_json::json!({
                "dataUrl": "data:image/svg+xml;base64,PHN2Zz5zaG90PC9zdmc+",
                "mime": "image/svg+xml"
            }))
        }
    }

    struct FakeInspectBackend;

    impl InlineDebuggerBackend for FakeInspectBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "inspect");
            assert_eq!(params["ref"], "@4");
            Ok(serde_json::json!({
                "ref": "@4",
                "role": "textbox",
                "name": "Agent name",
                "tagName": "input",
                "text": "",
                "value": "worker-a",
                "attributes": {"aria-label": "Agent name"},
                "states": []
            }))
        }
    }

    struct FakeEvalBackend;

    impl InlineDebuggerBackend for FakeEvalBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "eval");
            assert_eq!(params["code"], "document.title");
            Ok(serde_json::json!({
                "type": "string",
                "value": "Fixture",
                "text": "Fixture"
            }))
        }
    }

    struct FakeSelectBackend;

    impl InlineDebuggerBackend for FakeSelectBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "select");
            assert_eq!(params["ref"], "@4");
            assert_eq!(params["value"], "remote");
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    struct FakeCheckBackend;

    impl InlineDebuggerBackend for FakeCheckBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "check");
            assert_eq!(params["ref"], "@6");
            assert_eq!(params["checked"], true);
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    struct FakeHoverBackend;

    impl InlineDebuggerBackend for FakeHoverBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "hover");
            assert_eq!(params["ref"], "@3");
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    struct FakeFocusBackend;

    impl InlineDebuggerBackend for FakeFocusBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "focus");
            assert_eq!(params["ref"], "@4");
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    struct FakeBlurBackend;

    impl InlineDebuggerBackend for FakeBlurBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "blur");
            assert_eq!(params["ref"], "@4");
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    struct FakeScrollBackend;

    impl InlineDebuggerBackend for FakeScrollBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "scroll");
            assert_eq!(params["ref"], "@7");
            assert_eq!(params["x"], 3.0);
            assert_eq!(params["y"], 12.0);
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    #[test]
    fn inline_server_handles_windows_and_attach_json_rpc() {
        let backend = FakeBackend;

        let windows =
            respond_to_json_rpc_line(&backend, r#"{"jsonrpc":"2.0","id":1,"method":"windows"}"#);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&windows).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": [{
                    "label": "main",
                    "title": "Fixture",
                    "focused": true,
                    "visible": true
                }]
            })
        );

        let attach = respond_to_json_rpc_line(
            &backend,
            r#"{"jsonrpc":"2.0","id":2,"method":"attach","params":{"window":"missing"}}"#,
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&attach).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 2,
                "error": {
                    "code": "WINDOW_NOT_FOUND",
                    "message": "window not found: missing"
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_inspect_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeInspectBackend,
            r#"{"jsonrpc":"2.0","id":4,"method":"inspect","params":{"ref":"@4"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 4,
                "result": {
                    "ref": "@4",
                    "role": "textbox",
                    "name": "Agent name",
                    "tagName": "input",
                    "text": "",
                    "value": "worker-a",
                    "attributes": {"aria-label": "Agent name"},
                    "states": []
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_eval_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeEvalBackend,
            r#"{"jsonrpc":"2.0","id":5,"method":"eval","params":{"code":"document.title"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 5,
                "result": {
                    "type": "string",
                    "value": "Fixture",
                    "text": "Fixture"
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_select_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeSelectBackend,
            r#"{"jsonrpc":"2.0","id":6,"method":"select","params":{"ref":"@4","value":"remote"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 6,
                "result": { "ok": true }
            })
        );
    }

    #[test]
    fn inline_server_proxies_check_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeCheckBackend,
            r#"{"jsonrpc":"2.0","id":7,"method":"check","params":{"ref":"@6","checked":true}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 7,
                "result": { "ok": true }
            })
        );
    }

    #[test]
    fn inline_server_proxies_hover_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeHoverBackend,
            r#"{"jsonrpc":"2.0","id":8,"method":"hover","params":{"ref":"@3"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 8,
                "result": { "ok": true }
            })
        );
    }

    #[test]
    fn inline_server_proxies_focus_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeFocusBackend,
            r#"{"jsonrpc":"2.0","id":9,"method":"focus","params":{"ref":"@4"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 9,
                "result": { "ok": true }
            })
        );
    }

    #[test]
    fn inline_server_proxies_blur_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeBlurBackend,
            r#"{"jsonrpc":"2.0","id":10,"method":"blur","params":{"ref":"@4"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 10,
                "result": { "ok": true }
            })
        );
    }

    #[test]
    fn inline_server_proxies_scroll_json_rpc_to_bridge() {
        let response = respond_to_json_rpc_line(
            &FakeScrollBackend,
            r#"{"jsonrpc":"2.0","id":11,"method":"scroll","params":{"ref":"@7","x":3.0,"y":12.0}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 11,
                "result": { "ok": true }
            })
        );
    }

    #[test]
    fn inline_server_serves_line_json_rpc_over_tcp() {
        let config = crate::InlineServerConfig {
            enabled: true,
            host: "127.0.0.1".into(),
            port: 0,
            publish_endpoint: false,
        };
        let server =
            start_line_json_rpc_server(FakeBackend, "dev.byeongsu.fixture".into(), &config)
                .unwrap();
        let descriptor = server.descriptor();
        let (host, port) = match descriptor {
            crate::AgentEndpointDescriptor::Tcp { host, port, .. } => (host.clone(), *port),
            _ => panic!("expected tcp descriptor"),
        };
        assert!(port > 0);

        let mut stream = TcpStream::connect((host.as_str(), port)).unwrap();
        writeln!(
            stream,
            r#"{{"jsonrpc":"2.0","id":"live-1","method":"windows"}}"#
        )
        .unwrap();

        let mut response = String::new();
        BufReader::new(stream).read_line(&mut response).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": "live-1",
                "result": [{
                    "label": "main",
                    "title": "Fixture",
                    "focused": true,
                    "visible": true
                }]
            })
        );
    }

    #[test]
    fn inline_server_writes_bridged_screenshot_data_url_to_path() {
        let path = std::env::temp_dir().join("tauri-agent-bridge-shot.svg");
        let _ = std::fs::remove_file(&path);
        let path_string = path.to_string_lossy().into_owned();
        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "shot",
            "params": { "path": path_string }
        })
        .to_string();

        let response = respond_to_json_rpc_line(
            &FakeScreenshotBackend {
                expected_path: path_string.clone(),
            },
            &request,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "path": path_string,
                    "mime": "image/svg+xml"
                }
            })
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<svg>shot</svg>");
        let _ = std::fs::remove_file(path);
    }
}
