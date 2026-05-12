use crate::aria2::Aria2Client;
use crate::config::AppConfig;
use crate::tree_cache;
use crate::tree_sync::TreeRefreshEvent;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

/// 统一的文件节点结构，同时用于远程和本地
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default)]
    pub exists_locally: bool,
    #[serde(default)]
    pub children: Vec<FileNode>,
}

pub struct AppState {
    pub config: RwLock<AppConfig>,
    pub remote_tree: RwLock<Option<Vec<FileNode>>>,
    pub local_tree: RwLock<Option<Vec<FileNode>>>,
    pub last_tree_refresh: RwLock<Option<DateTime<Utc>>>,
    pub tree_from_cache: RwLock<bool>,
    pub tree_events: broadcast::Sender<TreeRefreshEvent>,
    pub aria2_client: Aria2Client,
}

impl AppState {
    pub fn new(config: AppConfig, rpc_port: u16) -> Arc<Self> {
        let rpc_secret = config.rpc_secret.clone();
        let cached = tree_cache::load().unwrap_or_default();
        let has_cache = cached.refreshed_at.is_some();
        let (tree_events, _) = broadcast::channel(32);
        Arc::new(Self {
            config: RwLock::new(config),
            remote_tree: RwLock::new(Some(cached.remote)),
            local_tree: RwLock::new(Some(cached.local)),
            last_tree_refresh: RwLock::new(cached.refreshed_at),
            tree_from_cache: RwLock::new(has_cache),
            tree_events,
            aria2_client: Aria2Client::new(rpc_port, rpc_secret),
        })
    }
}
