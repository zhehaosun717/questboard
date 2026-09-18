// questboard desktop shell. It does two things: make sure the project's board server is running, then show
// the board in a native window. The window loads the server's own page, so the server's same-origin write
// rules stay in force and the page gets no desktop (IPC) permissions.
mod server;
mod settings;

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::{Manager, RunEvent, Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

use server::{Board, Health, Process};
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
const SWITCH_PROJECT: &str = "switch-project";

fn show_status(window: &WebviewWindow, text: &str, is_error: bool) {
    let text = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    let _ = window.eval(format!("window.setStatus && window.setStatus({text}, {is_error})"));
}

fn settings_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_config_dir().map(|dir| dir.join("desktop.json")).map_err(|e| e.to_string())
}

// A folder with no config is not a dead end: offer to set it up here, so someone who only ever double-clicks
// never has to open a terminal. The CLI does the writing — the window only asks and reports.
fn offer_setup(app: &tauri::AppHandle, window: &WebviewWindow, stored: &Settings, folder: &Path) -> Result<(), String> {
    let wanted = app
        .dialog()
        .message(format!(
            "{} 里还没有 questboard 项目。\n\n要现在在这里建一个吗？会写入 questboard.config.json、一份示例委托和 worker 包装脚本，并按这台机器上装了哪些 agent CLI 配好通道。",
            folder.display()
        ))
        .title("在这个文件夹建项目？")
        .buttons(MessageDialogButtons::OkCancelCustom("在这里建".into(), "算了".into()))
        .blocking_show();
    if !wanted {
        return Err(format!("{} 里没有 questboard.config.json。关掉再打开可以重新选文件夹。", folder.display()));
    }
    show_status(window, "正在建项目", false);
    let root = server::locate_questboard(&questboard_candidates(app, stored))?;
    let node = stored.node.clone().unwrap_or_else(|| "node".into());
    let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("init.log");
    server::run_init(&node, &root, folder, &log)?;
    Ok(())
}

