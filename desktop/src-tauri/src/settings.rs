// Desktop settings: which project folder to open, and optionally which node and questboard checkout to
// use. Stored as JSON in the app config directory.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "questboard.config.json";

// The WHATWG Fetch "bad port" list a browser refuses to connect to at all
// (https://fetch.spec.whatwg.org/#port-blocking) — embedded at compile time from the single canonical,
// machine-readable list in src/core/browserUnsafePorts.json, so this shell and the Node core read the same
// 82 ports instead of two copies that could drift apart. See src/core/browserUnsafePorts.js for the Node side.
const BROWSER_UNSAFE_PORTS_JSON: &str = include_str!("../../../src/core/browserUnsafePorts.json");

pub fn browser_unsafe_ports() -> Vec<u16> {
    serde_json::from_str(BROWSER_UNSAFE_PORTS_JSON)
        .expect("src/core/browserUnsafePorts.json must be a JSON array of port numbers")
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
pub struct Settings {
    pub project: Option<PathBuf>,
    pub node: Option<String>,
    pub questboard_root: Option<PathBuf>,
}

pub fn load(file: &Path) -> Settings {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("无法创建设置目录 {}：{e}", dir.display()))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(file, text).map_err(|e| format!("无法保存设置 {}：{e}", file.display()))
}

/// What the shell needs from a project's questboard.config.json.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectInfo {
    pub root: PathBuf,
    pub name: String,
    pub port: u16,
}

/// Whether this folder is already a questboard project. A folder without the config is not an error: the
/// app offers to set it up in place, so someone who only ever double-clicks never needs a terminal.
pub fn has_config(root: &Path) -> bool {
    root.join(CONFIG_FILE).is_file()
}

pub fn read_project(root: &Path) -> Result<ProjectInfo, String> {
    let file = root.join(CONFIG_FILE);
    let text = fs::read_to_string(&file).map_err(|_| format!("{} 里没有 {CONFIG_FILE}", root.display()))?;
    parse_project(root, &text)
}

/// A port accepted the same way Node's `resolveConfig` (`Number.isInteger`, src/core/config.js) accepts
/// one: any JSON number in 1..=65535 whose value has no fractional part. `serde_json` stores a JSON
/// number as f64 whenever the source text has a decimal point or exponent (`6097.0`, `1e3`), so a plain
/// `as_u64()` rejects those even though Node's parser folds them into the same integer. Range and
/// integrality are both checked on the float before any cast, so an out-of-range or non-integral value
/// can never saturate into a valid port — non-numbers (string/bool/null/array/object) fail at `as_f64`.
fn port_from_json_number(v: &serde_json::Value) -> Option<u16> {
    let n = v.as_f64()?;
    if !n.is_finite() || n.fract() != 0.0 || n < 1.0 || n > 65535.0 {
        return None;
    }
    Some(n as u16)
}

