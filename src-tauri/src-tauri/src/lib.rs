use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::process::Stdio;
use std::sync::Mutex;
use tauri::{Emitter, AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader, AsyncWriteExt};
use tokio::process::{Command, ChildStdout};
use tokio::sync::Mutex as AsyncMutex;

mod commands;

// === IPC Types ===

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcRequest {
    jsonrpc: String,
    id: Value,
    method: String,
    #[serde(default)]
    params: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JsonRpcError {
    code: i32,
    message: String,
}

// === Desktop Agent Process Manager ===

pub struct DesktopAgent {
    child: AsyncMutex<Option<tokio::process::Child>>,
    reader: AsyncMutex<Option<BufReader<ChildStdout>>>,
    agent_path: String,
    app_handle: Mutex<Option<AppHandle>>,
}

impl DesktopAgent {
    pub fn new(agent_path: String) -> Self {
        Self {
            child: AsyncMutex::new(None),
            reader: AsyncMutex::new(None),
            agent_path,
            app_handle: Mutex::new(None),
        }
    }

    pub fn set_app_handle(&self, handle: AppHandle) {
        let mut guard = self.app_handle.lock().unwrap();
        *guard = Some(handle);
    }

    fn emit_stream_event(&self, event: &serde_json::Value) {
        let app_handle = self.app_handle.lock().unwrap();
        if let Some(ref handle) = *app_handle {
            let delta = event.pointer("/params/delta")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let done = event.pointer("/params/done")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            if let Some(text) = delta {
                let _ = handle.emit("streaming-delta", serde_json::json!({ "text": text, "done": done }));
            }
        }
    }

    async fn ensure_running(&self) -> Result<(), String> {
        // Check if already running
        {
            let child_guard = self.child.lock().await;
            if child_guard.is_some() {
                return Ok(());
            }
        }

        // Detect TypeScript file vs JS file — dev uses tsx, prod uses pre-bundled JS
        let use_tsx = self.agent_path.ends_with(".ts");
        let (cmd, args) = if use_tsx {
            ("tsx", vec![self.agent_path.clone()])
        } else {
            ("node", vec![self.agent_path.clone()])
        };

        let mut child = Command::new(cmd)
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn desktop-agent ({}): {}", cmd, e))?;

        // Create BufReader and store it (Bug #1 fix: reader persists, not consumed)
        let stdout = child.stdout.take().unwrap();
        let buf_reader = BufReader::new(stdout);

        // Store child and reader
        {
            let mut child_guard = self.child.lock().await;
            let mut reader_guard = self.reader.lock().await;
            *child_guard = Some(child);
            *reader_guard = Some(buf_reader);
        }

        // Write a ping to verify the agent is up
        let ping_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": "init",
            "method": "ping",
            "params": {}
        });
        let ping_line = serde_json::to_string(&ping_req).map_err(|e| e.to_string())?;
        let mut child_guard = self.child.lock().await;
        if let Some(ref mut stdin) = child_guard.as_mut().and_then(|c| c.stdin.as_mut()) {
            stdin
                .write_all((ping_line + "\n").as_bytes())
                .await
                .map_err(|e| format!("Failed to ping desktop-agent: {}", e))?;
            stdin.flush().await.map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    async fn send_request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.ensure_running().await?;

        let id = format!("req-{}", uuid_simple());
        let req = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id: Value::String(id),
            method: method.to_string(),
            params,
        };

        let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;

        // Write request
        {
            let mut child_guard = self.child.lock().await;
            if let Some(ref mut stdin) = child_guard.as_mut().and_then(|c| c.stdin.as_mut()) {
                stdin
                    .write_all((line.clone() + "\n").as_bytes())
                    .await
                    .map_err(|e| format!("Failed to write to desktop-agent: {}", e))?;
                stdin.flush().await.map_err(|e| e.to_string())?;
            }
        }

        // Read response
        let response = self.read_response().await?;
        Ok(response)
    }

    // Bug #3 fix: loop through all lines, skip stream events, return on JSON-RPC response
    async fn read_response(&self) -> Result<Value, String> {
        let mut reader_guard = self.reader.lock().await;
        let reader = reader_guard.as_mut().ok_or("No reader")?;

        loop {
            let mut line = String::new();
            let bytes_read = reader.read_line(&mut line).await
                .map_err(|e| format!("Read error: {}", e))?;
            if bytes_read == 0 {
                return Err("EOF".to_string());
            }

            let line = line.trim().to_string();
            if line.is_empty() {
                continue;
            }

            // Bug #2 fix: check if this is a stream event, emit to Tauri frontend
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if event.get("method").is_some() && event.get("params").is_some() {
                    self.emit_stream_event(&event);
                    continue;
                }
            }

            // Try to parse as JSON-RPC response
            if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(&line) {
                if let Some(err) = resp.error {
                    return Err(format!("Agent error {}: {}", err.code, err.message));
                }
                return resp.result.ok_or_else(|| "No result in response".to_string());
            }
        }
    }

    pub async fn shutdown(&self) -> Result<(), String> {
        let mut child_guard = self.child.lock().await;

        // Take child to drop it
        if let Some(ref mut child) = child_guard.take() {
            // Send shutdown request
            let req = serde_json::json!({
                "jsonrpc": "2.0",
                "id": "shutdown",
                "method": "shutdown",
                "params": {}
            });
            let line = serde_json::to_string(&req).map_err(|e| e.to_string())?;

            if let Some(ref mut stdin) = child.stdin.as_mut() {
                let _ = stdin.write_all((line + "\n").as_bytes()).await;
                let _ = stdin.flush().await;
            }

            // Wait for process to exit (with timeout)
            let _ = child.wait().await;
        }

        // Clear the reader
        let mut reader_guard = self.reader.lock().await;
        *reader_guard = None;
        Ok(())
    }
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:x}", now)
}

// === Tauri State ===

pub struct AppState {
    pub agent: DesktopAgent,
}

// === Library Setup ===

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let agent_path = if cfg!(debug_assertions) {
        "/mnt/d/projects/desktopwork/desktop-agent/src/index.ts".to_string()
    } else {
        std::env::var("DESKTOP_AGENT_PATH").unwrap_or_else(|_| {
            "/mnt/d/projects/desktopwork/desktop-agent/src/index.ts".to_string()
        })
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            agent: DesktopAgent::new(agent_path),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            state.agent.set_app_handle(handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::agent_status,
            commands::agent_reload,
            commands::agent_shutdown,
            commands::chat_send,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}