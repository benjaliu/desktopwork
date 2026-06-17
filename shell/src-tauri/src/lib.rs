// Library entry point for the Tauri shell.
// The actual app logic (Node sidecar spawn, Tauri builder, commands)
// is in main.rs. This file exists because Cargo.toml declares
// crate-type = ["cdylib", "rlib"] for Tauri 2's mobile/embedded build
// pipeline (Android/iOS targets need the lib form).
//
// v0.3.1.18: restart_server command is registered in main.rs's
// tauri::generate_handler! macro. Mobile targets would re-build the
// Tauri app via this lib and re-register the same handler.