pub fn parse_project(root: &Path, text: &str) -> Result<ProjectInfo, String> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| format!("{CONFIG_FILE} 不是有效的 JSON：{e}"))?;
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{CONFIG_FILE} 缺少 name"))?
        .to_string();
    let port = match value.get("port") {
        None => 6097,
        Some(v) => port_from_json_number(v)
            .ok_or_else(|| format!("{CONFIG_FILE} 的 port 必须是 1 到 65535 的整数"))?,
    };
    // Same check the Node core makes (src/core/config.js): a browser-unsafe port would still let the
    // server start, but every tab would just show a connection-refused page.
    if browser_unsafe_ports().contains(&port) {
        return Err(format!("{CONFIG_FILE} 的 port {port} 浏览器会直接拒绝连接（这是 Fetch 规范里的禁用端口），换一个端口，比如默认的 6097"));
    }
    Ok(ProjectInfo { root: root.to_path_buf(), name, port })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_name_and_default_port() {
        let info = parse_project(Path::new("E:/game"), r#"{"name":"My Game","lanes":{}}"#).unwrap();
        assert_eq!(info.name, "My Game");
        assert_eq!(info.port, 6097);
    }

    #[test]
    fn tells_a_project_folder_from_an_empty_one() {
        let dir = std::env::temp_dir().join(format!("qb-has-config-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(!has_config(&dir), "an empty folder is offered a setup, not refused");
        fs::write(dir.join(CONFIG_FILE), r#"{"name":"g","lanes":{}}"#).unwrap();
        assert!(has_config(&dir));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn names_what_is_wrong() {
        assert!(parse_project(Path::new("x"), "{}").unwrap_err().contains("缺少 name"));
        assert!(parse_project(Path::new("x"), r#"{"name":"g","port":70000}"#).unwrap_err().contains("port"));
        assert!(parse_project(Path::new("x"), "not json").unwrap_err().contains("JSON"));
    }

    // Shared data unit check: the embedded copy is compiled from the same file the Node core reads
    // (src/core/browserUnsafePorts.json / .js), so this pins its shape rather than re-deriving the list.
    #[test]
    fn browser_unsafe_ports_dataset_matches_the_canonical_82_port_list() {
        let ports = browser_unsafe_ports();
        assert_eq!(ports.len(), 82, "src/core/browserUnsafePorts.json should hold exactly the 82 WHATWG Fetch bad ports");
        for blocked in [1u16, 21, 6000, 6666, 6667, 6679, 10080] {
            assert!(ports.contains(&blocked), "expected {blocked} in the canonical list");
        }
        for safe in [6097u16, 6096, 45231] {
            assert!(!ports.contains(&safe), "expected ordinary/known-valid port {safe} to stay out of the canonical list");
        }
    }

    #[test]
    fn parse_project_rejects_browser_unsafe_ports_and_accepts_an_ordinary_one() {
        for blocked in [6000, 6666, 10080] {
            let err = parse_project(Path::new("x"), &format!(r#"{{"name":"g","port":{blocked}}}"#)).unwrap_err();
            assert!(err.contains(&blocked.to_string()) && err.contains("浏览器"), "port {blocked}: {err}");
        }
        assert_eq!(parse_project(Path::new("x"), r#"{"name":"g","port":6097}"#).unwrap().port, 6097);
        assert_eq!(parse_project(Path::new("x"), r#"{"name":"g","port":45231}"#).unwrap().port, 45231);
    }

    // F3 (revision3 PM clarification): Node's `resolveConfig` (`Number.isInteger`, src/core/config.js)
    // treats `1e3` and `6097.0` as the plain integers 1000 and 6097 once `JSON.parse` folds them — Rust
    // must classify the same JSON text the same way, not merely accept the plain-integer spelling.
    #[test]
    fn accepts_the_same_json_number_spelled_as_a_plain_integer_or_as_a_float() {
        for (plain, spelled) in [("1000", "1e3"), ("6097", "6097.0")] {
            let via_plain = parse_project(Path::new("x"), &format!(r#"{{"name":"g","port":{plain}}}"#)).unwrap();
            let via_spelled = parse_project(Path::new("x"), &format!(r#"{{"name":"g","port":{spelled}}}"#)).unwrap();
            assert_eq!(via_plain.port, via_spelled.port, "{plain} vs {spelled} should parse to the same port");
            assert_eq!(via_plain.port, plain.parse::<u16>().unwrap());
        }
    }

    #[test]
    fn rejects_a_browser_unsafe_port_however_the_same_number_is_spelled() {
        for spelling in ["6666", "6.666e3", "66660e-1"] {
            let err = parse_project(Path::new("x"), &format!(r#"{{"name":"g","port":{spelling}}}"#)).unwrap_err();
            assert!(err.contains("6666") && err.contains("浏览器"), "port spelled {spelling}: {err}");
        }
    }

    #[test]
    fn rejects_every_non_integral_or_out_of_range_json_port_value() {
        for bad in [
            "-1", "0", "65536", "6097.5", "99999999999999999999999999999999",
            r#""6666""#, "[6666]", "{}", "true", "null",
        ] {
            let err = parse_project(Path::new("x"), &format!(r#"{{"name":"g","port":{bad}}}"#)).unwrap_err();
            assert!(err.contains("port") && err.contains("整数"), "port value {bad}: {err}");
        }
    }

    // A huge exponent (`1e400`) overflows f64 while serde_json is still lexing the number, so the whole
    // config fails as invalid JSON before `port_from_json_number` ever runs — the same "nonfinite"
    // rejection class as NaN/Infinity, just caught one step earlier than the range/integrality guard.
    #[test]
    fn rejects_a_port_whose_exponent_overflows_the_json_parser_itself() {
        let err = parse_project(Path::new("x"), r#"{"name":"g","port":1e400}"#).unwrap_err();
        assert!(err.contains("JSON"), "{err}");
    }

    #[test]
    fn settings_round_trip_and_missing_file_is_default() {
        let dir = std::env::temp_dir().join(format!("qb-settings-{}", std::process::id()));
        let file = dir.join("desktop.json");
        assert_eq!(load(&file), Settings::default());
        let settings = Settings { project: Some(PathBuf::from("E:/game")), node: None, questboard_root: None };
        save(&file, &settings).unwrap();
        assert_eq!(load(&file), settings);
        let _ = fs::remove_dir_all(dir);
    }
}
