const COMMANDS: &[&str] = &[
    "agent_attach",
    "agent_snapshot",
    "agent_action",
    "agent_screenshot",
    "agent_logs",
    "agent_events",
    "agent_windows",
    "agent_wait",
    "agent_state",
    "agent_record",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
