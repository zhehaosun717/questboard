// Finds or starts the board server for a project.
use std::fs::File;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
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

/// A questboard board answering on a port, whoever it belongs to.
#[derive(Debug, Clone, PartialEq)]
pub struct Board {
    pub name: String,
    pub root: String,
}

/// One HTTP probe of the port's /api/health.
enum Probe {
    /// Nothing answers on the port.
    Down,
    /// A response came back.
    Body(String),
    /// Something holds the port but does not answer.
    Broken(String),
}

fn probe(port: u16) -> Probe {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return Probe::Down;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(1500)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return Probe::Broken("端口有程序在监听，但不回应".into());
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    Probe::Body(response)
}

pub fn check_health(port: u16, project_name: &str, project_root: &Path) -> Health {
    match probe(port) {
        Probe::Down => Health::Down,
        Probe::Broken(why) => Health::Other(why),
        Probe::Body(response) => classify_health(&response, project_name, project_root),
    }
}

/// The board serving a port, whichever project it belongs to. This is what lets the window name the board
/// holding a port instead of telling the owner to "close the program".
pub fn board_on(port: u16) -> Option<Board> {
    let Probe::Body(response) = probe(port) else { return None };
    let value = health_body(&response)?;
    let name = value.get("project").and_then(|v| v.as_str())?.to_string();
    let root = value.get("root").and_then(|v| v.as_str()).unwrap_or("").to_string();
    Some(Board { name, root })
}

/// A board's /api/health body: an object that says `ok: true`.
fn health_body(response: &str) -> Option<serde_json::Value> {
    let body = response.split("\r\n\r\n").nth(1).unwrap_or("");
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    (value.get("ok").and_then(|v| v.as_bool()) == Some(true)).then_some(value)
}

