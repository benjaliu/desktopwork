#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::path::{Path, PathBuf};
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

// === Target triple helper (Tauri 2 sidecar renames externalBin to <name>-<target-triple>) ===

/// Cargo target triple. Tauri 2 renames `externalBin` entries from
/// `node` → `node-{target-triple}` (with `.exe` appended on Windows)
/// inside the bundle's resource directory at runtime.
fn current_target_triple() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") {
        "x86_64-apple-darwin"
    } else if cfg!(target_os = "windows") {
        "x86_64-pc-windows-msvc"
    } else {
        "x86_64-unknown-linux-gnu"
    }
}

// === Server entry resolution ===

/// Resolve the Node HTTP server entry file.
///
/// dev:  DESKTOPWORK_DEV_ENTRY env var → desktop-agent/src/index.ts (relative to CWD)
/// prod: {resource_dir}/server/dist/index.js (bundled by CI `pnpm deploy`)
fn resolve_server_entry<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    if cfg!(debug_assertions) {
        std::env::var("DESKTOPWORK_DEV_ENTRY")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("desktop-agent/src/index.ts"))
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .expect("failed to get resource dir");
        resource_dir.join("server").join("dist").join("index.js")
    }
}

// === Node runner resolution (dev = system PATH, prod = Tauri sidecar) ===

/// Resolve the Node runner command + args for the given entry.
///
/// dev:  system PATH `tsx` (for .ts) or `node` (for .js) — developer is expected to have Node.
/// prod: Tauri 2 sidecar `node-{platform}-{target-triple}` from the bundle's resource_dir.
fn resolve_node_runner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    entry: &Path,
) -> (PathBuf, Vec<String>) {
    if cfg!(debug_assertions) {
        let cmd = if entry.extension().map(|e| e == "ts").unwrap_or(false) {
            "tsx"
        } else {
            "node"
        };
        (PathBuf::from(cmd), vec![entry.to_string_lossy().to_string()])
    } else {
        let resource_dir = app
            .path()
            .resource_dir()
            .expect("failed to get resource dir");
        // Tauri 2 renames externalBin entries by appending the cargo target triple:
        //   node (externalBin base name)
        //     → node-x86_64-unknown-linux-gnu        (Linux)
        //     → node-x86_64-apple-darwin             (macOS Intel)
        //     → node-aarch64-apple-darwin            (macOS Apple Silicon)
        //     → node-x86_64-pc-windows-msvc.exe      (Windows)
        // The base name `node` lives in shell/node-binaries/ as a target-triple suffixed file
        // produced by the GitHub Actions workflow (`§9.13.5.1`-style download step).
        let sidecar_path = {
            #[allow(unused_mut)] // mut is needed on Windows for set_extension
            let mut p = resource_dir.join(format!("node-{}", current_target_triple()));
            #[cfg(windows)]
            {
                p.set_extension("exe");
            }
            p
        };
        (sidecar_path, vec![entry.to_string_lossy().to_string()])
    }
}

// === Config ===

struct AgentConfig {
    /// Absolute path to the Node HTTP server entry JS/TS file.
    server_entry: PathBuf,
    /// Node runner binary path (prod = sidecar, dev = "tsx"/"node" on PATH).
    node_runner: PathBuf,
    /// Args passed to the Node runner.
    node_args: Vec<String>,
    http_port: u16,
}

impl AgentConfig {
    fn build<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Self {
        let http_port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3737);

        let server_entry = resolve_server_entry(app);
        let (node_runner, node_args) = resolve_node_runner(app, &server_entry);

        Self {
            server_entry,
            node_runner,
            node_args,
            http_port,
        }
    }

    fn base_url(&self) -> String {
        format!("http://localhost:{}/", self.http_port)
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

    // Use try_init to avoid panic if subscriber is already initialized
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_writer(non_blocking).with_ansi(false))
        .with(fmt::layer().with_writer(std::io::stderr).with_ansi(false))
        .try_init();
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
        info!(
            "Spawning Node runner: {:?} {:?}",
            config.node_runner, config.node_args
        );

        let mut child = tokio::process::Command::new(&config.node_runner)
            .args(&config.node_args)
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

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.app_handle().clone();

            // Resolve runtime paths now that we have an AppHandle (so resource_dir is available).
            // In debug builds this also reads DESKTOPWORK_DEV_ENTRY.
            let agent_config = AgentConfig::build(&handle);

            info!("DesktopWork starting");
            info!("  Mode: {}", if cfg!(debug_assertions) { "dev" } else { "prod (sidecar)" });
            info!("  Server entry: {:?}", agent_config.server_entry);
            info!("  Node runner: {:?}", agent_config.node_runner);
            info!("  HTTP port: {}", agent_config.http_port);

            let node_proc = Arc::new(NodeProcess::new(agent_config.http_port, agent_config.base_url()));
            let node_proc_for_menu = Arc::clone(&node_proc);
            app.manage(AppState { node_process: node_proc_for_menu });

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
            let node_proc_for_async = Arc::clone(&node_proc);
            tauri::async_runtime::spawn(async move {
                // Start Node process
                if let Err(e) = node_proc_for_async.start(&agent_config).await {
                    error!("Failed to start Node process: {}", e);
                    // Show error in the webview
                    let _ = window.eval(&format!(
                        "document.body.innerHTML = '<div style=\"padding:40px;font-family:sans-serif;color:#e74c3c;\"><h2>Failed to start server</h2><p>{}</p></div>'",
                        e
                    ));
                    return;
                }

                // Step 3: Node is ready — navigate to the actual app
                let navigate_js = format!("window.location.href = '{}';", node_proc_for_async.base_url);
                if let Err(e) = window.eval(&navigate_js) {
                    error!("Failed to navigate to app: {}", e);
                }

                // Set up close handler after window is ready
                let node_proc2 = Arc::clone(&node_proc_for_async);
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