const COMMANDS: &[&str] = &[
    "agent_snapshot",
    "agent_action",
    "agent_screenshot",
    "agent_events",
    "agent_windows",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
