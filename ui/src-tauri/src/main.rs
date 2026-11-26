#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

use anyhow::{Context, bail};
use plintharc::server::{DEFAULT_PORT, LocalServer, ServerConfig, default_data_dir};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_dialog::DialogExt;

const MAIN_WINDOW: &str = "main";

struct ArcOrigin(Url);

fn is_arc_origin(url: &Url, arc: &Url) -> bool {
    url.scheme() == "http" && url.origin() == arc.origin()
}

#[tauri::command]
async fn choose_directory(
    window: WebviewWindow,
    origin: State<'_, ArcOrigin>,
) -> Result<Option<String>, String> {
    let caller = window.url().map_err(|error| error.to_string())?;
    if window.label() != MAIN_WINDOW || !is_arc_origin(&caller, &origin.0) {
        return Err("The directory picker is available in the PlinthArc window.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let Some(selected) = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Choose a directory")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        let path = path
            .into_os_string()
            .into_string()
            .map_err(|_| "The selected directory path is not valid UTF-8.".to_owned())?;
        Ok(Some(path))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn frontend_directory(app: &tauri::App) -> anyhow::Result<PathBuf> {
    if let Ok(resources) = app.path().resource_dir() {
        let bundled = resources.join("arc");
        if bundled.join("index.html").is_file() {
            return Ok(bundled);
        }
    }

    #[cfg(debug_assertions)]
    {
        let developer_dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        if developer_dist.join("index.html").is_file() {
            return Ok(developer_dist);
        }
    }

    bail!("Arc's built files are missing. Build the UI before starting PlinthArc.")
}

fn main() -> anyhow::Result<()> {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![choose_directory])
        .setup(|app| {
            let server = LocalServer::bind(ServerConfig {
                data_dir: std::env::var_os("PLINTHARC_DATA_DIR")
                    .map(PathBuf::from)
                    .map_or_else(default_data_dir, Ok)?,
                ui_dir: frontend_directory(app)?,
                engine: std::env::var_os("PLINTHARC_ENGINE").map(PathBuf::from),
                port: DEFAULT_PORT,
            })?;
            let url = Url::parse(server.origin())
                .context("The local Arc server returned an invalid URL")?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || url.port() != Some(DEFAULT_PORT)
            {
                return Err("The local Arc server returned an unexpected loopback origin".into());
            }
            app.manage(ArcOrigin(url.clone()));
            let navigation_origin = url.clone();

            tauri::async_runtime::spawn(async move {
                if let Err(error) = server.run().await {
                    eprintln!("Local Arc server stopped: {error:#}");
                }
            });
            WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::External(url))
                .title("PlinthArc")
                .inner_size(1200.0, 800.0)
                .on_navigation(move |destination| is_arc_origin(destination, &navigation_origin))
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())?;
    Ok(())
}
