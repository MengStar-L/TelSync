use crate::aria2::Aria2Client;
use crate::config::AppConfig;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

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
    pub aria2_client: Aria2Client,
}

impl AppState {
    pub fn new(config: AppConfig, rpc_port: u16) -> Arc<Self> {
        Arc::new(Self {
            config: RwLock::new(config),
            remote_tree: RwLock::new(None),
            local_tree: RwLock::new(None),
            aria2_client: Aria2Client::new(rpc_port),
        })
    }
}