// `force_pick` is the 切换项目 menu: always ask, even though a project is remembered.
fn choose_project(app: &tauri::AppHandle, window: &WebviewWindow, stored: &Settings, force_pick: bool) -> Result<ProjectInfo, String> {
    if !force_pick {
        // An explicit env var is for scripts: no dialogs, fail plainly.
        if let Ok(env_project) = std::env::var("QUESTBOARD_PROJECT") {
            return settings::read_project(&PathBuf::from(env_project));
        }
        if let Some(project) = &stored.project {
            if let Ok(info) = settings::read_project(project) {
                return Ok(info);
            }
        }
    }
    let picked = app
        .dialog()
        .file()
        .set_title("选择项目文件夹（没有配置也行，可以在里面新建）")
        .blocking_pick_folder()
        .ok_or("没有选择项目文件夹。关掉再打开可以重新选。")?;
    let folder = picked.into_path().map_err(|e| e.to_string())?;
    if !settings::has_config(&folder) {
        offer_setup(app, window, stored, &folder)?;
    }
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

/// How many ports up from a taken one the window looks before it stops offering to move a project.
const FREE_PORT_TRIES: u16 = 500;

fn board_url(port: u16) -> Result<Url, String> {
    format!("http://127.0.0.1:{port}/").parse::<Url>().map_err(|e| e.to_string())
}

/// What to do about a port that is already taken.
enum Resolution {
    /// Start the picked project: on the port it already has, or on the free one the owner moved it to.
    StartHere(ProjectInfo),
    /// Show the board that already holds the port instead.
    ShowRunning(Url),
}

/// A taken port used to be a dead end: the page that changes a project's port is behind the port itself,
/// the message named neither the program nor a way out, and the only advice was to close something the
/// owner could not identify. All of that happens here instead, without that page — the window says what
/// holds the port, then offers to move this project to a free port, open the board that already runs, or
/// end the program that holds it.
fn resolve_port_conflict(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    stored: &Settings,
    project: &ProjectInfo,
    reason: &str,
) -> Result<Resolution, String> {
    let port = project.port;
    let board = server::board_on(port);
    let holder = server::holder_process(port);
    let mut text = format!(
        "端口 {port} 被占用了。\n\n占着它的是：{}\n\n本项目「{}」（{}）连不上它。",
        holder_text(board.as_ref(), holder.as_ref()),
        project.name,
        project.root.display()
    );
    let Some(next_port) = server::free_port(port.saturating_add(1), FREE_PORT_TRIES, &settings::browser_unsafe_ports()) else {
        text.push_str(&format!("\n\n从 {port} 往上找了 {FREE_PORT_TRIES} 个端口，都被占着：换一个端口再试。"));
        app.dialog().message(text).title("端口被占用").buttons(MessageDialogButtons::Ok).blocking_show();
        return Err(format!("{reason}（端口 {port}）。"));
    };
    let change = format!("换成 {next_port}");
    let alternative = match (&board, &holder) {
        (Some(_), _) => "打开它的看板".to_string(),
        (None, Some(process)) => format!("结束 {}（PID {}）", process.image, process.pid),
        (None, None) => "算了".to_string(),
    };
    let moves = format!("【{change}】会把 {} 里的 port 改成 {next_port}（旧文件留一份备份）再启动", settings::CONFIG_FILE);
    match (&board, &holder) {
        (Some(_), _) => text.push_str(&format!("\n\n{moves}；【{alternative}】会打开正在跑的那个看板。")),
        (None, Some(_)) => text.push_str(&format!("\n\n{moves}；【{alternative}】会结束那个程序（它派出去的 worker 不会跟着关）。")),
        (None, None) => text.push_str(&format!("\n\n{moves}。")),
    }
    let chose_change = app
        .dialog()
        .message(text)
        .title("端口被占用")
        .buttons(MessageDialogButtons::OkCancelCustom(change, alternative.clone()))
        .blocking_show();
    if chose_change {
        let node = stored.node.clone().unwrap_or_else(|| "node".into());
        let root = server::locate_questboard(&questboard_candidates(app, stored))?;
        let log = app.path().app_log_dir().map_err(|e| e.to_string())?.join("port.log");
        show_status(window, &format!("正在把端口换成 {next_port}"), false);
        server::run_set_port(&node, &root, &project.root, next_port, &log)?;
        let updated = settings::read_project(&project.root)?;
        if updated.port != next_port {
            return Err(format!("端口没有改成 {next_port}，配置文件里还是 {}。日志：{}", updated.port, log.display()));
        }
        return Ok(Resolution::StartHere(updated));
    }
    if board.is_some() {
        return Ok(Resolution::ShowRunning(board_url(port)?));
    }
    if let Some(process) = &holder {
        let sure = app
            .dialog()
            .message(format!("要结束 {}（PID {}）吗？\n\n它会立刻被结束。看板自己派出去的 worker 不会跟着关。", process.image, process.pid))
            .title("结束这个程序？")
            .buttons(MessageDialogButtons::OkCancelCustom("结束它".into(), "算了".into()))
            .blocking_show();
        if sure {
            show_status(window, &format!("正在结束 {}（PID {}）", process.image, process.pid), false);
            server::kill_process(process.pid)?;
            return Ok(Resolution::StartHere(project.clone()));
        }
    }
    Err(format!("{reason}（端口 {port}）。"))
}

/// Who holds a port, in one sentence: a board names its project and folder, a program the system names
/// gets its image and PID, and a port nobody can be asked about says exactly that.
fn holder_text(board: Option<&Board>, process: Option<&Process>) -> String {
    let who = match board {
        Some(board) if board.root.is_empty() => format!("项目「{}」的看板", board.name),
        Some(board) => format!("项目「{}」的看板（{}）", board.name, board.root),
        None => "一个不是看板的程序".to_string(),
    };
    match process {
        Some(process) => format!("{who}，进程 {}（PID {}）", process.image, process.pid),
        None => format!("{who}，进程查不到"),
    }
}

fn start(app: &tauri::AppHandle, window: &WebviewWindow, force_pick: bool) -> Result<Url, String> {
    let file = settings_file(app)?;
    let stored = settings::load(&file);
    show_status(window, "正在找项目", false);
    let mut project = choose_project(app, window, &stored, force_pick)?;
    match server::check_health(project.port, &project.name, &project.root) {
        Health::Ours => return board_url(project.port),
        Health::Other(reason) => {
            show_status(window, &format!("端口 {} 被占用了", project.port), true);
            match resolve_port_conflict(app, window, &stored, &project, &reason)? {
                Resolution::ShowRunning(url) => return Ok(url),
                Resolution::StartHere(next) => project = next,
            }
        }
        Health::Down => {}
    }
    let url = board_url(project.port)?;
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
            Some(Ok(Some(status))) => {
                Some(format!("看板服务器启动后立刻退出了（{status}）：{}", server::exit_reason(&log)))
            }
            Some(Ok(None)) => None,
            Some(Err(error)) => Some(format!("无法查看看板服务器进程：{error}")),
            None => Some("看板服务器已被停止".into()),
        }
    };
    server::wait_until_ready(project.port, &project.name, &project.root, START_TIMEOUT, exited)
        .map_err(|reason| format!("{reason}\n日志：{}", log.display()))?;
    Ok(url)
}

