// Finds or starts the board server for a project.
use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, PartialEq)]
pub enum Health {
    /// Nothing answers on the port.
    Down,
    /// The board server for this project answers.
    Ours,
    /// Something else holds the port (another project's board, or another program).
    Other(String),
}

pub fn check_health(port: u16, project_name: &str, project_root: &Path) -> Health {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return Health::Down;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Health::Other("端口有程序在监听，但不回应".into());
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    classify_health(&response, project_name, project_root)
}

/// A board is ours only when both the project name and the project folder match: two projects can share a
/// name, and the folder is what the server was started with.
pub fn classify_health(response: &str, project_name: &str, project_root: &Path) -> Health {
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    let Ok(value) = serde_json::from_str::<serde_json::Value>(body) else {
        return Health::Other("端口被别的程序占用".into());
    };
    if value.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Health::Other("端口被别的程序占用".into());
    }
    let Some(name) = value.get("project").and_then(|v| v.as_str()) else {
        return Health::Other("端口上的看板没有报告项目名".into());
    };
    let root = value.get("root").and_then(|v| v.as_str()).unwrap_or("");
    if name != project_name {
        Health::Other(format!("端口已被项目「{name}」的看板占用"))
    } else if same_folder(root, project_root) {
        Health::Ours
    } else {
        Health::Other(format!("端口已被另一个同名项目「{name}」的看板占用（{root}）"))
    }
}

fn normalize_folder(path: &str) -> String {
    let unified = path.replace('\\', "/");
    let trimmed = unified.strip_prefix("//?/").unwrap_or(&unified).trim_end_matches('/');
    if cfg!(windows) { trimmed.to_lowercase() } else { trimmed.to_string() }
}

fn same_folder(reported: &str, expected: &Path) -> bool {
    if reported.is_empty() {
        return false;
    }
    let expected = std::fs::canonicalize(expected).unwrap_or_else(|_| expected.to_path_buf());
    let reported = std::fs::canonicalize(reported).unwrap_or_else(|_| PathBuf::from(reported));
    normalize_folder(&reported.to_string_lossy()) == normalize_folder(&expected.to_string_lossy())
}

/// The questboard checkout that holds src/cli/questboard.js.
pub fn locate_questboard(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    candidates
        .iter()
        .find(|dir| dir.join("src").join("cli").join("questboard.js").is_file())
        .cloned()
        .ok_or_else(|| {
            let looked: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
            format!("找不到 questboard 程序（src/cli/questboard.js）。找过：{}", looked.join("；"))
        })
}

/// The arguments that set up a project folder. Separate so a test can check them without running Node.
pub fn init_args(questboard_root: &Path, project: &Path) -> Vec<String> {
    vec![
        questboard_root.join("src").join("cli").join("questboard.js").to_string_lossy().into_owned(),
        "init".into(),
        project.to_string_lossy().into_owned(),
    ]
}

/// Node prints an uncaught failure as a stack whose FIRST line is just the module and line number
/// ("node:fs:2749"); the line worth showing is the one carrying the message. Falls back to the first lines
/// rather than that useless header.
pub fn first_useful_error(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
    let pick = lines
        .iter()
        .find(|line| line.contains("Error:") || line.contains("错误"))
        .copied()
        .unwrap_or_else(|| {
            lines
                .iter()
                .find(|line| !line.starts_with("at ") && !line.starts_with("node:") && *line != &"throw err;" && !line.starts_with('^'))
                .copied()
                .unwrap_or("questboard init 没有说明原因")
        });
    pick.chars().take(300).collect()
}

/// Runs `questboard init` on a folder and waits for it. Returns what it printed, so the window can say what
/// was written; the CLI is the only place that knows how to set a project up. Everything it printed is also
/// written to `log_file`, because a one-line dialog is never enough to debug a failed setup.
pub fn run_init(node: &str, questboard_root: &Path, project: &Path, log_file: &Path) -> Result<String, String> {
    let mut command = Command::new(node);
    command.args(init_args(questboard_root, project)).current_dir(questboard_root).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|e| format!("启动 Node 失败（{node}）：{e}。需要安装 Node 22"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if let Some(dir) = log_file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        log_file,
        format!("$ {node} {}\n\n--- stdout\n{stdout}\n--- stderr\n{stderr}\n", init_args(questboard_root, project).join(" ")),
    );
    if !output.status.success() {
        return Err(format!("建项目失败：{}\n\n完整输出：{}", first_useful_error(&stderr), log_file.display()));
    }
    Ok(stdout)
}

