use crate::state::FileNode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const TREE_CACHE_FILE: &str = "tree-cache.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TreeCachePayload {
    pub remote: Vec<FileNode>,
    pub local: Vec<FileNode>,
    pub refreshed_at: Option<DateTime<Utc>>,
}

pub fn cache_path() -> PathBuf {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));
    exe_dir.join(TREE_CACHE_FILE)
}

pub fn load() -> Result<TreeCachePayload, String> {
    let path = cache_path();
    if !path.exists() {
        return Ok(TreeCachePayload::default());
    }

    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("读取文件树快照失败: {}", e))?;
    serde_json::from_str(&content).map_err(|e| format!("解析文件树快照失败: {}", e))
}

pub fn save(payload: &TreeCachePayload) -> Result<(), String> {
    let path = cache_path();
    let tmp = path.with_extension("json.tmp");
    let content = serde_json::to_string_pretty(payload)
        .map_err(|e| format!("序列化文件树快照失败: {}", e))?;
    std::fs::write(&tmp, content).map_err(|e| format!("写入文件树快照失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("覆盖文件树快照失败: {}", e))?;
    Ok(())
}
