#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    webview::WebviewWindowBuilder,
    AppHandle, Manager, Runtime, WebviewUrl,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Child;
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{sleep, Duration};

// === Config ===

struct AgentConfig {
    agent_entry: PathBuf,
    http_port: u16,
}

impl AgentConfig {
    fn from_env() -> Self {
        let agent_entry = if cfg!(debug_assertions) {
            PathBuf::from("/mnt/d/projects/desktopwork/desktop-agent/src/index.ts")
        } else {
            std::env::var("DESKTOP_AGENT_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    PathBuf::from("/mnt/d/projects/desktopwork/desktop-agent/src/index.ts")
                })
        };

        let http_port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3737);

        Self { agent_entry, http_port }
    }

    fn base_url(&self) -> String {
        format!("http://localhost:{}/", self.http_port)
    }
}

// === Node Process Manager ===

struct NodeProcess {
    child: AsyncMutex<Option<Child>>,
    http_port: u16,
    base_url: String,
}

impl NodeProcess {
    fn new(http_port: u16, base_url: String) -> Self {
        Self {
            child: AsyncMutex::new(None),
            http_port,
            base_url,
        }
    }

    async fn start(&self, entry: &PathBuf) -> Result<(), String> {
        let (cmd, args) = self.start_cmd_for(entry);

        log::info!("Spawning Node: {} {:?}", cmd, args);

        let mut child = tokio::process::Command::new(cmd)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("Failed to spawn Node process: {}", e))?;

        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout).lines();
            tokio::spawn(async move {
                while reader.next_line().await.is_ok() {}
            });
        }

        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }

        self.wait_for_ready().await?;
        log::info!("Node HTTP server ready at {}", self.base_url);
        Ok(())
    }

    fn start_cmd_for(&self, entry: &PathBuf) -> (&'static str, Vec<String>) {
        if entry.extension().map(|e| e == "ts").unwrap_or(false) {
            ("tsx", vec![entry.to_string_lossy().to_string()])
        } else {
            ("node", vec![entry.to_string_lossy().to_string()])
        }
    }

    async fn wait_for_ready(&self) -> Result<(), String> {
        for attempt in 1..=60 {
            let addr = format!("127.0.0.1:{}", self.http_port);
            if std::net::TcpStream::connect(&addr).is_ok() {
                sleep(Duration::from_secs(1)).await;
                return Ok(());
            }
            if attempt % 10 == 0 {
                log::debug!("Server not ready (attempt {})", attempt);
            }
            sleep(Duration::from_millis(500)).await;
        }
        Err("Node HTTP server did not become ready in 30s".to_string())
    }

    async fn stop(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(ref mut child) = guard.take() {
            log::info!("Stopping Node process");
            child.kill().await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

// === App State ===

struct AppState {
    node_process: Arc<NodeProcess>,
}

// === Menu ===

fn create_menu<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let reload = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(app)
        .map_err(|e| e.to_string())?;

    let quit = MenuItemBuilder::with_id("quit", "Quit DesktopWork")
        .accelerator("CmdOrCtrl+Q")
        .build(app)
        .map_err(|e| e.to_string())?;

    let menu = MenuBuilder::new(app)
        .item(&reload)
        .separator()
        .item(&quit)
        .build()
        .map_err(|e| e.to_string())?;

    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

// === Main ===

fn main() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();

    let config = AgentConfig::from_env();
    log::info!("DesktopWork Shell starting");
    log::info!("  Agent entry: {:?}", config.agent_entry);
    log::info!("  HTTP port: {}", config.http_port);

    // Extract values before builder chain so config can be dropped
    let agent_entry = config.agent_entry.clone();
    let http_port = config.http_port;
    let base_url = config.base_url();
    drop(config);

    let node_process = Arc::new(NodeProcess::new(http_port, base_url.clone()));
    let node_process_for_state = Arc::clone(&node_process);
    let node_process_for_async = Arc::clone(&node_process);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            node_process: node_process_for_state,
        })
        .setup(|app| {
            let handle = app.app_handle().clone();
            let handle_for_window = handle.clone();
            let entry = agent_entry;
            let node_proc = node_process_for_async;

            tauri::async_runtime::spawn(async move {
                if let Err(e) = node_proc.start(&entry).await {
                    log::error!("Failed to start Node process: {}", e);
                    std::process::exit(1);
                }

                let base_url = node_proc.base_url.clone();
                let window = WebviewWindowBuilder::new(
                    &handle_for_window,
                    "main",
                    WebviewUrl::External(base_url.parse().unwrap()),
                )
                .title("DesktopWork")
                .inner_size(900.0, 700.0)
                .min_inner_size(600.0, 400.0)
                .resizable(true)
                .build();

                if let Err(e) = window {
                    log::error!("Failed to create window: {}", e);
                    std::process::exit(1);
                }
                let window = window.unwrap();
                let node_proc2 = Arc::clone(&node_proc);
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { .. } = event {
                        let np = Arc::clone(&node_proc2);
                        tokio::spawn(async move {
                            let _ = np.stop().await;
                            std::process::exit(0);
                        });
                    }
                });
            });

            if let Err(e) = create_menu(&handle) {
                log::warn!("Failed to create menu: {}", e);
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "reload" => {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval("window.location.reload()");
                    }
                }
                "quit" => {
                    let app_handle = app.app_handle().clone();
                    tokio::spawn(async move {
                        let state = app_handle.state::<AppState>();
                        let _ = state.node_process.stop().await;
                        std::process::exit(0);
                    });
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}