use serde_json::Value;
use tauri::State;

use crate::AppState;

#[tauri::command]
pub async fn agent_status(state: State<'_, AppState>) -> Result<Value, String> {
    state.agent.send_request("status", None).await
}

#[tauri::command]
pub async fn agent_reload(state: State<'_, AppState>) -> Result<Value, String> {
    state.agent.send_request("reload", None).await
}

#[tauri::command]
pub async fn agent_shutdown(state: State<'_, AppState>) -> Result<(), String> {
    state.agent.shutdown().await
}

#[tauri::command]
pub async fn chat_send(
    message: String,
    session_key: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let params = serde_json::json!({
        "message": message,
        "sessionKey": session_key
    });

    let result = state.agent.send_request("chat", Some(params)).await?;

    let text = result
        .as_object()
        .and_then(|o| o.get("text"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(text)
}
