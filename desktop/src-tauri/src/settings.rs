// Desktop settings: which project folder to open, and optionally which node and questboard checkout to
// use. Stored as JSON in the app config directory.
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const CONFIG_FILE: &str = "questboard.config.json";

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
        Some(v) => v
            .as_u64()
            .filter(|p| (1..=65535).contains(p))
            .ok_or_else(|| format!("{CONFIG_FILE} 的 port 必须是 1 到 65535 的整数"))? as u16,
    };
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
