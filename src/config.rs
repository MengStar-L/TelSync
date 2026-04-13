use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const CONFIG_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    /// TelDrive 服务器地址，例如 https://teldrive.example.com
    pub teldrive_url: String,
    /// Cookie 中的 access_token 值
    pub access_token: String,
    /// 本地同步目标文件夹
    pub local_path: String,
    /// 最大并发下载数
    pub max_concurrent_downloads: usize,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            teldrive_url: String::new(),
            access_token: String::new(),
            local_path: String::new(),
            max_concurrent_downloads: 2,
        }
    }
}

impl AppConfig {
    pub fn config_path() -> PathBuf {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| PathBuf::from("."));
        exe_dir.join(CONFIG_FILE)
    }

    pub fn load() -> Self {
        let path = Self::config_path();
        if path.exists() {
            match std::fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    pub fn save(&self) -> Result<(), String> {
        let path = Self::config_path();
        let content =
            serde_json::to_string_pretty(self).map_err(|e| format!("序列化失败: {}", e))?;
        std::fs::write(&path, content).map_err(|e| format!("写入配置失败: {}", e))?;
        Ok(())
    }

    pub fn is_configured(&self) -> bool {
        !self.teldrive_url.is_empty()
            && !self.access_token.is_empty()
            && !self.local_path.is_empty()
    }
}
