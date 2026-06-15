#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
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
use tracing::{error, info, warn};
use tracing_appender::rolling::{RollingFileAppender, Rotation};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

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
        let http_port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3737);

        let server_entry = if cfg!(debug_assertions) {
            PathBuf::from("/mnt/d/projects/desktopwork/desktop-agent/src/index.ts")
        } else {
            env::current_exe()
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

// === Log dir ===

fn log_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| {
        let home = env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("."));
        home.join(".local/share")
    });
    base.join("desktopwork/logs")
}

// === Log level resolution ===

fn parse_log_level() -> String {
    // CLI flag wins: --log-level=debug
    for (i, arg) in env::args().enumerate() {
        if arg == "--log-level" && i + 1 < env::args().len() {
            return env::args().nth(i + 1).unwrap_or_else(|| "info".to_string());
        }
    }
    // RUST_LOG env var fallback
    env::var("RUST_LOG").unwrap_or_else(|_| "info".to_string())
}

fn setup_logging() {
    let log_path = log_dir();
    let _ = std::fs::create_dir_all(&log_path);

    let file_appender = RollingFileAppender::new(Rotation::DAILY, &log_path, "desktopwork.log");
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    // Leak the guard so it lives for the entire process lifetime
    Box::leak(Box::new(_guard));

    let level_str = parse_log_level();
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::try_from(level_str.as_str()).unwrap_or_default());

    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr).with_ansi(false))
        .init();
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

        info!("Spawning Node: {} {:?}", cmd, args);

        let mut child = tokio::process::Command::new(&cmd)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn Node process: {}", e))?;

        // Pipe Node stdout into the tracing logger with [node] prefix
        if let Some(stdout) = child.stdout.take() {
            let mut reader = BufReader::new(stdout).lines();
            tokio::spawn(async move {
                while let Ok(Some(line)) = reader.next_line().await {
                    info!("[node] {}", line);
                }
            });
        }

        // Pipe Node stderr into the tracing logger with [node] prefix
        if let Some(stderr) = child.stderr.take() {
            let mut reader = BufReader::new(stderr).lines();
            tokio::spawn(async move {
                while let Ok(Some(line)) = reader.next_line().await {
                    error!("[node] {}", line);
                }
            });
        }

        {
            let mut guard = self.child.lock().await;
            *guard = Some(child);
        }

        self.wait_for_ready().await?;
        info!("Node HTTP server ready at {}", self.base_url);
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
                warn!("Server not ready (attempt {})", attempt);
            }
            sleep(Duration::from_millis(500)).await;
        }
        Err("Node HTTP server did not become ready in 30s".to_string())
    }

    async fn stop(&self) -> Result<(), String> {
        let mut guard = self.child.lock().await;
        if let Some(ref mut child) = guard.take() {
            info!("Stopping Node process");
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

// === Loading splash HTML (embedded) ===
const SPLASH_HTML: &str = r#"<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 100vw; height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #1a1a2e;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e0e0e0;
    }
    .card {
      text-align: center;
      padding: 40px;
    }
    .logo {
      width: 64px; height: 64px;
      margin: 0 auto 24px;
      background: #4a90d9;
      border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; font-weight: 700; color: #fff;
    }
    h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: #888; }
    .spinner {
      margin: 24px auto 0;
      width: 32px; height: 32px;
      border: 3px solid #333;
      border-top-color: #4a90d9;
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">DW</div>
    <h2>DesktopWork</h2>
    <p>Starting...</p>
    <div class="spinner"></div>
  </div>
</body>
</html>"#;

// === Main ===

fn main() {
    setup_logging();

    let config = AgentConfig::from_env();
    info!("DesktopWork starting");
    info!("  Server entry: {:?}", config.server_entry);
    info!("  HTTP port: {}", config.http_port);
    info!("  Runner: {}", if config.is_ts_source() { "tsx" } else { "node" });

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
            let entry = server_entry;
            let node_proc = node_process_for_async;
            let agent_config = AgentConfig {
                server_entry: entry,
                http_port,
            };

            // Step 1: Create window IMMEDIATELY with embedded splash HTML.
            // This prevents the black OS window from showing.
            // data URL loads instantly without any network request.
            let splash_url = format!("data:text/html,{}", urlencoding::encode(SPLASH_HTML));
            let window = WebviewWindowBuilder::new(
                &handle,
                "main",
                WebviewUrl::External(splash_url.parse().unwrap()),
            )
            .title("DesktopWork")
            .inner_size(900.0, 700.0)
            .min_inner_size(600.0, 400.0)
            .center()
            .resizable(true)
            .build()
            .map_err(|e| format!("Failed to create window: {}", e))?;

            // Step 2: Start Node HTTP server in background, then navigate
            tauri::async_runtime::spawn(async move {
                // Start Node process
                if let Err(e) = node_proc.start(&agent_config).await {
                    error!("Failed to start Node process: {}", e);
                    // Show error in the webview
                    let _ = window.eval(&format!(
                        "document.body.innerHTML = '<div style=\"padding:40px;font-family:sans-serif;color:#e74c3c;\"><h2>Failed to start server</h2><p>{}</p></div>'",
                        e
                    ));
                    return;
                }

                // Step 3: Node is ready — navigate to the actual app
                let navigate_js = format!("window.location.href = '{}';", node_proc.base_url);
                if let Err(e) = window.eval(&navigate_js) {
                    error!("Failed to navigate to app: {}", e);
                }

                // Set up close handler after window is ready
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
                warn!("Failed to create menu: {}", e);
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