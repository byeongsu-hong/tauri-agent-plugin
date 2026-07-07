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
    AgentEndpointDescriptor, AgentScreenshotRequest, AgentWindowRequest, EndpointRegistryError,
    Error, InlineServerConfig, ScreenshotBackend, WindowAction, WindowInfo,
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
    fn window_control(&self, request: AgentWindowRequest) -> crate::Result<WindowInfo> {
        if !matches!(request.action, None | Some(WindowAction::Get)) {
            return Err(Error::BridgeUnavailable(
                "window control is not active in this backend".into(),
            ));
        }
        let label = request.window.as_deref();
        self.windows()
            .into_iter()
            .find(|window| match label {
                Some(label) => window.label == label,
                None => true,
            })
            .ok_or_else(|| Error::WindowNotFound(label.unwrap_or("default").to_string()))
    }
    fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
        let _ = (method, params);
        Err(Error::BridgeUnavailable(
            "guest bridge methods are not active in this backend".into(),
        ))
    }
    fn native_screenshot(&self, request: AgentScreenshotRequest) -> crate::Result<Value> {
        let _ = request;
        Err(Error::BridgeUnavailable(
            "native screenshot backend is not active in this backend".into(),
        ))
    }
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Value,
    method: String,
    params: Option<Value>,
    #[serde(default)]
    token: Option<String>,
}

