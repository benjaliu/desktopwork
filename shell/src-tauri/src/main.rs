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
    /// Absolute path to the Node HTTP server entry JS file.
    /// In dev: desktop-agent/src/index.ts (tsx)
    /// In prod: resolved from bundled resources (node)
    server_entry: PathBuf,
    http_port: u16,
}

impl AgentConfig {
    fn from_env() -> Self {
        let http_port = std::env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3737);

        let server_entry = if cfg!(debug_assertions) {
            // Dev: use desktop-agent source dir, run with tsx
            PathBuf::from("/mnt/d/projects/desktopwork/desktop-agent/src/index.ts")
        } else {
            // Prod: bundled server is at {exe_dir}/server/dist/index.js
            std::env::current_exe()
                .map(|p| p.parent().unwrap_or(&p).join("server/dist/index.js"))
                .unwrap_or_else(|_| PathBuf::from("server/dist/index.js"))
        };

        Self {
            server_entry,
            http_port,
        }
    }

    fn base_url(&self) -> String {
        format!("http://localhost:{}/", self.http_port)
    }

    fn is_ts_source(&self) -> bool {
        self.server_entry.extension().map(|e| e == "ts").unwrap_or(false)
    }

    fn spawn_cmd(&self) -> (String, Vec<String>) {
        if self.is_ts_source() {
            ("tsx".to_string(), vec![self.server_entry.to_string_lossy().to_string()])
        } else {
            ("node".to_string(), vec![self.server_entry.to_string_lossy().to_string()])
        }
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

    async fn start(&self, config: &AgentConfig) -> Result<(), String> {
        let (cmd, args) = config.spawn_cmd();


        log::info!("Spawning Node: {} {:?}", cmd, args);

        let mut child = tokio::process::Command::new(&cmd)
            .args(args)
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
    log::info!("  Server entry: {:?}", config.server_entry);
    log::info!("  HTTP port: {}", config.http_port);
    log::info!("  Runner: {}", if config.is_ts_source() { "tsx" } else { "node" });

    // Extract values before builder chain
    let server_entry = config.server_entry.clone();
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
        .setup(move |app| {
            let handle = app.app_handle().clone();
            let handle_for_window = handle.clone();
            let entry = server_entry;
            let node_proc = node_process_for_async;

            // Config object to pass into async block
            let agent_config = AgentConfig {
                server_entry: entry,
                http_port,
            };

            tauri::async_runtime::spawn(async move {
                if let Err(e) = node_proc.start(&agent_config).await {
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