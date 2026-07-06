use std::path::PathBuf;

use tauri_plugin_agent::{endpoint_registry_path, endpoint_runtime_dir, AgentEndpointDescriptor};

#[test]
fn rust_endpoint_descriptors_are_app_scoped() {
    assert_eq!(
        endpoint_runtime_dir("dev.byeongsu.fixture", Some(PathBuf::from("/run/user/501"))),
        PathBuf::from("/run/user/501/tauri-agent/dev.byeongsu.fixture")
    );
    assert_eq!(
        endpoint_registry_path("dev.byeongsu.fixture", Some(PathBuf::from("/run/user/501"))),
        PathBuf::from("/run/user/501/tauri-agent/dev.byeongsu.fixture/endpoint.json")
    );

    let descriptor = AgentEndpointDescriptor::unix(
        "dev.byeongsu.fixture",
        4242,
        PathBuf::from("/run/user/501/tauri-agent/dev.byeongsu.fixture/4242.sock"),
    );

    assert_eq!(
        serde_json::to_value(descriptor).unwrap(),
        serde_json::json!({
            "appId": "dev.byeongsu.fixture",
            "pid": 4242,
            "transport": "unix",
            "path": "/run/user/501/tauri-agent/dev.byeongsu.fixture/4242.sock"
        })
    );
}