// `shutting_down` marks the app as closing for good, which makes a server still being spawned kill itself.
// Switching projects must NOT set it: the next project starts a server right after.
fn stop_owned_server(app: &tauri::AppHandle, shutting_down: bool) {
    if let Some(state) = app.try_state::<OwnedServer>() {
        // A poisoned lock still holds the child; kill it anyway.
        let mut guard = state.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if shutting_down {
            guard.closing = true;
        }
        if let Some(mut child) = guard.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// The board page has no window.setStatus, so a failure while switching has to be a dialog or it is silent.
fn switch_project(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    stop_owned_server(app, false);
    let outcome = start(app, &window, true).and_then(|url| window.navigate(url).map_err(|e| format!("打不开看板页面：{e}")));
    if let Err(message) = outcome {
        app.dialog().message(message).title("切换项目失败").blocking_show();
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OwnedServer::default())
        .on_menu_event(|app, event| {
            if event.id().as_ref() != SWITCH_PROJECT {
                return;
            }
            // Off the main thread: the picker and the dialogs block.
            let handle = app.clone();
            std::thread::spawn(move || switch_project(&handle));
        })
        .setup(|app| {
            let switch = MenuItem::with_id(app, SWITCH_PROJECT, "切换项目…", true, None::<&str>)?;
            app.set_menu(Menu::with_items(app, &[&Submenu::with_items(app, "项目", true, &[&switch])?])?)?;
            let handle = app.handle().clone();
            let window = app.get_webview_window("main").ok_or("tauri.conf.json must define the main window")?;
            // Off the main thread: the folder picker and the health polling block.
            std::thread::spawn(move || match start(&handle, &window, false) {
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
            stop_owned_server(handle, true);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // The message the owner reads when a port is taken: it has to name the holder precisely enough to act
    // on, and never invent one it could not find.
    #[test]
    fn names_who_holds_a_port() {
        let board = Board { name: "Wastecape".into(), root: "E:/Wastecape".into() };
        let process = Process { pid: 24680, image: "node.exe".into() };
        let both = holder_text(Some(&board), Some(&process));
        assert!(both.contains("Wastecape") && both.contains("E:/Wastecape"), "{both}");
        assert!(both.contains("node.exe") && both.contains("24680"), "{both}");
        assert!(holder_text(None, Some(&process)).contains("不是看板"), "a program that is not a board is not called one");
        assert!(holder_text(None, None).contains("查不到"), "a port nobody can be asked about says so");
        let nameless = Board { name: "Other".into(), root: String::new() };
        assert_eq!(holder_text(Some(&nameless), None), "项目「Other」的看板，进程查不到", "no empty folder brackets, and an unknown process says so");
    }

    // With Tauri's native drag-drop on (the default), WebView2 on Windows swallows HTML5 drags: dragging a card
    // onto a quest shows the forbidden cursor and never drops, although the same page works in a browser.
    #[test]
    fn the_window_leaves_drag_and_drop_to_the_board() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let main = config["app"]["windows"].as_array().unwrap().iter().find(|w| w["label"] == "main").unwrap();
        assert_eq!(main["dragDropEnabled"], serde_json::Value::Bool(false));
    }
}
