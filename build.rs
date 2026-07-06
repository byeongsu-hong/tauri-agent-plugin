const COMMANDS: &[&str] = &[
    "agent_bridge_response",
    "agent_attach",
    "agent_snapshot",
    "agent_action",
    "agent_inspect",
    "agent_eval",
    "agent_select",
    "agent_check",
    "agent_hover",
    "agent_focus",
    "agent_blur",
    "agent_scroll",
    "agent_drag",
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
