use tauri::{plugin::TauriPlugin, Manager, Runtime};

mod bridge;
mod commands;
mod endpoint;
mod error;
mod models;
mod screenshot;
mod server;

pub use endpoint::{
    endpoint_registry_path, endpoint_runtime_dir, read_endpoint_registry, remove_endpoint_registry,
    write_endpoint_registry, AgentEndpointDescriptor, EndpointRegistryError,
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
    AgentStorageEntry, AgentStorageRequest, AgentStorageResponse, AgentWaitRequest,
    AgentWaitResponse, AgentWindowRequest, Config, CookieAction, InlineServerConfig,
    LocationAction, RecordAction, SnapshotMode, StorageAction, StorageArea, WindowAction,
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

pub struct Builder;

impl Builder {
    pub fn new() -> Self {
        Self
    }

    pub fn build<R: Runtime>(self) -> TauriPlugin<R, Option<Config>> {
        tauri::plugin::Builder::<R, Option<Config>>::new("agent")
            .setup(|app, api| {
                let config = api.config().clone().unwrap_or_default();
                app.manage(bridge::AgentBridge::default());
                let endpoint = if config.inline_server.enabled {
                    let server = server::start_inline_debugger_server(
                        app.clone(),
                        app.config().identifier.clone(),
                        &config.inline_server,
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
