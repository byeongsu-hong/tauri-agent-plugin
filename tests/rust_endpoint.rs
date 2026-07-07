use std::path::PathBuf;

use tauri_plugin_agent::{
    endpoint_registry_path, endpoint_runtime_dir, read_endpoint_registry, remove_endpoint_registry,
    write_endpoint_registry, AgentEndpointDescriptor, VncEndpoint,
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
fn rust_endpoint_runtime_dir_neutralizes_dot_only_app_ids() {
    // A dot-only app id must not escape the runtime base via path traversal.
    for app_id in ["..", ".", "..."] {
        let dir = endpoint_runtime_dir(app_id, Some(PathBuf::from("/run/user/501")));
        assert!(
            dir.starts_with("/run/user/501/tauri-agent/"),
            "{app_id:?} escaped: {dir:?}"
        );
        assert!(
            !dir.to_string_lossy().contains(".."),
            "{app_id:?} left a traversal: {dir:?}"
        );
    }
    assert_eq!(
        endpoint_runtime_dir("..", Some(PathBuf::from("/run"))),
        PathBuf::from("/run/tauri-agent/__")
    );
}

#[test]
fn rust_endpoint_descriptor_advertises_optional_vnc_surface() {
    let plain = AgentEndpointDescriptor::tcp("dev.byeongsu.fixture", 4242, "127.0.0.1", 45127);
    assert!(plain.vnc().is_none());
    // Absent VNC must not appear in the serialized registry.
    assert_eq!(
        serde_json::to_value(&plain).unwrap(),
        serde_json::json!({
            "appId": "dev.byeongsu.fixture",
            "pid": 4242,
            "transport": "tcp",
            "host": "127.0.0.1",
            "port": 45127
        })
    );

    let advertised = plain.with_vnc(Some(VncEndpoint {
        host: "127.0.0.1".into(),
        port: 5901,
        novnc_url: Some("http://127.0.0.1:6080/vnc.html".into()),
    }));
    assert_eq!(advertised.vnc().unwrap().port, 5901);
    let value = serde_json::to_value(&advertised).unwrap();
    assert_eq!(value["vnc"]["host"], "127.0.0.1");
    assert_eq!(value["vnc"]["port"], 5901);
    assert_eq!(value["vnc"]["novncUrl"], "http://127.0.0.1:6080/vnc.html");

    // Round-trips back through deserialization unchanged.
    assert_eq!(
        serde_json::from_value::<AgentEndpointDescriptor>(value).unwrap(),
        advertised
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

#[cfg(unix)]
#[test]
fn rust_endpoint_registry_is_owner_only_readable() {
    use std::os::unix::fs::PermissionsExt;

    let runtime_base = std::env::temp_dir().join(format!(
        "tauri-agent-rust-endpoint-perms-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&runtime_base);

    let descriptor = AgentEndpointDescriptor::tcp("dev.byeongsu.perms", 4242, "127.0.0.1", 45127)
        .with_token(Some("secret-token".into()));
    write_endpoint_registry(&descriptor, Some(runtime_base.clone())).unwrap();

    let path = endpoint_registry_path("dev.byeongsu.perms", Some(runtime_base.clone()));
    let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "registry with a token must not be world-readable"
    );

    // The token round-trips so a discovering client can authenticate.
    assert_eq!(
        read_endpoint_registry("dev.byeongsu.perms", Some(runtime_base.clone()))
            .unwrap()
            .token(),
        Some("secret-token")
    );

    let _ = std::fs::remove_dir_all(runtime_base);
}