/// A board is ours only when both the project name and the project folder match: two projects can share a
/// name, and the folder is what the server was started with.
pub fn classify_health(response: &str, project_name: &str, project_root: &Path) -> Health {
    let Some(value) = health_body(response) else {
        return Health::Other("端口被别的程序占用".into());
    };
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

/// The process holding a listening port, when the system will say. Windows only: elsewhere the port is
/// still reported, just without a program to name or end.
#[derive(Debug, Clone, PartialEq)]
pub struct Process {
    pub pid: u32,
    pub image: String,
}

pub fn holder_process(port: u16) -> Option<Process> {
    let pid = listening_pid(port)?;
    Some(Process { pid, image: process_image(pid).unwrap_or_else(|| "未知程序".into()) })
}

#[cfg(windows)]
fn listening_pid(port: u16) -> Option<u32> {
    let stdout = quiet_command("netstat", &["-ano", "-p", "TCP"]).ok()?;
    pid_from_netstat(&stdout, port)
}

#[cfg(not(windows))]
fn listening_pid(_port: u16) -> Option<u32> { None }

#[cfg(windows)]
fn process_image(pid: u32) -> Option<String> {
    let filter = format!("PID eq {pid}");
    let stdout = quiet_command("tasklist", &["/FI", &filter, "/FO", "CSV", "/NH"]).ok()?;
    image_from_tasklist_csv(&stdout)
}

#[cfg(not(windows))]
fn process_image(_pid: u32) -> Option<String> { None }

fn quiet_command(program: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|e| format!("{program} 运行不了：{e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The PID column of a `netstat -ano` row whose LOCAL address listens on `port`
/// (`  TCP    127.0.0.1:6097    0.0.0.0:0    LISTENING    12345`). Rows for other ports, other protocols
/// and IPv6 spellings are told apart by the same rule: the local address has to END in `:port`. The state
/// word is only a preference, because Windows translates it on non-English installs.
pub fn pid_from_netstat(text: &str, port: u16) -> Option<u32> {
    let suffix = format!(":{port}");
    let mut fallback = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if fields.len() < 5 || fields[0] != "TCP" || !fields[1].ends_with(&suffix) {
            continue;
        }
        let Ok(pid) = fields[fields.len() - 1].parse::<u32>() else { continue };
        if fields[3].eq_ignore_ascii_case("LISTENING") {
            return Some(pid);
        }
        fallback.get_or_insert(pid);
    }
    fallback
}

/// The image name from `tasklist /FO CSV /NH` (`"node.exe","12345","Console","1","120,000 K"`). A filter
/// that matches nothing answers with a localized sentence instead of a row, so anything not starting with
/// a quote is not an answer. The name is read up to its closing quote, so a comma inside it cannot split it.
pub fn image_from_tasklist_csv(text: &str) -> Option<String> {
    let line = text.lines().find(|line| line.trim_start().starts_with('"'))?;
    let rest = line.trim().strip_prefix('"')?;
    let end = rest.find('"')?;
    let name = &rest[..end];
    (!name.is_empty()).then(|| name.to_string())
}

/// The first port from `from` on that this machine can listen on. The browser-unsafe ports are skipped — a
/// board on one of them would listen fine and then be unreachable from every tab. Binding is the honest
/// probe: the standard library does not set SO_REUSEADDR on Windows, so a bind fails exactly when another
/// process already holds the port.
pub fn free_port(from: u16, tries: u16, unsafe_ports: &[u16]) -> Option<u16> {
    for offset in 0..tries {
        let Some(port) = from.checked_add(offset) else { break };
        if port == 0 || unsafe_ports.contains(&port) {
            continue;
        }
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Some(port);
        }
    }
    None
}

/// Ends the process holding a port, after the owner asked for it. Only that one process, never its child
/// tree: a board's own running workers are not taken down with the board.
pub fn kill_process(pid: u32) -> Result<(), String> {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/F"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new("kill");
        command.args(["-TERM", &pid.to_string()]);
        command
    };
    command.stdin(Stdio::null());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command.output().map_err(|e| format!("无法结束进程 {pid}：{e}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!("结束进程 {pid} 失败：{}", first_useful_error(&String::from_utf8_lossy(&output.stderr))))
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

/// A path Node can load. Tauri hands out the installed app's resource folder as a verbatim path
/// (`\\?\C:\…`); Node cannot resolve a script there and dies with "EISDIR: illegal operation on a directory,
/// lstat 'C:'". Only the prefix goes: the rest of the path is already absolute.
pub fn node_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = text.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn script_path(questboard_root: &Path) -> PathBuf {
    node_path(questboard_root).join("src").join("cli").join("questboard.js")
}

/// The arguments that set up a project folder. Separate so a test can check them without running Node.
pub fn init_args(questboard_root: &Path, project: &Path) -> Vec<String> {
    vec![
        script_path(questboard_root).to_string_lossy().into_owned(),
        "init".into(),
        node_path(project).to_string_lossy().into_owned(),
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

/// Replaces one field of a project config through the CLI, so the window never writes the file itself: the
/// CLI validates the port the same way the board does, and keeps a timestamped backup of the old file.
pub fn set_port_args(questboard_root: &Path, project: &Path, port: u16) -> Vec<String> {
    vec![
        script_path(questboard_root).to_string_lossy().into_owned(),
        "port".into(),
        port.to_string(),
        "--project".into(),
        node_path(project).to_string_lossy().into_owned(),
    ]
}

/// Runs one questboard CLI command and waits for it. Returns what it printed, so the window can say what
/// happened; the CLI is the only place that knows how to change a project. Everything it printed is also
/// written to `log_file`, because a one-line dialog is never enough to debug a failed command.
fn run_cli(node: &str, questboard_root: &Path, args: &[String], log_file: &Path, what: &str) -> Result<String, String> {
    let mut command = Command::new(node);
    command.args(args).current_dir(node_path(questboard_root)).stdin(Stdio::null());
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
        format!("$ {node} {}\n\n--- stdout\n{stdout}\n--- stderr\n{stderr}\n", args.join(" ")),
    );
    if !output.status.success() {
        return Err(format!("{what}失败：{}\n\n完整输出：{}", first_useful_error(&stderr), log_file.display()));
    }
    Ok(stdout)
}

/// `questboard init` on a folder: the CLI writes the config, wrapper, sample brief and roster.
pub fn run_init(node: &str, questboard_root: &Path, project: &Path, log_file: &Path) -> Result<String, String> {
    run_cli(node, questboard_root, &init_args(questboard_root, project), log_file, "建项目")
}

/// `questboard port <n>` on a project: the config file's `port` changes, nothing else does.
pub fn run_set_port(node: &str, questboard_root: &Path, project: &Path, port: u16, log_file: &Path) -> Result<String, String> {
    run_cli(node, questboard_root, &set_port_args(questboard_root, project, port), log_file, "改端口")
}

pub fn spawn_server(node: &str, questboard_root: &Path, project: &Path, log_file: &Path) -> Result<Child, String> {
    if let Some(dir) = log_file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建日志目录：{e}"))?;
    }
    let mut log = File::create(log_file).map_err(|e| format!("无法写日志 {}：{e}", log_file.display()))?;
    // Which node and which questboard copy ran: an installed app carries its own copy, and "node" resolves by PATH.
    let script = script_path(questboard_root);
    let project = node_path(project);
    let cwd = node_path(questboard_root);
    let _ = writeln!(log, "$ {node} {} serve --project {}  (cwd {})", script.display(), project.display(), cwd.display());
    let err_log = log.try_clone().map_err(|e| e.to_string())?;
    let mut command = Command::new(node);
    command
        .arg(&script)
        .arg("serve")
        .arg("--project")
        .arg(&project)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err_log));
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command.spawn().map_err(|e| format!("启动 Node 失败（{node}）：{e}。需要安装 Node 22 或在设置里指定 node 路径"))
}

/// Why a server that exited did so, read from its log: the dialog used to say only "see the log".
pub fn exit_reason(log_file: &Path) -> String {
    let text = std::fs::read_to_string(log_file).unwrap_or_default();
    let output: String = text.lines().filter(|line| !line.starts_with("$ ")).collect::<Vec<_>>().join("\n");
    if output.trim().is_empty() {
        return "它退出前什么都没输出".into();
    }
    first_useful_error(&output)
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
    fn node_gets_paths_without_the_verbatim_prefix() {
        assert_eq!(node_path(Path::new(r"\\?\C:\Users\someone\AppData\Local\questboard\questboard")), PathBuf::from(r"C:\Users\someone\AppData\Local\questboard\questboard"));
        assert_eq!(node_path(Path::new(r"\\?\UNC\server\share\q")), PathBuf::from(r"\\server\share\q"));
        assert_eq!(node_path(Path::new("E:/questboard")), PathBuf::from("E:/questboard"));
        let args = init_args(Path::new(r"\\?\C:\app\questboard"), Path::new(r"\\?\E:\game"));
        assert!(!args[0].starts_with(r"\\?\") && !args[2].starts_with(r"\\?\"), "{args:?}");
    }

    #[test]
    fn a_dead_server_names_its_error_from_the_log() {
        let dir = std::env::temp_dir().join(format!("qb-exit-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("server.log");
        std::fs::write(&log, "$ node questboard.js serve --project E:/x  (cwd E:/q)\nnode:events:497\n      throw er;\nError: listen EADDRINUSE: address already in use 127.0.0.1:6097\n    at Server.setupListenHandle\n").unwrap();
        assert_eq!(exit_reason(&log), "Error: listen EADDRINUSE: address already in use 127.0.0.1:6097");
        std::fs::write(&log, "$ node questboard.js serve --project E:/x  (cwd E:/q)\n").unwrap();
        assert_eq!(exit_reason(&log), "它退出前什么都没输出");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_listening_is_down() {
        assert_eq!(check_health(1, "x", Path::new("x")), Health::Down);
    }
    // board_on is what turns "close the program" into a name the owner can act on; nothing listening must
    // stay None rather than inventing a holder.
    #[test]
    fn a_port_nothing_answers_on_has_no_board_and_no_holder() {
        assert_eq!(board_on(1), None);
    }

    #[test]
    fn finds_the_pid_listening_on_a_port() {
        let netstat = "活动连接\n\n  协议  本地地址          外部地址        状态           PID\n"
            .to_string()
            + "  TCP    127.0.0.1:6097         0.0.0.0:0              LISTENING       24680\n"
            + "  TCP    127.0.0.1:6098         0.0.0.0:0              LISTENING       11111\n"
            + "  TCP    127.0.0.1:51234        127.0.0.1:6097         ESTABLISHED     22222\n"
            + "  TCP    [::1]:6097             [::]:0                 LISTENING       24680\n"
            + "  UDP    127.0.0.1:6097         *:*                                    33333\n";
        assert_eq!(pid_from_netstat(&netstat, 6097), Some(24680));
        assert_eq!(pid_from_netstat(&netstat, 6098), Some(11111));
        assert_eq!(pid_from_netstat(&netstat, 6099), None, "no row for that port means no answer");
        assert_eq!(pid_from_netstat("", 6097), None);
    }

    // Windows translates the connection state, so a German install prints ABHÖREN where an English one
    // prints LISTENING. The port match is what identifies the row; the state word is only a preference.
    #[test]
    fn a_translated_state_word_still_names_the_holder() {
        let netstat = "  TCP    127.0.0.1:6097    0.0.0.0:0    ABHÖREN    24680\n";
        assert_eq!(pid_from_netstat(netstat, 6097), Some(24680));
    }

    #[test]
    fn reads_the_image_name_out_of_a_tasklist_row() {
        assert_eq!(image_from_tasklist_csv("\"node.exe\",\"24680\",\"Console\",\"1\",\"120,000 K\"\n").as_deref(), Some("node.exe"));
        assert_eq!(image_from_tasklist_csv("\"my,agent.exe\",\"1\",\"Console\",\"1\",\"1 K\"\n").as_deref(), Some("my,agent.exe"));
        assert_eq!(image_from_tasklist_csv("信息: 没有运行的任务匹配指定标准。\n"), None);
        assert_eq!(image_from_tasklist_csv(""), None);
    }

    #[test]
    fn a_free_port_skips_a_taken_one_and_the_browser_unsafe_ones() {
        let taken = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_eq!(free_port(port, 1, &[]), None, "the port this test holds is not free");
        assert_ne!(free_port(port, 5, &[]), Some(port), "a port the scan finds is never the taken one");
        assert_eq!(free_port(6666, 1, &[6666]), None, "a browser-blocked port is never offered");
        assert_eq!(free_port(65535, 2, &[65535]), None, "a scan that runs off the port range gives up");
    }

    #[test]
    fn builds_the_port_command_for_the_project() {
        let args = set_port_args(Path::new("E:/questboard"), Path::new("D:/my game"), 6098);
        assert_eq!(args[1], "port");
        assert_eq!(args[2], "6098");
        assert_eq!(args[3], "--project");
        assert_eq!(args[4], "D:/my game", "a folder with a space is one argument, not two");
        assert!(args[0].ends_with("questboard.js"));
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
