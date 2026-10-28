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

pub async fn refresh_and_store(
    state: &Arc<AppState>,
    source: &str,
) -> Result<TreeSnapshot, String> {
    let _refresh_guard = state.tree_refresh_lock.lock().await;
    let config = state.config.read().await.clone();
    if !config.is_configured() {
        return Err("请先完成配置".to_string());
    }

    let client = TelDriveClient::new(&config.teldrive_url, &config.access_token);
    let mut remote = client.fetch_tree("/").await?;
    let local = scan_local(&config.local_path).await?;
    mark_local_existence(&mut remote, &local);

    let snapshot = TreeSnapshot {
        remote,
        local,
        refreshed_at: Some(Utc::now()),
        from_cache: false,
    };

    store_snapshot(state, &snapshot, source, tree_cache::config_key(&config)).await;
    Ok(snapshot)
}

pub async fn update_local_and_store(
    state: &Arc<AppState>,
    local_path: &str,
    source: &str,
) -> Result<TreeSnapshot, String> {
    let _refresh_guard = state.tree_refresh_lock.lock().await;
    let config = state.config.read().await.clone();
    if config.local_path != local_path {
        return Err("同步目录已更改，请刷新后重试".to_string());
    }
    let local = scan_local(local_path).await?;
    let mut remote = state.remote_tree.read().await.clone().unwrap_or_default();
    mark_local_existence(&mut remote, &local);

    let snapshot = TreeSnapshot {
        remote,
        local,
        refreshed_at: Some(Utc::now()),
        from_cache: false,
    };

    store_snapshot(state, &snapshot, source, tree_cache::config_key(&config)).await;
    Ok(snapshot)
}

pub async fn current_snapshot(state: &Arc<AppState>) -> TreeSnapshot {
    let remote = state.remote_tree.read().await;
    let local = state.local_tree.read().await;
    let refreshed_at = state.last_tree_refresh.read().await;
    let from_cache = state.tree_from_cache.read().await;
    TreeSnapshot {
        remote: remote.clone().unwrap_or_default(),
        local: local.clone().unwrap_or_default(),
        refreshed_at: *refreshed_at,
        from_cache: *from_cache,
    }
}

async fn scan_local(local_path: &str) -> Result<Vec<FileNode>, String> {
    let local_path = local_path.to_string();
    tokio::task::spawn_blocking(move || scan_local_dir(&local_path))
        .await
        .map_err(|e| format!("本地扫描任务失败: {}", e))?
}

/// 调用方在更改配置前须持有 tree_refresh_lock，避免旧配置刷新覆盖清空结果。
pub async fn clear_for_config_change(state: &Arc<AppState>) {
    let key = tree_cache::config_key(&*state.config.read().await);
    let snapshot = TreeSnapshot {
        remote: Vec::new(),
        local: Vec::new(),
        refreshed_at: None,
        from_cache: false,
    };
    store_snapshot(state, &snapshot, "config_change", key).await;
}

async fn store_snapshot(
    state: &Arc<AppState>,
    snapshot: &TreeSnapshot,
    source: &str,
    config_key: String,
) {
    {
        // 所有写锁按读取时的同一顺序获取，保证页面读到一整份快照。
        let mut remote = state.remote_tree.write().await;
        let mut local = state.local_tree.write().await;
        let mut refreshed_at = state.last_tree_refresh.write().await;
        let mut from_cache = state.tree_from_cache.write().await;
        *remote = Some(snapshot.remote.clone());
        *local = Some(snapshot.local.clone());
        *refreshed_at = snapshot.refreshed_at;
        *from_cache = false;
    }

    let payload = TreeCachePayload {
        config_key: Some(config_key),
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
