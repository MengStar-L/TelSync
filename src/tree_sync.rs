use crate::scanner::{mark_local_existence, scan_local_dir};
use crate::state::{AppState, FileNode};
use crate::teldrive::TelDriveClient;
use crate::tree_cache::{self, TreeCachePayload};
use chrono::{DateTime, Utc};
use serde::Serialize;
use std::sync::Arc;
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize)]
pub struct TreeRefreshEvent {
    pub refreshed_at: Option<DateTime<Utc>>,
    pub source: String,
}

#[derive(Debug, Clone)]
pub struct TreeSnapshot {
    pub remote: Vec<FileNode>,
    pub local: Vec<FileNode>,
    pub refreshed_at: Option<DateTime<Utc>>,
    pub from_cache: bool,
}

pub async fn refresh_and_store(state: &Arc<AppState>, source: &str) -> Result<TreeSnapshot, String> {
    let config = state.config.read().await.clone();
    if !config.is_configured() {
        return Err("请先完成配置".to_string());
    }

    let client = TelDriveClient::new(&config.teldrive_url, &config.access_token);
    let mut remote = client.fetch_tree("/").await?;
    let local = scan_local_dir(&config.local_path)?;
    mark_local_existence(&mut remote, &local);

    let snapshot = TreeSnapshot {
        remote,
        local,
        refreshed_at: Some(Utc::now()),
        from_cache: false,
    };

    store_snapshot(state, &snapshot, source).await;
    Ok(snapshot)
}

pub async fn update_local_and_store(
    state: &Arc<AppState>,
    local: Vec<FileNode>,
    source: &str,
) -> Result<TreeSnapshot, String> {
    let remote = {
        let mut guard = state.remote_tree.write().await;
        match guard.as_mut() {
            Some(remote) => {
                mark_local_existence(remote, &local);
                remote.clone()
            }
            None => Vec::new(),
        }
    };

    let snapshot = TreeSnapshot {
        remote,
        local,
        refreshed_at: Some(Utc::now()),
        from_cache: false,
    };

    store_snapshot(state, &snapshot, source).await;
    Ok(snapshot)
}

pub async fn current_snapshot(state: &Arc<AppState>) -> TreeSnapshot {
    TreeSnapshot {
        remote: state.remote_tree.read().await.clone().unwrap_or_default(),
        local: state.local_tree.read().await.clone().unwrap_or_default(),
        refreshed_at: state.last_tree_refresh.read().await.clone(),
        from_cache: *state.tree_from_cache.read().await,
    }
}

async fn store_snapshot(state: &Arc<AppState>, snapshot: &TreeSnapshot, source: &str) {
    *state.remote_tree.write().await = Some(snapshot.remote.clone());
    *state.local_tree.write().await = Some(snapshot.local.clone());
    *state.last_tree_refresh.write().await = snapshot.refreshed_at;
    *state.tree_from_cache.write().await = false;

    let payload = TreeCachePayload {
        remote: snapshot.remote.clone(),
        local: snapshot.local.clone(),
        refreshed_at: snapshot.refreshed_at,
    };

    if let Err(e) = tree_cache::save(&payload) {
        warn!("写入文件树快照失败: {}", e);
    }

    let _ = state.tree_events.send(TreeRefreshEvent {
        refreshed_at: snapshot.refreshed_at,
        source: source.to_string(),
    });
    info!("文件树已刷新，来源: {}", source);
}
