use std::path::PathBuf;

use tauri_plugin_agent::{
    endpoint_registry_path, endpoint_runtime_dir, read_endpoint_registry, remove_endpoint_registry,
    write_endpoint_registry, AgentEndpointDescriptor,
};

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

#[test]
fn rust_endpoint_registry_round_trips_app_scoped_files() {
    let runtime_base =
        std::env::temp_dir().join(format!("tauri-agent-rust-endpoint-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&runtime_base);

    let descriptor = AgentEndpointDescriptor::unix(
        "dev.byeongsu.fixture",
        4242,
        runtime_base
            .join("tauri-agent")
            .join("dev.byeongsu.fixture")
            .join("4242.sock"),
    );

    write_endpoint_registry(&descriptor, Some(runtime_base.clone())).unwrap();
    assert_eq!(
        read_endpoint_registry("dev.byeongsu.fixture", Some(runtime_base.clone())).unwrap(),
        descriptor
    );

    remove_endpoint_registry("dev.byeongsu.fixture", Some(runtime_base.clone())).unwrap();
    assert_eq!(
        read_endpoint_registry("dev.byeongsu.fixture", Some(runtime_base.clone()))
            .unwrap_err()
            .to_string(),
        "endpoint registry not found for app: dev.byeongsu.fixture"
    );

    let _ = std::fs::remove_dir_all(runtime_base);
}
