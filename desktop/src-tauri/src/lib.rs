// questboard desktop shell. It does two things: make sure the project's board server is running, then show
// the board in a native window. The window loads the server's own page, so the server's same-origin write
// rules stay in force and the page gets no desktop (IPC) permissions.
mod server;
mod settings;

use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, Url, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use server::Health;
use settings::{ProjectInfo, Settings};

/// The server process this app started (never one it merely found running), and whether the app is closing.
/// Both live under one lock so a server spawned while the app exits is either seen by the exit handler or
/// killed by the start thread, never left running.
#[derive(Default)]
struct Owned {
    child: Option<Child>,
    closing: bool,
}

#[derive(Default)]
struct OwnedServer(Mutex<Owned>);

const START_TIMEOUT: Duration = Duration::from_secs(20);

fn show_status(window: &WebviewWindow, text: &str, is_error: bool) {
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.setStatus && window.setStatus({text}, {is_error})"));
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join("desktop.json")).map_err(|e| e.to_string())
}

fn choose_project(app: &tauri::AppHandle, stored: &Settings) -> Result<ProjectInfo, String> {
    if let Ok(env_project) = std::env::var("QUESTBOARD_PROJECT") {
        return settings::read_project(&PathBuf::from(env_project));
    }
    if let Some(project) = &stored.project {
        if let Ok(info) = settings::read_project(project) {
            return Ok(info);
        }
    }
    let picked = app
        .dialog()
        .file()
        .set_title("选择游戏项目文件夹（里面要有 questboard.config.json）")
        .blocking_pick_folder()
        .ok_or("没有选择项目文件夹。关掉再打开可以重新选。")?;
    let folder = picked.into_path().map_err(|e| e.to_string())?;
    let info = settings::read_project(&folder)?;
    let file = settings_file(app)?;
    settings::save(&file, &Settings { project: Some(folder), ..stored.clone() })?;
    Ok(info)
}

fn questboard_candidates(app: &tauri::AppHandle, stored: &Settings) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(root) = std::env::var("QUESTBOARD_ROOT") {
        candidates.push(PathBuf::from(root));
    }
    if let Some(root) = &stored.questboard_root {
        candidates.push(root.clone());
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("questboard"));
    }
    // Running from a checkout (tauri dev): desktop/src-tauri/../..
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join(".."));
    candidates
}

fn start(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<Url, String> {
    let file = settings_file(app)?;
    let stored = settings::load(&file);
    show_status(window, "正在找项目", false);
    let project = choose_project(app, &stored)?;
    let url = format!("http://127.0.0.1:{}/", project.port).parse::<Url>().map_err(|e| e.to_string())?;
    match server::check_health(project.port, &project.name, &project.root) {
        Health::Ours => return Ok(url),
        Health::Other(reason) => return Err(format!("{reason}（端口 {}）。请关掉占用的程序，或在项目配置里换一个 port。", project.port)),
        Health::Down => {}
    }
    show_status(window, &format!("正在启动「{}」的看板服务器", project.name), false);
    let root = server::locate_questboard(&questboard_candidates(app, &stored))?;
    let node = stored.node.clone().unwrap_or_else(|| "node".into());
    let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("server.log");
    let mut child = server::spawn_server(&node, &root, &project.root, &log)?;
    let owned = app.state::<OwnedServer>();
    {
        let mut guard = owned.0.lock().map_err(|e| e.to_string())?;
        if guard.closing {
            let _ = child.kill();
            let _ = child.wait();
            return Err("应用正在关闭".into());
        }
        guard.child = Some(child);
    }
    let exited = || -> Option<String> {
        let Ok(mut guard) = owned.0.lock() else { return Some("应用状态已损坏".into()) };
        if guard.closing {
            return Some("应用正在关闭".into());
        }
        match guard.child.as_mut().map(|child| child.try_wait()) {
            Some(Ok(Some(status))) => Some(format!("看板服务器启动后立刻退出了（{status}），详情见日志")),
            Some(Ok(None)) => None,
            Some(Err(error)) => Some(format!("无法查看看板服务器进程：{error}")),
            None => Some("看板服务器已被停止".into()),
        }
    };
    server::wait_until_ready(project.port, &project.name, &project.root, START_TIMEOUT, exited)
        .map_err(|reason| format!("{reason}\n日志：{}", log.display()))?;
    Ok(url)
}

fn stop_owned_server(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<OwnedServer>() {
        // A poisoned lock still holds the child; kill it anyway.
        let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.closing = true;
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OwnedServer::default())
        .setup(|app| {
            let handle = app.handle().clone();
            let window = app.get_webview_window("main").ok_or("tauri.conf.json must define the main window")?;
            // Off the main thread: the folder picker and the health polling block.
            std::thread::spawn(move || match start(&handle, &window) {
                Ok(url) => {
                    if let Err(error) = window.navigate(url) {
                        show_status(&window, &format!("打不开看板页面：{error}"), true);
                    }
                }
                Err(message) => show_status(&window, &message, true),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("questboard desktop failed to build");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            stop_owned_server(handle);
        }
    });
}
