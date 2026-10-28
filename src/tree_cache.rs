use crate::state::FileNode;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::PathBuf;

const TREE_CACHE_FILE: &str = "tree-cache.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TreeCachePayload {
    #[serde(default)]
    pub config_key: Option<String>,
    pub remote: Vec<FileNode>,
    pub local: Vec<FileNode>,
    pub refreshed_at: Option<DateTime<Utc>>,
}

pub fn config_key(config: &crate::config::AppConfig) -> String {
    // 不在文件树缓存中保存认证令牌，只记录用于拒绝其他配置快照的指纹。
    let mut hasher = DefaultHasher::new();
    config.teldrive_url.hash(&mut hasher);
    config.access_token.hash(&mut hasher);
    config.local_path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::AppConfig;

    #[test]
    fn cache_scope_changes_with_account_server_or_local_root() {
        let config = AppConfig {
            teldrive_url: "https://one.example".to_string(),
            access_token: "first-account".to_string(),
            local_path: "/downloads/one".to_string(),
            ..AppConfig::default()
        };
        let key = config_key(&config);
        let mut changed = config.clone();
        changed.access_token = "second-account".to_string();
        assert_ne!(key, config_key(&changed));
        changed = config.clone();
        changed.teldrive_url = "https://two.example".to_string();
        assert_ne!(key, config_key(&changed));
        changed = config.clone();
        changed.local_path = "/downloads/two".to_string();
        assert_ne!(key, config_key(&changed));
        changed = config.clone();
        changed.max_concurrent_downloads = 4;
        assert_eq!(key, config_key(&changed));
    }
}