pub fn spawn_server(node: &str, questboard_root: &Path, project: &Path, log_file: &Path) -> Result<Child, String> {
    if let Some(dir) = log_file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    }
    let log = File::create(log_file).map_err(|e| format!("无法写日志 {}：{e}", log_file.display()))?;
    let err_log = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command
        .arg(questboard_root.join("src").join("cli").join("questboard.js"))
        .arg("serve")
        .arg("--project")
        .arg(project)
        .current_dir(questboard_root)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|e| format!("启动 Node 失败（{node}）：{e}。需要安装 Node 22 或在设置里指定 node 路径"))
}

/// Polls until the project's server answers, `exited` reports it gone (it exited, or the app is closing), or
/// the timeout passes.
pub fn wait_until_ready(
    port: u16,
    project_name: &str,
    project_root: &Path,
    timeout: Duration,
    mut exited: impl FnMut() -> Option<String>,
) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        match check_health(port, project_name, project_root) {
            Health::Ours => return Ok(()),
            Health::Other(reason) => return Err(reason),
            Health::Down => {}
        }
        if let Some(reason) = exited() {
            return Err(reason);
        }
        sleep(Duration::from_millis(250));
    }
    Err(format!("等了 {} 秒，看板服务器还没有响应，详情见日志", timeout.as_secs()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health_response(project: &str, root: Option<&str>) -> String {
        let mut body = serde_json::json!({ "ok": true, "project": project });
        if let Some(root) = root {
            body["root"] = serde_json::Value::from(root);
        }
        format!("HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\r\n{body}")
    }

    #[test]
    fn classifies_health_responses() {
        let root = std::env::temp_dir();
        let ours = health_response("My Game", Some(&root.to_string_lossy()));
        assert_eq!(classify_health(&ours, "My Game", &root), Health::Ours);
        assert!(matches!(classify_health(&ours, "Other", &root), Health::Other(reason) if reason.contains("My Game")));
        assert!(matches!(classify_health("HTTP/1.1 404 Not Found\r\n\r\n<html>", "x", &root), Health::Other(_)));
    }

    #[test]
    fn a_same_named_project_in_another_folder_is_not_ours() {
        let root = std::env::temp_dir();
        let elsewhere = health_response("My Game", Some("Z:/other/game"));
        assert!(matches!(classify_health(&elsewhere, "My Game", &root), Health::Other(reason) if reason.contains("同名")));
        let no_root = health_response("My Game", None);
        assert!(matches!(classify_health(&no_root, "My Game", &root), Health::Other(_)));
    }

    #[test]
    fn folder_comparison_ignores_separators_prefix_and_trailing_slash() {
        assert_eq!(normalize_folder("E:\\game\\"), normalize_folder("E:/game"));
        assert_eq!(normalize_folder("\\\\?\\E:\\game"), normalize_folder("E:/game"));
    }

    #[test]
    fn nothing_listening_is_down() {
        assert_eq!(check_health(1, "x", Path::new("x")), Health::Down);
    }

    #[test]
    fn waiting_stops_when_the_server_is_reported_gone() {
        let result = wait_until_ready(1, "x", Path::new("x"), Duration::from_secs(5), || Some("closing".into()));
        assert_eq!(result.unwrap_err(), "closing");
    }

    #[test]
    fn shows_the_message_from_a_node_stack_not_its_header() {
        let stack = "node:fs:2749\n    throw err;\n    ^\n\nError: EPERM: operation not permitted, mkdir 'D:\\x'\n    at mkdirSync (node:fs:1)\n";
        assert!(first_useful_error(stack).starts_with("Error: EPERM"), "got {}", first_useful_error(stack));
        // A questboard error is caught and printed as one plain line.
        assert_eq!(first_useful_error("questboard.config.json exists; pass --force\n"), "questboard.config.json exists; pass --force");
        assert_eq!(first_useful_error(""), "questboard init 没有说明原因");
    }

    #[test]
    fn builds_the_setup_command_for_the_picked_folder() {
        let args = init_args(Path::new("E:/questboard"), Path::new("D:/my game"));
        assert_eq!(args[1], "init");
        assert_eq!(args[2], "D:/my game", "a folder with a space is one argument, not two");
        assert!(args[0].ends_with("questboard.js"));
        assert!(args[0].contains("cli"));
    }

    #[test]
    fn locates_the_checkout_or_names_where_it_looked() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..");
        assert!(locate_questboard(&[PathBuf::from("Z:/nowhere"), root.clone()]).is_ok());
        assert!(locate_questboard(&[PathBuf::from("Z:/nowhere")]).unwrap_err().contains("Z:/nowhere"));
    }
}