pub(crate) fn respond_to_json_rpc_line(
    backend: &impl InlineDebuggerBackend,
    expected_token: Option<&str>,
    line: &str,
) -> String {
    let request = match parse_request(line) {
        Ok(request) => request,
        Err(message) => return error_response(json!(0), "INVALID_REQUEST", &message),
    };
    let id = request.id.clone();

    if let Some(expected) = expected_token {
        if request.token.as_deref() != Some(expected) {
            return error_response(
                id,
                "UNAUTHORIZED",
                "missing or invalid debugger token; read it from the app endpoint registry",
            );
        }
    }

    let result = match request.method.as_str() {
        "attach" => handle_attach(backend, request.params),
        "windows" => Ok(json!(backend.windows())),
        "window" => handle_window(backend, request.params),
        "tree" | "find" | "click" | "hover" | "focus" | "blur" | "scroll" | "drag" | "fill"
        | "select" | "check" | "inspect" | "eval" | "press" | "logs" | "events" | "network"
        | "storage" | "cookies" | "location" | "wait" | "state" | "record" | "stream" => {
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
    vnc: Option<crate::endpoint::VncEndpoint>,
) -> Result<InlineDebuggerServer, InlineServerError>
where
    B: InlineDebuggerBackend + Send + Sync + 'static,
{
    let listener = TcpListener::bind((config.host.as_str(), config.port))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    // Per-session token: any local process can reach the loopback socket, so
    // the token (published into the 0600 endpoint registry) is what actually
    // authenticates a client.
    let token = crate::random::random_hex(32);
    let descriptor = AgentEndpointDescriptor::tcp(
        app_id.clone(),
        std::process::id(),
        config.host.clone(),
        port,
    )
    .with_token(Some(token.clone()))
    .with_vnc(vnc);
    if config.publish_endpoint {
        write_endpoint_registry(&descriptor, None)?;
    }

    let shutdown = Arc::new(AtomicBool::new(false));
    let worker_shutdown = Arc::clone(&shutdown);
    let backend = Arc::new(backend);
    let token: Arc<str> = Arc::from(token);
    let worker = thread::spawn(move || {
        accept_loop(listener, backend, Some(token), worker_shutdown);
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
    vnc: Option<crate::endpoint::VncEndpoint>,
) -> Result<InlineDebuggerServer, InlineServerError> {
    start_line_json_rpc_server(TauriBackend { app }, app_id, config, vnc)
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

    fn window_control(&self, request: AgentWindowRequest) -> crate::Result<WindowInfo> {
        commands::control_window(&self.app, request)
    }

    fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
        let window = params
            .get("window")
            .and_then(Value::as_str)
            .map(str::to_string);
        let bridge = self.app.state::<AgentBridge>();
        bridge.request_webview(&self.app, window.as_deref(), method, params)
    }

    fn native_screenshot(&self, request: AgentScreenshotRequest) -> crate::Result<Value> {
        commands::capture_native_screenshot_for_request(&self.app, &request)
    }
}

fn accept_loop<B>(
    listener: TcpListener,
    backend: Arc<B>,
    token: Option<Arc<str>>,
    shutdown: Arc<AtomicBool>,
) where
    B: InlineDebuggerBackend + Send + Sync + 'static,
{
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let backend = Arc::clone(&backend);
                let token = token.clone();
                thread::spawn(move || handle_stream(stream, backend.as_ref(), token.as_deref()));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => break,
        }
    }
}

fn handle_stream(stream: TcpStream, backend: &impl InlineDebuggerBackend, token: Option<&str>) {
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
        let response = respond_to_json_rpc_line(backend, token, &line);
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

fn handle_window(
    backend: &impl InlineDebuggerBackend,
    params: Option<Value>,
) -> crate::Result<Value> {
    let request = parse_params::<AgentWindowRequest>(params)?;
    Ok(json!(backend.window_control(request)?))
}

fn handle_shot(backend: &impl InlineDebuggerBackend, params: Value) -> crate::Result<Value> {
    let request = parse_params::<AgentScreenshotRequest>(Some(params.clone()))?;
    match request.backend.unwrap_or(ScreenshotBackend::Dom) {
        ScreenshotBackend::Dom => handle_bridge_shot(backend, params),
        ScreenshotBackend::Native => backend.native_screenshot(request),
        ScreenshotBackend::Auto => backend
            .native_screenshot(request)
            .or_else(|_| handle_bridge_shot(backend, params)),
    }
}

fn handle_bridge_shot(backend: &impl InlineDebuggerBackend, params: Value) -> crate::Result<Value> {
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
    let mut response = serde_json::Map::new();
    response.insert("path".into(), json!(path));
    response.insert("mime".into(), json!(mime));
    if let Some(width) = result.get("width") {
        response.insert("width".into(), width.clone());
    }
    if let Some(height) = result.get("height") {
        response.insert("height".into(), height.clone());
    }
    Ok(Value::Object(response))
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

    use crate::{Error, WindowBounds, WindowInfo};

    /// Dispatch without token enforcement, for tests that exercise routing.
    fn respond(backend: &impl InlineDebuggerBackend, line: &str) -> String {
        respond_to_json_rpc_line(backend, None, line)
    }

    struct FakeBackend;

    impl InlineDebuggerBackend for FakeBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            vec![WindowInfo {
                label: "main".into(),
                title: Some("Fixture".into()),
                focused: true,
                visible: true,
                minimized: Some(false),
                maximized: Some(false),
                scale_factor: Some(2.0),
                inner_bounds: Some(WindowBounds {
                    x: 10,
                    y: 20,
                    width: 800,
                    height: 600,
                }),
                outer_bounds: Some(WindowBounds {
                    x: 4,
                    y: 12,
                    width: 824,
                    height: 648,
                }),
            }]
        }

        fn ensure_window(&self, label: Option<&str>) -> crate::Result<()> {
            match label {
                Some("main") | None => Ok(()),
                Some(label) => Err(Error::WindowNotFound(label.to_string())),
            }
        }

        fn window_control(&self, request: AgentWindowRequest) -> crate::Result<WindowInfo> {
            self.ensure_window(request.window.as_deref())?;
            let mut window = self.windows().remove(0);
            match request.action.unwrap_or(WindowAction::Get) {
                WindowAction::Get => {}
                WindowAction::SetSize => {
                    let width = request.width.unwrap();
                    let height = request.height.unwrap();
                    if let Some(bounds) = &mut window.inner_bounds {
                        bounds.width = width;
                        bounds.height = height;
                    }
                    if let Some(bounds) = &mut window.outer_bounds {
                        bounds.width = width;
                        bounds.height = height;
                    }
                }
                WindowAction::SetPosition => {
                    let x = request.x.unwrap();
                    let y = request.y.unwrap();
                    if let Some(bounds) = &mut window.inner_bounds {
                        bounds.x = x;
                        bounds.y = y;
                    }
                    if let Some(bounds) = &mut window.outer_bounds {
                        bounds.x = x;
                        bounds.y = y;
                    }
                }
                WindowAction::Focus => window.focused = true,
                WindowAction::Show => window.visible = true,
                WindowAction::Hide => window.visible = false,
                WindowAction::Minimize => window.minimized = Some(true),
                WindowAction::Unminimize => window.minimized = Some(false),
                WindowAction::Maximize => window.maximized = Some(true),
                WindowAction::Unmaximize => window.maximized = Some(false),
            }
            Ok(window)
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
                "mime": "image/svg+xml",
                "width": 1024,
                "height": 768
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

    struct FakeFindBackend;

    impl InlineDebuggerBackend for FakeFindBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "find");
            assert_eq!(params["role"], "button");
            assert_eq!(params["name"], "Forge");
            assert_eq!(params["limit"], 1);
            Ok(serde_json::json!({
                "matches": [{
                    "ref": "@1",
                    "role": "button",
                    "name": "Forge",
                    "tagName": "button",
                    "text": "Forge",
                    "attributes": {},
                    "states": []
                }]
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

    struct FakeDragBackend;

    impl InlineDebuggerBackend for FakeDragBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "drag");
            assert_eq!(params["ref"], "@1");
            assert_eq!(params["toRef"], "@8");
            Ok(serde_json::json!({ "ok": true }))
        }
    }

    struct FakeNetworkBackend;

    impl InlineDebuggerBackend for FakeNetworkBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "network");
            assert_eq!(params["window"], "main");
            assert_eq!(params["clear"], true);
            Ok(serde_json::json!([{
                "id": "fetch-1",
                "type": "fetch",
                "method": "GET",
                "url": "https://example.test/api/agents",
                "status": 200,
                "ok": true,
                "startedAt": "2026-07-07T00:00:00.000Z",
                "endedAt": "2026-07-07T00:00:00.020Z",
                "durationMs": 20.0
            }]))
        }
    }

    struct FakeStorageBackend;

    impl InlineDebuggerBackend for FakeStorageBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "storage");
            assert_eq!(params["area"], "session");
            assert_eq!(params["action"], "set");
            assert_eq!(params["key"], "agent.route");
            assert_eq!(params["value"], "/agents");
            Ok(serde_json::json!({
                "area": "session",
                "entries": [{
                    "area": "session",
                    "key": "agent.route",
                    "value": "/agents"
                }]
            }))
        }
    }

    struct FakeCookiesBackend;

    impl InlineDebuggerBackend for FakeCookiesBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "cookies");
            assert_eq!(params["window"], "main");
            assert_eq!(params["action"], "set");
            assert_eq!(params["name"], "agent.cookie");
            assert_eq!(params["value"], "ready");
            Ok(serde_json::json!({
                "entries": [{
                    "name": "agent.cookie",
                    "value": "ready"
                }]
            }))
        }
    }

    struct FakeLocationBackend;

    impl InlineDebuggerBackend for FakeLocationBackend {
        fn windows(&self) -> Vec<WindowInfo> {
            Vec::new()
        }

        fn ensure_window(&self, _label: Option<&str>) -> crate::Result<()> {
            Ok(())
        }

        fn bridge_call(&self, method: &str, params: Value) -> crate::Result<Value> {
            assert_eq!(method, "location");
            assert_eq!(params["window"], "main");
            assert_eq!(params["action"], "push");
            assert_eq!(params["url"], "/agents?view=debug#roster");
            Ok(serde_json::json!({
                "href": "tauri-agent://static/agents?view=debug#roster",
                "origin": "null",
                "pathname": "/agents",
                "search": "?view=debug",
                "hash": "#roster"
            }))
        }
    }

    #[test]
    fn inline_server_handles_windows_and_attach_json_rpc() {
        let backend = FakeBackend;

        let windows = respond(&backend, r#"{"jsonrpc":"2.0","id":1,"method":"windows"}"#);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&windows).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": [{
                    "label": "main",
                    "title": "Fixture",
                    "focused": true,
                    "visible": true,
                    "minimized": false,
                    "maximized": false,
                    "scaleFactor": 2.0,
                    "innerBounds": {"x": 10, "y": 20, "width": 800, "height": 600},
                    "outerBounds": {"x": 4, "y": 12, "width": 824, "height": 648}
                }]
            })
        );

        let window = respond(
            &backend,
            r#"{"jsonrpc":"2.0","id":3,"method":"window","params":{"window":"main","action":"setSize","width":640,"height":480}}"#,
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&window).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 3,
                "result": {
                    "label": "main",
                    "title": "Fixture",
                    "focused": true,
                    "visible": true,
                    "minimized": false,
                    "maximized": false,
                    "scaleFactor": 2.0,
                    "innerBounds": {"x": 10, "y": 20, "width": 640, "height": 480},
                    "outerBounds": {"x": 4, "y": 12, "width": 640, "height": 480}
                }
            })
        );

        let attach = respond(
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
        let response = respond(
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
    fn inline_server_proxies_find_json_rpc_to_bridge() {
        let response = respond(
            &FakeFindBackend,
            r#"{"jsonrpc":"2.0","id":13,"method":"find","params":{"role":"button","name":"Forge","limit":1}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 13,
                "result": {
                    "matches": [{
                        "ref": "@1",
                        "role": "button",
                        "name": "Forge",
                        "tagName": "button",
                        "text": "Forge",
                        "attributes": {},
                        "states": []
                    }]
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_network_json_rpc_to_bridge() {
        let response = respond(
            &FakeNetworkBackend,
            r#"{"jsonrpc":"2.0","id":14,"method":"network","params":{"window":"main","clear":true}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 14,
                "result": [{
                    "id": "fetch-1",
                    "type": "fetch",
                    "method": "GET",
                    "url": "https://example.test/api/agents",
                    "status": 200,
                    "ok": true,
                    "startedAt": "2026-07-07T00:00:00.000Z",
                    "endedAt": "2026-07-07T00:00:00.020Z",
                    "durationMs": 20.0
                }]
            })
        );
    }

    #[test]
    fn inline_server_proxies_storage_json_rpc_to_bridge() {
        let response = respond(
            &FakeStorageBackend,
            r#"{"jsonrpc":"2.0","id":15,"method":"storage","params":{"area":"session","action":"set","key":"agent.route","value":"/agents"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 15,
                "result": {
                    "area": "session",
                    "entries": [{
                        "area": "session",
                        "key": "agent.route",
                        "value": "/agents"
                    }]
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_cookies_json_rpc_to_bridge() {
        let response = respond(
            &FakeCookiesBackend,
            r#"{"jsonrpc":"2.0","id":16,"method":"cookies","params":{"window":"main","action":"set","name":"agent.cookie","value":"ready"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 16,
                "result": {
                    "entries": [{
                        "name": "agent.cookie",
                        "value": "ready"
                    }]
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_location_json_rpc_to_bridge() {
        let response = respond(
            &FakeLocationBackend,
            r#"{"jsonrpc":"2.0","id":17,"method":"location","params":{"window":"main","action":"push","url":"/agents?view=debug#roster"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 17,
                "result": {
                    "href": "tauri-agent://static/agents?view=debug#roster",
                    "origin": "null",
                    "pathname": "/agents",
                    "search": "?view=debug",
                    "hash": "#roster"
                }
            })
        );
    }

    #[test]
    fn inline_server_proxies_eval_json_rpc_to_bridge() {
        let response = respond(
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
        let response = respond(
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
        let response = respond(
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
        let response = respond(
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
        let response = respond(
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
        let response = respond(
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
        let response = respond(
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
    fn inline_server_proxies_drag_json_rpc_to_bridge() {
        let response = respond(
            &FakeDragBackend,
            r#"{"jsonrpc":"2.0","id":12,"method":"drag","params":{"ref":"@1","toRef":"@8"}}"#,
        );

        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response).unwrap(),
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 12,
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
            start_line_json_rpc_server(FakeBackend, "dev.byeongsu.fixture".into(), &config, None)
                .unwrap();
        let descriptor = server.descriptor();
        let token = descriptor
            .token()
            .expect("server issues a token")
            .to_string();
        let (host, port) = match descriptor {
            crate::AgentEndpointDescriptor::Tcp { host, port, .. } => (host.clone(), *port),
            _ => panic!("expected tcp descriptor"),
        };
        assert!(port > 0);

        // An unauthenticated request is rejected.
        let mut anon = TcpStream::connect((host.as_str(), port)).unwrap();
        writeln!(
            anon,
            r#"{{"jsonrpc":"2.0","id":"anon","method":"windows"}}"#
        )
        .unwrap();
        let mut anon_response = String::new();
        BufReader::new(anon).read_line(&mut anon_response).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&anon_response).unwrap()["error"]["code"],
            "UNAUTHORIZED"
        );

        let mut stream = TcpStream::connect((host.as_str(), port)).unwrap();
        writeln!(
            stream,
            r#"{{"jsonrpc":"2.0","id":"live-1","method":"windows","token":"{token}"}}"#
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
                    "visible": true,
                    "minimized": false,
                    "maximized": false,
                    "scaleFactor": 2.0,
                    "innerBounds": {"x": 10, "y": 20, "width": 800, "height": 600},
                    "outerBounds": {"x": 4, "y": 12, "width": 824, "height": 648}
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

        let response = respond(
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
                    "mime": "image/svg+xml",
                    "width": 1024,
                    "height": 768
                }
            })
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "<svg>shot</svg>");
        let _ = std::fs::remove_file(path);
    }
}
