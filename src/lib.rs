use tauri::{plugin::TauriPlugin, Manager, Runtime};

mod commands;
mod endpoint;
mod error;
mod models;

pub use endpoint::{endpoint_registry_path, endpoint_runtime_dir, AgentEndpointDescriptor};
pub use error::Error;
pub use models::{
    AgentAction, AgentActionRequest, AgentAttachRequest, AgentAttachResponse, AgentEventEntry,
    AgentEventsRequest, AgentLogEntry, AgentLogRequest, AgentRecordEntry, AgentRecordRequest,
    AgentRecordResponse, AgentScreenshotRequest, AgentSnapshotRequest, AgentStateRequest,
    AgentWaitRequest, AgentWaitResponse, Config, RecordAction, SnapshotMode, WindowInfo,
};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug)]
pub struct Agent {
    config: Config,
}

impl Agent {
    pub fn config(&self) -> &Config {
        &self.config
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
                app.manage(Agent { config });
                Ok(())
            })
            .invoke_handler(tauri::generate_handler![
                commands::agent_attach,
                commands::agent_snapshot,
                commands::agent_action,
                commands::agent_screenshot,
                commands::agent_logs,
                commands::agent_events,
                commands::agent_windows,
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
