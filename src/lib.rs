use tauri::{plugin::TauriPlugin, Manager, Runtime};

mod bridge;
mod commands;
mod endpoint;
mod error;
mod models;
mod random;
mod screenshot;
mod server;

pub use endpoint::{
    endpoint_registry_path, endpoint_runtime_dir, read_endpoint_registry, remove_endpoint_registry,
    write_endpoint_registry, AgentEndpointDescriptor, EndpointRegistryError, VncEndpoint,
};
pub use error::Error;
pub use models::{
    AgentAction, AgentActionRequest, AgentAttachRequest, AgentAttachResponse, AgentBlurRequest,
    AgentCheckRequest, AgentCookieEntry, AgentCookiesRequest, AgentCookiesResponse,
    AgentDragRequest, AgentEvalRequest, AgentEventEntry, AgentEventsRequest, AgentFindRequest,
    AgentFindResponse, AgentFocusRequest, AgentHoverRequest, AgentLocationRequest,
    AgentLocationResponse, AgentLogEntry, AgentLogRequest, AgentNetworkEntry, AgentNetworkRequest,
    AgentRecordEntry, AgentRecordRequest, AgentRecordResponse, AgentScreenshotRequest,
    AgentScrollRequest, AgentSelectRequest, AgentSnapshotRequest, AgentStateRequest,
    AgentStorageEntry, AgentStorageRequest, AgentStorageResponse, AgentStreamFrame,
    AgentStreamRequest, AgentStreamResponse, AgentWaitRequest, AgentWaitResponse,
    AgentWindowRequest, Config, CookieAction, InlineServerConfig, KeyModifier, LocationAction,
    RecordAction, ScreenshotBackend, SnapshotMode, StorageAction, StorageArea, WindowAction,
    WindowBounds, WindowInfo,
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct Agent {
    config: Config,
    endpoint: Option<AgentEndpointDescriptor>,
}

impl Agent {
    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn endpoint(&self) -> Option<&AgentEndpointDescriptor> {
        self.endpoint.as_ref()
    }

    fn cleanup_endpoint(&self) {
        if let Some(endpoint) = &self.endpoint {
            let _ = remove_endpoint_registry(endpoint.app_id(), None);
        }
    }
}

pub trait AgentExt<R: Runtime> {
    fn agent(&self) -> &Agent;
}

impl<R: Runtime, T: Manager<R>> AgentExt<R> for T {
    fn agent(&self) -> &Agent {
        self.state::<Agent>().inner()
    }
}

fn validate_inline_server_config(config: &Config, debug_assertions: bool) -> Result<()> {
    if !config.inline_server.enabled {
        return Ok(());
    }
    if !debug_assertions && !config.allow_release_socket {
        return Err(Error::BridgeUnavailable(
            "inlineServer requires allowReleaseSocket in release builds".into(),
        ));
    }
    if !config.allow_non_loopback && !host_is_loopback(&config.inline_server.host) {
        return Err(Error::BridgeUnavailable(format!(
            "inlineServer host {} is not loopback; set allowNonLoopback to bind it",
            config.inline_server.host
        )));
    }
    Ok(())
}

fn host_is_loopback(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

pub struct Builder;

impl Builder {
    pub fn new() -> Self {
        Self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Option<Config>> {
        tauri::plugin::Builder::<R, Option<Config>>::new("agent")
            .setup(|app, api| {
                let config = api.config().clone().unwrap_or_default();
                validate_inline_server_config(&config, cfg!(debug_assertions))?;
                app.manage(bridge::AgentBridge::default());
                let endpoint = if config.inline_server.enabled {
                    let server = server::start_inline_debugger_server(
                        app.clone(),
                        app.config().identifier.clone(),
                        &config.inline_server,
                        config.vnc.clone(),
                    )?;
                    let descriptor = server.descriptor().clone();
                    app.manage(server);
                    Some(descriptor)
                } else {
                    None
                };
                app.manage(Agent { config, endpoint });
                Ok(())
            })
            .on_event(|app, event| {
                if matches!(
                    event,
                    tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
                ) {
                    if let Some(agent) = app.try_state::<Agent>() {
                        agent.cleanup_endpoint();
                    }
                }
            })
            .on_drop(|app| {
                if let Some(agent) = app.try_state::<Agent>() {
                    agent.cleanup_endpoint();
                }
            })
            .invoke_handler(tauri::generate_handler![
                commands::agent_bridge_response,
                commands::agent_attach,
                commands::agent_snapshot,
                commands::agent_find,
                commands::agent_action,
                commands::agent_inspect,
                commands::agent_eval,
                commands::agent_select,
                commands::agent_check,
                commands::agent_hover,
                commands::agent_focus,
                commands::agent_blur,
                commands::agent_scroll,
                commands::agent_drag,
                commands::agent_screenshot,
                commands::agent_logs,
                commands::agent_events,
                commands::agent_network,
                commands::agent_storage,
                commands::agent_cookies,
                commands::agent_location,
                commands::agent_windows,
                commands::agent_window,
                commands::agent_wait,
                commands::agent_state,
                commands::agent_record,
                commands::agent_stream,
            ])
            .build()
    }
}

impl Default for Builder {
    fn default() -> Self {
        Self::new()
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> {
    Builder::new().build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inline_enabled_config(allow_release_socket: bool) -> Config {
        Config {
            allow_release_socket,
            inline_server: InlineServerConfig {
                enabled: true,
                ..Default::default()
            },
            ..Default::default()
        }
    }

    #[test]
    fn release_build_rejects_inline_server_without_explicit_socket_opt_in() {
        let error = validate_inline_server_config(&inline_enabled_config(false), false)
            .expect_err("release inline server should require allow_release_socket");

        assert!(error.to_string().contains("allowReleaseSocket"));
    }

    #[test]
    fn release_build_allows_inline_server_with_explicit_socket_opt_in() {
        validate_inline_server_config(&inline_enabled_config(true), false).unwrap();
    }

    #[test]
    fn debug_build_allows_inline_server_without_release_socket_opt_in() {
        validate_inline_server_config(&inline_enabled_config(false), true).unwrap();
    }

    #[test]
    fn rejects_non_loopback_host_without_opt_in() {
        let mut config = inline_enabled_config(true);
        config.inline_server.host = "0.0.0.0".into();
        let error = validate_inline_server_config(&config, true)
            .expect_err("non-loopback host should require allow_non_loopback");
        assert!(error.to_string().contains("allowNonLoopback"));
    }

    #[test]
    fn allows_non_loopback_host_with_opt_in() {
        let mut config = inline_enabled_config(true);
        config.inline_server.host = "0.0.0.0".into();
        config.allow_non_loopback = true;
        validate_inline_server_config(&config, true).unwrap();
    }

    #[test]
    fn loopback_hosts_are_recognized() {
        assert!(host_is_loopback("127.0.0.1"));
        assert!(host_is_loopback("::1"));
        assert!(host_is_loopback("localhost"));
        assert!(!host_is_loopback("0.0.0.0"));
        assert!(!host_is_loopback("192.168.1.4"));
    }
}
