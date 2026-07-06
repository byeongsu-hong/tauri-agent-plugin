use tauri::{plugin::TauriPlugin, Manager, Runtime};

mod commands;
mod error;
mod models;

pub use error::Error;
pub use models::{
    AgentAction, AgentActionRequest, AgentScreenshotRequest, AgentSnapshotRequest, Config,
    SnapshotMode, WindowInfo,
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
                commands::agent_snapshot,
                commands::agent_action,
                commands::agent_screenshot,
                commands::agent_events,
                commands::agent_windows,
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
