use crate::config::AppConfig;
use crate::state::{AppState, FileNode};
use crate::tree_sync::{self, TreeRefreshEvent, TreeSnapshot};
use crate::teldrive::TelDriveClient;
use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::Json;
use futures_util::{stream, StreamExt};
use once_cell::sync::Lazy;
use reqwest::{Client, Url};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::convert::Infallible;
use std::fs::File;
use std::io::{copy, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock as TokioRwLock;
use tracing::{error, info, warn};

#[derive(Deserialize)]
pub struct ConfigUpdate {
    pub teldrive_url: Option<String>,
    pub access_token: Option<String>,
    pub local_path: Option<String>,
    pub max_concurrent_downloads: Option<usize>,
    pub proxy_url: Option<String>,
    pub proxy_user: Option<String>,
    pub proxy_passwd: Option<String>,
    pub rpc_allow_remote: Option<bool>,
    pub rpc_secret: Option<String>,
}

#[derive(Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub message: Option<String>,
}

pub fn ok_response<T: Serialize>(data: T) -> Json<ApiResponse<T>> {
    Json(ApiResponse {
        success: true,
        data: Some(data),
        message: None,
    })
}

pub fn err_response<T: Serialize>(msg: &str) -> (StatusCode, Json<ApiResponse<T>>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiResponse {
            success: false,
            data: None,
            message: Some(msg.to_string()),
        }),
    )
}

fn normalize_proxy_url(raw: &str) -> Result<String, String> {
    let proxy_url = raw.trim();
    if proxy_url.is_empty() {
        return Ok(String::new());
    }

    let parsed = Url::parse(proxy_url).map_err(|_| {
        "代理地址格式不正确，请使用 http(s)://host:port 或 socks5://host:port".to_string()
    })?;

    match parsed.scheme() {
        "http" | "https" | "socks5" | "socks5h" => {}
        _ => return Err("代理地址协议仅支持 http、https、socks5、socks5h".to_string()),
    }

    if parsed.host_str().is_none() {
        return Err("代理地址缺少主机名".to_string());
    }

    if !parsed.path().is_empty() && parsed.path() != "/" {
        return Err("代理地址不应包含路径，请只填写协议、主机和端口".to_string());
    }

    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("代理地址不应包含查询参数或片段".to_string());
    }

    Ok(proxy_url.to_string())
}

fn normalized_existing_path(path: &Path) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|_| "目标路径非法".to_string())
}

fn validate_relative_request_path(raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("目标路径非法".to_string());
    }

    let candidate = Path::new(trimmed);
    if candidate.is_absolute() {
        return Err("目标路径非法".to_string());
    }

    let mut relative = PathBuf::new();
    for component in candidate.components() {
        match component {
            std::path::Component::Normal(part) => relative.push(part),
            std::path::Component::CurDir => {}
            _ => return Err("目标路径非法".to_string()),
        }
    }

    if relative.as_os_str().is_empty() {
        return Err("目标路径非法".to_string());
    }

    Ok(relative)
}

pub(crate) fn resolve_local_target(local_root: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let root = normalized_existing_path(local_root)?;
    let relative = validate_relative_request_path(raw_path)?;
    let joined = root.join(relative);

    if joined.exists() {
        let canonical_target = normalized_existing_path(&joined)?;
        if canonical_target.starts_with(&root) {
            Ok(canonical_target)
        } else {
            Err("目标路径非法".to_string())
        }
    } else {
        let parent = joined.parent().ok_or_else(|| "目标路径非法".to_string())?;
        let canonical_parent = normalized_existing_path(parent)?;
        if canonical_parent.starts_with(&root) {
            Ok(joined)
        } else {
            Err("目标路径非法".to_string())
        }
    }
}

fn path_within_root(path: &Path, local_root: &Path) -> bool {
    let Ok(root) = normalized_existing_path(local_root) else {
        return false;
    };

    if let Ok(target) = normalized_existing_path(path) {
        return target.starts_with(&root);
    }

    match path
        .parent()
        .and_then(|parent| normalized_existing_path(parent).ok())
    {
        Some(parent) => parent.starts_with(&root),
        None => false,
    }
}

fn build_aria2_global_options(config: &AppConfig) -> serde_json::Value {
    let mut options = serde_json::Map::new();
    options.insert(
        "max-concurrent-downloads".to_string(),
        serde_json::json!(config.max_concurrent_downloads.to_string()),
    );
    options.insert("all-proxy".to_string(), serde_json::json!(config.proxy_url));
    options.insert(
        "all-proxy-user".to_string(),
        serde_json::json!(config.proxy_user),
    );
    options.insert(
        "all-proxy-passwd".to_string(),
        serde_json::json!(config.proxy_passwd),
    );
    serde_json::Value::Object(options)
}

fn build_save_message(base: &str, config: &AppConfig) -> String {
    if config.rpc_allow_remote && config.rpc_secret.is_empty() {
        format!("{}（已允许外部访问，建议设置 RPC 密码）", base)
    } else {
        base.to_string()
    }
}

fn spawn_aria2_from_config(config: &AppConfig) -> Result<(), String> {
    let local_path = if config.local_path.is_empty() {
        "."
    } else {
        &config.local_path
    };

    crate::aria2::spawn_aria2(crate::aria2::SpawnAria2Options {
        local_dir: local_path,
        port: 16800,
        max_concurrent: config.max_concurrent_downloads,
        proxy_url: &config.proxy_url,
        proxy_user: &config.proxy_user,
        proxy_passwd: &config.proxy_passwd,
        rpc_allow_remote: config.rpc_allow_remote,
        rpc_secret: &config.rpc_secret,
    })
}

async fn restart_aria2_with_config(state: &Arc<AppState>, config: &AppConfig) -> String {
    if !crate::aria2::check_aria2_exists() {
        state.aria2_client.set_secret(config.rpc_secret.clone()).await;
        return build_save_message("配置已保存，Aria2 安装后会按新的 RPC 设置启动", config);
    }

    if let Err(e) = state.aria2_client.force_shutdown().await {
        warn!("尝试关闭旧的 Aria2 进程失败，继续尝试重启: {}", e);
    }
    tokio::time::sleep(Duration::from_millis(400)).await;

    match spawn_aria2_from_config(config) {
        Ok(_) => {
            state.aria2_client.set_secret(config.rpc_secret.clone()).await;
            tokio::time::sleep(Duration::from_millis(350)).await;
            match state
                .aria2_client
                .change_global_option(build_aria2_global_options(config))
                .await
            {
                Ok(_) => build_save_message("配置已保存，Aria2 已重启并应用新的 RPC 设置", config),
                Err(e) => {
                    warn!("Aria2 重启成功，但补充应用运行时配置失败: {}", e);
                    build_save_message("配置已保存，Aria2 已按新的 RPC 设置重启", config)
                }
            }
        }
        Err(e) => {
            warn!("Aria2 重启失败，新配置将在下次启动时加载: {}", e);
            build_save_message("配置已保存，但当前未能重启 Aria2；下次启动后会按新 RPC 设置加载", config)
        }
    }
}

async fn apply_aria2_config(
    state: &Arc<AppState>,
    config: &AppConfig,
    restart_required: bool,
) -> String {
    if restart_required {
        return restart_aria2_with_config(state, config).await;
    }

    let options = build_aria2_global_options(config);

    match state.aria2_client.change_global_option(options.clone()).await {
        Ok(_) => build_save_message("配置已保存并已应用到 Aria2", config),
        Err(apply_err) => {
            if !crate::aria2::check_aria2_exists() {
                warn!("Aria2 未就绪，配置已保存，等待后续启动自动加载: {}", apply_err);
                state.aria2_client.set_secret(config.rpc_secret.clone()).await;
                return build_save_message("配置已保存，Aria2 启动后会自动加载", config);
            }

            match spawn_aria2_from_config(config) {
                Ok(_) => {
                    state.aria2_client.set_secret(config.rpc_secret.clone()).await;
                    tokio::time::sleep(Duration::from_millis(300)).await;
                    match state
                        .aria2_client
                        .change_global_option(build_aria2_global_options(config))
                        .await
                    {
                        Ok(_) => build_save_message("配置已保存，Aria2 已重连并应用", config),
                        Err(retry_err) => {
                            warn!(
                                "Aria2 已尝试重连，但仍未能应用最新配置: {}; 初始错误: {}",
                                retry_err, apply_err
                            );
                            build_save_message(
                                "配置已保存，但当前未能连接 Aria2；下次启动后会自动加载",
                                config,
                            )
                        }
                    }
                }
                Err(spawn_err) => {
                    warn!(
                        "Aria2 配置未实时应用，已保存等待下次启动: {}; 启动失败: {}",
                        apply_err, spawn_err
                    );
                    build_save_message(
                        "配置已保存，但当前未能连接 Aria2；下次启动后会自动加载",
                        config,
                    )
                }
            }
        }
    }
}

/// GET /api/config
pub async fn get_config(State(state): State<Arc<AppState>>) -> Json<ApiResponse<AppConfig>> {
    let config = state.config.read().await.clone();
    ok_response(config)
}

/// POST /api/config
pub async fn save_config(
    State(state): State<Arc<AppState>>,
    Json(update): Json<ConfigUpdate>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let mut config = state.config.write().await;
    let previous_config = config.clone();

    if let Some(url) = update.teldrive_url {
        config.teldrive_url = url.trim_end_matches('/').to_string();
    }
    if let Some(token) = update.access_token {
        config.access_token = token.trim().to_string();
    }
    if let Some(path) = update.local_path {
        config.local_path = path
            .trim()
            .trim_end_matches('\\')
            .trim_end_matches('/')
            .to_string();
    }
    if let Some(max) = update.max_concurrent_downloads {
        config.max_concurrent_downloads = max.clamp(1, 5);
    }
    if let Some(proxy_url) = update.proxy_url {
        config.proxy_url = normalize_proxy_url(&proxy_url).map_err(|e| err_response::<String>(&e))?;
    }
    if let Some(proxy_user) = update.proxy_user {
        config.proxy_user = proxy_user.trim().to_string();
    }
    if let Some(proxy_passwd) = update.proxy_passwd {
        config.proxy_passwd = proxy_passwd.trim().to_string();
    }
    if let Some(rpc_allow_remote) = update.rpc_allow_remote {
        config.rpc_allow_remote = rpc_allow_remote;
    }
    if let Some(rpc_secret) = update.rpc_secret {
        config.rpc_secret = rpc_secret.trim().to_string();
    }
    config.save().map_err(|e| err_response::<String>(&e))?;

    let restart_required = previous_config.rpc_allow_remote != config.rpc_allow_remote
        || previous_config.rpc_secret != config.rpc_secret;

    let config_snapshot = config.clone();
    drop(config);

    let message = apply_aria2_config(&state, &config_snapshot, restart_required).await;
    Ok(ok_response(message))
}

/// POST /api/test-connection
pub async fn test_connection(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let config = state.config.read().await;
    if !config.is_configured() {
        return Err(err_response("请先完成配置"));
    }
    let client = TelDriveClient::new(&config.teldrive_url, &config.access_token);
    drop(config);
    match client.test_connection().await {
        Ok(msg) => Ok(ok_response(msg)),
        Err(e) => Err(err_response(&e)),
    }
}

#[derive(Serialize)]
pub struct TreeResponse {
    pub remote: Vec<FileNode>,
    pub local: Vec<FileNode>,
    pub refreshed_at: Option<chrono::DateTime<chrono::Utc>>,
    pub from_cache: bool,
}

pub async fn get_trees(State(state): State<Arc<AppState>>) -> Json<ApiResponse<TreeResponse>> {
    ok_response(tree_response_from_snapshot(tree_sync::current_snapshot(&state).await))
}

pub async fn refresh_trees(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<TreeResponse>>, (StatusCode, Json<ApiResponse<TreeResponse>>)> {
    let snapshot = tree_sync::refresh_and_store(&state, "manual")
        .await
        .map_err(|e| err_response::<TreeResponse>(&e))?;
    Ok(ok_response(tree_response_from_snapshot(snapshot)))
}

pub async fn initial_trees(State(state): State<Arc<AppState>>) -> Json<ApiResponse<TreeResponse>> {
    match tree_sync::refresh_and_store(&state, "startup").await {
        Ok(snapshot) => ok_response(tree_response_from_snapshot(snapshot)),
        Err(e) => {
            warn!("页面首次刷新失败，回退到缓存快照: {}", e);
            let snapshot = tree_sync::current_snapshot(&state).await;
            Json(ApiResponse {
                success: true,
                data: Some(tree_response_from_snapshot(snapshot)),
                message: Some("实时刷新失败，已显示上次缓存".to_string()),
            })
        }
    }
}

pub async fn tree_events(
    State(state): State<Arc<AppState>>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let rx = state.tree_events.subscribe();
    let stream = stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(TreeRefreshEvent {
                    refreshed_at,
                    source,
                }) => {
                    let data = serde_json::json!({
                        "refreshed_at": refreshed_at,
                        "source": source,
                    });
                    let event = Event::default()
                        .event("trees_refreshed")
                        .data(data.to_string());
                    return Some((Ok(event), rx));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });

    Sse::new(stream).keep_alive(KeepAlive::default())
}

fn tree_response_from_snapshot(snapshot: TreeSnapshot) -> TreeResponse {
    TreeResponse {
        remote: snapshot.remote,
        local: snapshot.local,
        refreshed_at: snapshot.refreshed_at,
        from_cache: snapshot.from_cache,
    }
}

async fn refresh_local_tree_cache_if_possible(state: &Arc<AppState>, local_path: &str, source: &str) {
    if local_path.is_empty() {
        return;
    }
    match crate::scanner::scan_local_dir(local_path) {
        Ok(local_tree) => {
            if let Err(e) = tree_sync::update_local_and_store(state, local_tree, source).await {
                warn!("持久化本地文件树快照失败: {}", e);
            }
        }
        Err(e) => warn!("刷新本地文件树缓存失败: {}", e),
    }
}

pub fn find_node<'a>(nodes: &'a [FileNode], path: &str) -> Option<&'a FileNode> {
    for node in nodes {
        if node.path == path {
            return Some(node);
        }
        if path.starts_with(&format!("{}/", node.path)) || node.path == "/" {
            if let Some(found) = find_node(&node.children, path) {
                return Some(found);
            }
        }
    }
    None
}

pub fn flatten_files(nodes: &[FileNode], root_path: &str) -> Vec<FileNode> {
    let mut result = Vec::new();
    if let Some(root) = find_node(nodes, root_path) {
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            if !node.is_dir {
                result.push(node.clone());
            }
            for child in &node.children {
                stack.push(child);
            }
        }
    }
    result
}

fn build_download_url(base_url: &str, remote_id: &str, remote_path: &str) -> Result<String, String> {
    let mut url = Url::parse(&format!(
        "{}/api/files/{}/download",
        base_url.trim_end_matches('/'),
        remote_id
    ))
    .map_err(|e| format!("Build download url failed: {}", e))?;
    url.query_pairs_mut().append_pair("ts_path", remote_path);
    Ok(url.to_string())
}

fn task_file_path(task: &serde_json::Value) -> Option<&str> {
    task["files"].as_array()?.first()?.get("path")?.as_str()
}

fn task_file_name(task: &serde_json::Value) -> Option<String> {
    let full_path = task_file_path(task)?;
    Path::new(full_path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

fn task_remote_path(task: &serde_json::Value, local_path_normalized: &str) -> Option<String> {
    let file_name = task_file_name(task)?;

    if let Some(uri) = task["files"]
        .as_array()
        .and_then(|files| files.first())
        .and_then(|file| file["uris"].as_array())
        .and_then(|uris| uris.iter().find_map(|uri| uri["uri"].as_str()))
    {
        if let Ok(parsed) = Url::parse(uri) {
            for (key, value) in parsed.query_pairs() {
                if key == "ts_path" {
                    return Some(value.into_owned());
                }
            }
        }
    }

    if let Some(dir) = task["dir"].as_str() {
        let dir_normalized = dir.replace("\\", "/");
        let dir_lower = dir_normalized.to_lowercase();
        let local_lower = local_path_normalized.to_lowercase();
        let relative_dir = if dir_lower.starts_with(&local_lower) {
            dir_normalized[local_path_normalized.len()..].to_string()
        } else {
            String::new()
        };

        let mut remote_path = format!("{}/{}", relative_dir, file_name).replace("//", "/");
        if !remote_path.starts_with('/') {
            remote_path = format!("/{}", remote_path);
        }
        return Some(remote_path);
    }

    Some(format!("/.../{}", file_name))
}

fn extract_retry_url(task: &serde_json::Value) -> Option<String> {
    task["files"]
        .as_array()?
        .first()?
        .get("uris")?
        .as_array()?
        .iter()
        .find_map(|uri| uri["uri"].as_str().map(str::to_string))
}

fn find_remote_id_by_path(nodes: &[FileNode], remote_path: &str) -> Option<String> {
    find_node(nodes, remote_path).and_then(|node| node.remote_id.clone())
}

fn tracked_aria2_related_paths(file_path: &Path) -> Vec<PathBuf> {
    let mut paths = vec![file_path.to_path_buf()];

    let mut aria2_path = file_path.as_os_str().to_os_string();
    aria2_path.push(".aria2");
    paths.push(PathBuf::from(aria2_path));

    let mut temp_path = file_path.as_os_str().to_os_string();
    temp_path.push(".aria2__temp");
    paths.push(PathBuf::from(temp_path));

    paths
}

pub(crate) fn cleanup_empty_parent_dirs(start: &Path, local_root: &Path) {
    let Ok(root) = normalized_existing_path(local_root) else {
        return;
    };

    let mut current_dir = start.parent().map(Path::to_path_buf);
    while let Some(parent) = current_dir {
        let Ok(parent_canonical) = normalized_existing_path(&parent) else {
            break;
        };

        if parent_canonical == root || !parent_canonical.starts_with(&root) {
            break;
        }

        match std::fs::read_dir(&parent_canonical) {
            Ok(mut iter) => {
                if iter.next().is_none() {
                    let _ = std::fs::remove_dir(&parent_canonical);
                    current_dir = parent_canonical.parent().map(Path::to_path_buf);
                } else {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

pub(crate) fn cleanup_download_artifacts(files: &[PathBuf], local_root: &Path) {
    for file_path in files {
        if !path_within_root(file_path, local_root) {
            continue;
        }
        for path in tracked_aria2_related_paths(file_path) {
            if path_within_root(&path, local_root) {
                let _ = std::fs::remove_file(path);
            }
        }
        cleanup_empty_parent_dirs(file_path, local_root);
    }
}

fn collect_task_file_paths(task: &serde_json::Value) -> Vec<PathBuf> {
    task["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|file| file["path"].as_str())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .collect()
}

pub(crate) fn collect_incomplete_task_file_paths(tasks: &[serde_json::Value]) -> Vec<PathBuf> {
    tasks
        .iter()
        .filter(|task| task["status"].as_str().unwrap_or("") != "complete")
        .flat_map(collect_task_file_paths)
        .collect()
}

fn current_release_repo() -> &'static str {
    "MengStar-L/TelSync"
}

fn current_app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn current_arch_asset_keywords() -> &'static [&'static str] {
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        &["windows-amd64", "win-x64", "win64", "x86_64-pc-windows"]
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "x86_64") {
        &["linux-amd64", "linux-x64", "x86_64-unknown-linux"]
    } else if cfg!(target_os = "linux") && cfg!(target_arch = "aarch64") {
        &["linux-arm64", "linux-aarch64", "aarch64-unknown-linux"]
    } else {
        &[]
    }
}

fn parse_version_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches('v')).ok()
}

fn extract_release_notes(body: &str) -> String {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        "暂无发布说明。".to_string()
    } else {
        trimmed.chars().take(1500).collect()
    }
}

#[derive(Serialize)]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub published_at: Option<String>,
    pub release_notes: String,
    pub has_update: bool,
    pub release_url: String,
    pub download_url: String,
    pub asset_name: Option<String>,
    pub supported_arch: bool,
}

pub(crate) fn build_update_info_from_release(
    release: &serde_json::Value,
    current_version: &str,
) -> UpdateInfo {
    let latest_version = release["tag_name"]
        .as_str()
        .unwrap_or("unknown")
        .trim_start_matches('v')
        .to_string();
    let published_at = release["published_at"].as_str().map(str::to_string);
    let release_notes = extract_release_notes(release["body"].as_str().unwrap_or(""));
    let release_url = release["html_url"].as_str().unwrap_or("").to_string();
    let supported_arch = !current_arch_asset_keywords().is_empty();

    let asset = release["assets"].as_array().and_then(|assets| {
        assets.iter().find(|asset| {
            let name = asset["name"].as_str().unwrap_or("").to_ascii_lowercase();
            current_arch_asset_keywords()
                .iter()
                .any(|keyword| name.contains(keyword))
        })
    });

    let asset_name = asset.and_then(|item| item["name"].as_str()).map(str::to_string);
    let download_url = asset
        .and_then(|item| item["browser_download_url"].as_str())
        .map(str::to_string)
        .filter(|url| !url.is_empty())
        .unwrap_or_else(|| release_url.clone());

    let has_update = match (
        parse_version_tag(current_version),
        parse_version_tag(&latest_version),
    ) {
        (Some(current), Some(latest)) => latest > current,
        _ => latest_version != current_version,
    };

    UpdateInfo {
        current_version: current_version.to_string(),
        latest_version,
        published_at,
        release_notes,
        has_update,
        release_url,
        download_url,
        asset_name,
        supported_arch,
    }
}

async fn fetch_update_info() -> Result<UpdateInfo, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let release: serde_json::Value = client
        .get(format!(
            "https://api.github.com/repos/{}/releases/latest",
            current_release_repo()
        ))
        .header("User-Agent", "TelSync")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Failed to fetch latest release: {}", e))?
        .error_for_status()
        .map_err(|e| format!("GitHub returned an error: {}", e))?
        .json()
        .await
        .map_err(|e| format!("Failed to parse release info: {}", e))?;

    Ok(build_update_info_from_release(&release, &current_app_version()))
}

pub(crate) fn update_artifact_paths(exe_path: &Path) -> Result<(PathBuf, PathBuf), String> {
    let file_name = exe_path
        .file_name()
        .ok_or_else(|| "无法确定当前程序文件名".to_string())?
        .to_string_lossy()
        .to_string();
    let parent = exe_path
        .parent()
        .ok_or_else(|| "无法确定当前程序目录".to_string())?;

    Ok((
        parent.join(format!("{}.update.tmp", file_name)),
        parent.join(format!("{}.bak", file_name)),
    ))
}

fn update_download_url(info: &UpdateInfo) -> Result<&str, String> {
    if !info.has_update {
        return Err("当前已是最新版本".to_string());
    }
    if !info.supported_arch || info.asset_name.is_none() || info.download_url == info.release_url {
        return Err("未找到适用于当前架构的更新包".to_string());
    }
    if info.download_url.trim().is_empty() {
        return Err("更新包下载地址为空".to_string());
    }

    Ok(&info.download_url)
}

async fn download_update_asset(download_url: &str, target_path: &Path) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10 * 60))
        .build()
        .map_err(|e| format!("创建下载客户端失败: {}", e))?;
    let response = client
        .get(download_url)
        .header("User-Agent", "TelSync")
        .send()
        .await
        .map_err(|e| format!("下载更新包失败: {}", e))?
        .error_for_status()
        .map_err(|e| format!("下载更新包失败: {}", e))?;

    let mut file = tokio::fs::File::create(target_path)
        .await
        .map_err(|e| format!("创建临时更新文件失败: {}", e))?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取更新包失败: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入更新包失败: {}", e))?;
    }
    file.flush()
        .await
        .map_err(|e| format!("保存更新包失败: {}", e))?;
    drop(file);

    let metadata = std::fs::metadata(target_path)
        .map_err(|e| format!("检查更新包失败: {}", e))?;
    if metadata.len() == 0 {
        return Err("更新包为空".to_string());
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(target_path, permissions)
            .map_err(|e| format!("设置更新包执行权限失败: {}", e))?;
    }

    Ok(())
}

pub(crate) fn replace_executable_with_update(
    exe_path: &Path,
    temp_path: &Path,
    backup_path: &Path,
) -> Result<(), String> {
    if !exe_path.exists() {
        return Err("当前程序文件不存在".to_string());
    }
    if !temp_path.exists() {
        return Err("临时更新文件不存在".to_string());
    }
    if backup_path.exists() {
        std::fs::remove_file(backup_path)
            .map_err(|e| format!("移除旧备份失败: {}", e))?;
    }

    std::fs::copy(exe_path, backup_path)
        .map_err(|e| format!("备份当前程序失败: {}", e))?;

    #[cfg(windows)]
    {
        if exe_path.exists() {
            std::fs::remove_file(exe_path)
                .map_err(|e| format!("准备替换当前程序失败: {}", e))?;
        }
    }

    if let Err(e) = std::fs::rename(temp_path, exe_path) {
        #[cfg(windows)]
        {
            let _ = std::fs::copy(backup_path, exe_path);
        }
        return Err(format!("替换当前程序失败: {}", e));
    }

    Ok(())
}

async fn install_update_from_info(info: &UpdateInfo) -> Result<(), String> {
    if !cfg!(target_os = "linux") {
        return Err("自动更新仅支持 Linux/OpenWrt 环境".to_string());
    }

    let download_url = update_download_url(info)?;
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("无法确定当前程序路径: {}", e))?;
    let (temp_path, backup_path) = update_artifact_paths(&exe_path)?;

    let _ = std::fs::remove_file(&temp_path);
    download_update_asset(download_url, &temp_path).await?;
    replace_executable_with_update(&exe_path, &temp_path, &backup_path)?;

    Ok(())
}

fn schedule_process_exit() {
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_secs(1)).await;
        info!("TelSync update installed; exiting for procd restart");
        std::process::exit(0);
    });
}

#[derive(Deserialize)]
pub struct EnqueueRequest {
    pub path: String,
}

#[derive(Serialize)]
pub struct EnqueueResponse {
    pub added_count: usize,
}

pub async fn enqueue_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<EnqueueRequest>,
) -> Result<Json<ApiResponse<EnqueueResponse>>, (StatusCode, Json<ApiResponse<EnqueueResponse>>)> {
    let remote_tree = state.remote_tree.read().await;
    let remote_nodes = remote_tree
        .as_ref()
        .ok_or_else(|| err_response::<EnqueueResponse>("请先刷新文件树"))?;
    let target_node = find_node(remote_nodes, &req.path);
    if target_node.is_none() {
        return Err(err_response("未找到指定路径"));
    }
    let files_to_download = if target_node.unwrap().is_dir {
        flatten_files(remote_nodes, &req.path)
            .into_iter()
            .filter(|f| !f.exists_locally)
            .collect()
    } else {
        let node = target_node.unwrap();
        if node.exists_locally {
            return Err(err_response("文件已存在本地"));
        }
        vec![node.clone()]
    };
    drop(remote_tree);

    let config = state.config.read().await.clone();
    let mut added = 0;

    for file in &files_to_download {
        if let Some(ref id) = file.remote_id {
            let file_url = build_download_url(&config.teldrive_url, id, &file.path)
                .map_err(|e| err_response::<EnqueueResponse>(&e))?;
            let path_parts: Vec<&str> = file.path.split('/').filter(|p| !p.is_empty()).collect();
            // path_parts = ["Hero", "VR", "test.mp4"] -> len 3. relative_dir = ["Hero", "VR"]
            let relative_dir = if path_parts.len() > 1 {
                path_parts[0..path_parts.len() - 1].join("/")
            } else {
                "".to_string()
            };
            let out_dir = if relative_dir.is_empty() {
                config.local_path.clone()
            } else {
                let p = Path::new(&config.local_path).join(relative_dir);
                std::fs::create_dir_all(&p).unwrap_or(());
                p.to_string_lossy().to_string()
            };

            match state
                .aria2_client
                .add_uri(&file_url, &file.name, &out_dir, &config.access_token)
                .await
            {
                Ok(_) => added += 1,
                Err(e) => error!("添加 aria2 下载失败: {}", e),
            }
        }
    }

    if added == 0 {
        return Err(err_response(if files_to_download.is_empty() {
            "该目录下没有需要下载的新文件"
        } else {
            "Aria2 添加任务失败，请检查服务状态"
        }));
    }

    Ok(ok_response(EnqueueResponse { added_count: added }))
}

#[derive(Deserialize)]
pub struct DeleteFileRequest {
    pub path: String,
}

pub async fn delete_local_file(
    State(state): State<Arc<AppState>>,
    Json(req): Json<DeleteFileRequest>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let config = state.config.read().await.clone();
    let local_root = PathBuf::from(&config.local_path);
    let target_path =
        resolve_local_target(&local_root, &req.path).map_err(|e| err_response::<String>(&e))?;

    if !target_path.exists() {
        return Err(err_response("本地文件不存在"));
    }

    if target_path.is_dir() {
        std::fs::remove_dir_all(&target_path).map_err(|e| err_response(&format!("删除目录失败: {}", e)))?;
    } else {
        std::fs::remove_file(&target_path).map_err(|e| err_response(&format!("删除文件失败: {}", e)))?;
        // 同时清理可能残余的 .aria2 侧载任务文件
        let mut aria2_path = target_path.clone().into_os_string();
        aria2_path.push(".aria2");
        let _ = std::fs::remove_file(aria2_path);
    }

    cleanup_empty_parent_dirs(&target_path, &local_root);

    refresh_local_tree_cache_if_possible(&state, &config.local_path, "local_update").await;

    Ok(ok_response("删除成功".to_string()))
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DownloadTaskView {
    pub id: String,
    pub remote_path: String,
    pub file_name: String,
    pub total_size: u64,
    pub downloaded: u64,
    pub status: String,
    pub speed: f64,
    pub retry_count: usize,
    pub max_retries: usize,
}

pub async fn download_status(
    State(state): State<Arc<AppState>>,
) -> Json<ApiResponse<Vec<DownloadTaskView>>> {
    let config = state.config.read().await.clone();
    let local_path_normalized = config.local_path.replace("\\", "/");
    let local_path_buf = PathBuf::from(&config.local_path);
    let mut view_tasks = Vec::new();
    if let Ok(all) = state.aria2_client.tell_all().await {
        for t in all {
            let gid = t["gid"].as_str().unwrap_or("").to_string();
            let status_raw = t["status"].as_str().unwrap_or("unknown");
            
            let total = t["totalLength"].as_str().unwrap_or("0").parse().unwrap_or(0);
            let downloaded = t["completedLength"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0);
            let speed = t["downloadSpeed"]
                .as_str()
                .unwrap_or("0")
                .parse()
                .unwrap_or(0.0);

            // get remote path from dir and filename (Aria2 doesn't store our relative path directly)
            // But we can extract it from the file path.
            let mut file_name = "Unknown".to_string();
            let mut remote_path = "Unknown".to_string();
            if let Some(files) = t["files"].as_array() {
                if !files.is_empty() {
                    let full_path = files[0]["path"].as_str().unwrap_or("");
                    let path_obj = Path::new(full_path);
                    if let Some(name) = path_obj.file_name() {
                        file_name = name.to_string_lossy().to_string();
                        
                        // 从 dir 提取出相对路径以还原 remote_path
                        if let Some(dir) = t["dir"].as_str() {
                            let dir_normalized = dir.replace("\\", "/");
                            let mut relative_dir = "".to_string();
                            let dir_lower = dir_normalized.to_lowercase();
                            let loc_lower = local_path_normalized.to_lowercase();
                            if dir_lower.starts_with(&loc_lower) {
                                relative_dir = dir_normalized[local_path_normalized.len()..].to_string();
                            }
                            let mut rp = format!("{}/{}", relative_dir, file_name).replace("//", "/");
                            if !rp.starts_with('/') {
                                rp = format!("/{}", rp);
                            }
                            remote_path = rp;
                        } else {
                            remote_path = format!("/.../{}", file_name);
                        }
                    }
                }
            }

            let file_name = task_file_name(&t).unwrap_or(file_name);
            let remote_path = task_remote_path(&t, &local_path_normalized).unwrap_or(remote_path);

            if status_raw == "error" {
                let files_to_clean = collect_task_file_paths(&t);
                cleanup_download_artifacts(&files_to_clean, &local_path_buf);
            }

            let status = match status_raw {
                "active" => "Downloading",
                "waiting" => "Queued",
                "paused" => "Queued",
                "error" => "Failed",
                "complete" => "Completed",
                "removed" => "Cancelled",
                _ => "Queued",
            }
            .to_string();

            view_tasks.push(DownloadTaskView {
                id: gid,
                remote_path,
                file_name,
                total_size: total,
                downloaded,
                status,
                speed,
                retry_count: 0,
                max_retries: 3,
            });
        }
    }

    ok_response(view_tasks)
}

#[derive(Deserialize)]
pub struct TaskAction {
    pub task_id: String,
}

pub async fn cancel_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TaskAction>,
) -> Json<ApiResponse<String>> {
    let mut files_to_clean: Vec<PathBuf> = Vec::new();
    if let Ok(status) = state.aria2_client.tell_status(&req.task_id).await {
        files_to_clean = collect_task_file_paths(&status);
    }

    let _ = state.aria2_client.remove(&req.task_id).await;

    let config = state.config.read().await.clone();
    let local_path_buf = PathBuf::from(&config.local_path);
    cleanup_download_artifacts(&files_to_clean, &local_path_buf);

    refresh_local_tree_cache_if_possible(&state, &config.local_path, "local_update").await;

    ok_response("Task cancelled".to_string())
}

pub async fn remove_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TaskAction>,
) -> Json<ApiResponse<String>> {
    let task = match state.aria2_client.tell_status(&req.task_id).await {
        Ok(task) => task,
        Err(_) => {
            let _ = state.aria2_client.remove_download_result(&req.task_id).await;
            return ok_response("Task removed".to_string());
        }
    };

    let status = task["status"].as_str().unwrap_or("");
    let files_to_clean = collect_task_file_paths(&task);
    let config = state.config.read().await.clone();
    let local_path_buf = PathBuf::from(&config.local_path);

    match status {
        "active" | "waiting" | "paused" => {
            let _ = state.aria2_client.force_remove(&req.task_id).await;
            let _ = state.aria2_client.remove_download_result(&req.task_id).await;
            cleanup_download_artifacts(&files_to_clean, &local_path_buf);
        }
        "complete" => {
            let _ = state.aria2_client.remove_download_result(&req.task_id).await;
        }
        _ => {
            let _ = state.aria2_client.remove_download_result(&req.task_id).await;
            cleanup_download_artifacts(&files_to_clean, &local_path_buf);
        }
    }

    refresh_local_tree_cache_if_possible(&state, &config.local_path, "local_update").await;
    ok_response("Task removed".to_string())
}

pub async fn retry_download(
    State(state): State<Arc<AppState>>,
    Json(req): Json<TaskAction>,
) -> Json<ApiResponse<String>> {
    let task = match state.aria2_client.tell_status(&req.task_id).await {
        Ok(task) => task,
        Err(e) => return ok_response(format!("Failed to load task details: {}", e)),
    };

    let status = task["status"].as_str().unwrap_or("");
    if status != "error" && status != "removed" {
        return ok_response("Task is not retryable".to_string());
    }

    let file_name = match task_file_name(&task) {
        Some(name) => name,
        None => return ok_response("Missing original file name".to_string()),
    };
    let out_dir = task["dir"].as_str().unwrap_or("").to_string();
    if out_dir.is_empty() {
        return ok_response("Missing original download directory".to_string());
    }

    let config = state.config.read().await.clone();
    let local_path_normalized = config.local_path.replace("\\", "/");
    let mut retry_url = extract_retry_url(&task);
    if retry_url.is_none() {
        if let Some(remote_path) = task_remote_path(&task, &local_path_normalized) {
            let remote_tree = state.remote_tree.read().await;
            if let Some(remote_nodes) = remote_tree.as_ref() {
                if let Some(remote_id) = find_remote_id_by_path(remote_nodes, &remote_path) {
                    retry_url = build_download_url(&config.teldrive_url, &remote_id, &remote_path).ok();
                }
            }
        }
    }

    let retry_url = match retry_url {
        Some(url) => url,
        None => return ok_response("Missing retry source information".to_string()),
    };

    match state
        .aria2_client
        .add_uri(&retry_url, &file_name, &out_dir, &config.access_token)
        .await
    {
        Ok(_) => {
            let _ = state.aria2_client.remove_download_result(&req.task_id).await;
            ok_response("Task requeued".to_string())
        }
        Err(e) => ok_response(format!("Retry failed: {}", e)),
    }
}

pub async fn pause_all(State(state): State<Arc<AppState>>) -> Json<ApiResponse<String>> {
    let _ = state.aria2_client.pause_all().await;
    ok_response("已暂停全部".to_string())
}

pub async fn resume_all(State(state): State<Arc<AppState>>) -> Json<ApiResponse<String>> {
    let _ = state.aria2_client.unpause_all().await;
    ok_response("已恢复全部".to_string())
}



pub async fn clear_failed(State(state): State<Arc<AppState>>) -> Json<ApiResponse<String>> {
    if let Ok(all) = state.aria2_client.tell_all().await {
        for t in all {
            if t["status"].as_str().unwrap_or("") == "error" {
                if let Some(gid) = t["gid"].as_str() {
                    let _ = state.aria2_client.remove_download_result(gid).await;
                }
            }
        }
    }
    ok_response("已清理失败任务".to_string())
}

pub async fn clear_all(State(state): State<Arc<AppState>>) -> Json<ApiResponse<String>> {
    let config = state.config.read().await.clone();
    let local_path_buf = PathBuf::from(&config.local_path);
    let mut files_to_clean: Vec<PathBuf> = Vec::new();

    let _ = state.aria2_client.pause_all().await; // 先尝试暂停
    if let Ok(all) = state.aria2_client.tell_all().await {
        files_to_clean = collect_incomplete_task_file_paths(&all);

        for t in &all {
            if let Some(gid) = t["gid"].as_str() {
                let status = t["status"].as_str().unwrap_or("");
                if status == "active" || status == "waiting" || status == "paused" {
                    let _ = state.aria2_client.force_remove(gid).await;
                }
            }
        }
    }
    cleanup_download_artifacts(&files_to_clean, &local_path_buf);
    let _ = state.aria2_client.purge_download_result().await;
    refresh_local_tree_cache_if_possible(&state, &config.local_path, "local_update").await;
    ok_response("已清空所有任务".to_string())
}

// ============================
// 安装向导与 Aria2 管理专区
// ============================


#[derive(Serialize, Clone)]
pub struct InstallProgress {
    pub status: String,       // idle | downloading | extracting | done | failed
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
}

static INSTALL_STATE: Lazy<TokioRwLock<InstallProgress>> = Lazy::new(|| {
    TokioRwLock::new(InstallProgress {
        status: "idle".into(),
        downloaded: 0,
        total: 0,
        message: String::new(),
    })
});

#[derive(Serialize)]
pub struct InitStatus {
    pub aria2_installed: bool,
    pub app_configured: bool,
}

pub async fn init_status(State(state): State<Arc<AppState>>) -> Json<ApiResponse<InitStatus>> {
    let config = state.config.read().await;
    ok_response(InitStatus {
        aria2_installed: crate::aria2::check_aria2_exists(),
        app_configured: config.is_configured(),
    })
}

/// GET /api/system/install-progress
pub async fn install_progress() -> Json<ApiResponse<InstallProgress>> {
    let state = INSTALL_STATE.read().await.clone();
    ok_response(state)
}

pub async fn get_update_info(
) -> Result<Json<ApiResponse<UpdateInfo>>, (StatusCode, Json<ApiResponse<UpdateInfo>>)> {
    let info = fetch_update_info()
        .await
        .map_err(|e| err_response::<UpdateInfo>(&e))?;
    Ok(ok_response(info))
}

pub async fn open_update_download(
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let info = fetch_update_info()
        .await
        .map_err(|e| err_response::<String>(&e))?;

    let target = if info.has_update {
        info.download_url
    } else {
        info.release_url
    };

    Ok(ok_response(target))
}

pub async fn apply_update(
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    let info = fetch_update_info()
        .await
        .map_err(|e| err_response::<String>(&e))?;

    install_update_from_info(&info)
        .await
        .map_err(|e| err_response::<String>(&e))?;
    schedule_process_exit();

    Ok(ok_response("更新已安装，服务正在重启".to_string()))
}

#[derive(Deserialize)]
pub struct InstallRequest {
    pub arch: String,
}

/// POST /api/system/install-aria2
pub async fn install_aria2(
    State(state): State<Arc<AppState>>,
    Json(req): Json<InstallRequest>,
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    // 1) 通过 GitHub API 获取最新 release 的真实下载链接
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap();

    let (meta_url, asset_filter): (&str, Box<dyn Fn(&str) -> bool + Send>) = match req.arch.as_str() {
        "win-x64" => (
            "https://api.github.com/repos/aria2/aria2/releases/latest",
            Box::new(|name: &str| name.contains("win-64bit") && name.ends_with(".zip")),
        ),
        "linux-x64" => (
            "https://api.github.com/repos/P3TERX/Aria2-Pro-Core/releases/latest",
            Box::new(|name: &str| name.ends_with("linux-amd64.tar.gz")),
        ),
        "linux-arm64" => (
            "https://api.github.com/repos/P3TERX/Aria2-Pro-Core/releases/latest",
            Box::new(|name: &str| name.ends_with("linux-arm64.tar.gz")),
        ),
        _ => return Err(err_response("不支持的架构")),
    };

    // 设置初始状态
    {
        let mut s = INSTALL_STATE.write().await;
        *s = InstallProgress {
            status: "downloading".into(),
            downloaded: 0,
            total: 0,
            message: "正在获取发布信息...".into(),
        };
    }

    let meta_resp = client
        .get(meta_url)
        .header("User-Agent", "TelSync/1.0")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            let msg = format!("获取发布信息失败: {}", e);
            tokio::spawn(async move {
                let mut s = INSTALL_STATE.write().await;
                *s = InstallProgress { status: "failed".into(), downloaded: 0, total: 0, message: msg.clone() };
            });
            err_response::<String>(&format!("获取发布信息失败: {}", e))
        })?;

    let release: serde_json::Value = meta_resp.json().await.map_err(|e| {
        err_response::<String>(&format!("解析发布信息失败: {}", e))
    })?;

    let assets = release["assets"].as_array().ok_or_else(|| err_response::<String>("未找到发布资产"))?;
    let asset = assets.iter().find(|a| {
        let name = a["name"].as_str().unwrap_or("");
        asset_filter(name)
    }).ok_or_else(|| {
        err_response::<String>("未找到匹配的安装包")
    })?;

    let download_url = asset["browser_download_url"].as_str().unwrap_or("").to_string();
    let file_name = asset["name"].as_str().unwrap_or("aria2").to_string();
    let total_bytes: u64 = asset["size"].as_u64().unwrap_or(0);

    info!("开始下载 {} ({}字节)", file_name, total_bytes);

    // 2) 流式下载并持续更新进度
    {
        let mut s = INSTALL_STATE.write().await;
        s.total = total_bytes;
        s.message = format!("正在下载 {} ...", file_name);
    }

    // 由于 GitHub 可能被墙，使用多个加速源，且每个源限时
    let mirrors = vec![
        format!("https://gh.llkk.cc/{}", download_url),
        format!("https://github.moeyy.xyz/{}", download_url),
        download_url.clone(),
    ];

    let mut download_bytes: Option<bytes::Bytes> = None;
    for (i, url) in mirrors.iter().enumerate() {
        info!("尝试源 {}: {}", i + 1, url);
        {
            let mut s = INSTALL_STATE.write().await;
            s.downloaded = 0;
            s.message = format!("正在从源 {} 下载 {} ...", i + 1, file_name);
        }

        let dl_client = Client::builder()
            .timeout(std::time::Duration::from_secs(300))
            .build()
            .unwrap();

        match dl_client.get(url).header("User-Agent", "TelSync/1.0").send().await {
            Ok(resp) if resp.status().is_success() || resp.status().is_redirection() => {
                // 流式读取
                use futures_util::StreamExt;
                let mut stream = resp.bytes_stream();
                let mut buf = Vec::new();
                let mut downloaded: u64 = 0;

                while let Some(chunk_result) = stream.next().await {
                    match chunk_result {
                        Ok(chunk) => {
                            downloaded += chunk.len() as u64;
                            buf.extend_from_slice(&chunk);
                            // 每 256KB 更新一次状态
                            if downloaded % (256 * 1024) < chunk.len() as u64 {
                                let mut s = INSTALL_STATE.write().await;
                                s.downloaded = downloaded;
                            }
                        }
                        Err(e) => {
                            info!("源 {} 下载中断: {}", i + 1, e);
                            break;
                        }
                    }
                }

                if downloaded > 0 && (total_bytes == 0 || downloaded >= total_bytes / 2) {
                    download_bytes = Some(bytes::Bytes::from(buf));
                    info!("源 {} 下载成功, {} 字节", i + 1, downloaded);
                    break;
                }
            }
            Ok(resp) => {
                info!("源 {} 返回状态码 {}", i + 1, resp.status());
            }
            Err(e) => {
                info!("源 {} 请求失败: {}", i + 1, e);
            }
        }
    }

    let bytes = match download_bytes {
        Some(b) => b,
        None => {
            let mut s = INSTALL_STATE.write().await;
            *s = InstallProgress {
                status: "failed".into(),
                downloaded: 0,
                total: total_bytes,
                message: "所有下载源均失败，请尝试手动上传".into(),
            };
            return Err(err_response("所有下载源均失败"));
        }
    };

    // 3) 解压
    {
        let mut s = INSTALL_STATE.write().await;
        s.status = "extracting".into();
        s.message = format!("正在解压 {} ...", file_name);
    }

    if req.arch == "win-x64" {
        std::fs::write("aria2.zip", &bytes).map_err(|e| err_response::<String>(&e.to_string()))?;
        let file = File::open("aria2.zip").map_err(|e| err_response::<String>(&e.to_string()))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| err_response::<String>(&e.to_string()))?;
        let mut found = false;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| err_response::<String>(&e.to_string()))?;
            if entry.name().ends_with("aria2c.exe") {
                let mut outfile = File::create("aria2c.exe").map_err(|e| err_response::<String>(&e.to_string()))?;
                copy(&mut entry, &mut outfile).map_err(|e| err_response::<String>(&e.to_string()))?;
                found = true;
                break;
            }
        }
        let _ = std::fs::remove_file("aria2.zip");
        if !found {
            let mut s = INSTALL_STATE.write().await;
            *s = InstallProgress { status: "failed".into(), downloaded: 0, total: 0, message: "压缩包中未找到 aria2c.exe".into() };
            return Err(err_response("压缩包中未找到 aria2c.exe"));
        }
    } else if req.arch == "linux-x64" || req.arch == "linux-arm64" {
        // P3TERX 的包是 tar.gz
        std::fs::write("aria2.tar.gz", &bytes).map_err(|e| err_response::<String>(&e.to_string()))?;
        let file = File::open("aria2.tar.gz").map_err(|e| err_response::<String>(&e.to_string()))?;
        let gz = flate2::read::GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        let mut found = false;
        for entry in archive.entries().map_err(|e| err_response::<String>(&e.to_string()))? {
            let mut file = entry.map_err(|e| err_response::<String>(&e.to_string()))?;
            let path = file.path().map_err(|e| err_response::<String>(&e.to_string()))?.into_owned();
            if path.file_name().unwrap_or_default() == "aria2c" {
                let mut outfile = File::create("aria2c").map_err(|e| err_response::<String>(&e.to_string()))?;
                copy(&mut file, &mut outfile).map_err(|e| err_response::<String>(&e.to_string()))?;
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let mut perms = std::fs::metadata("aria2c").unwrap().permissions();
                    perms.set_mode(0o755);
                    std::fs::set_permissions("aria2c", perms).unwrap();
                }
                found = true;
                break;
            }
        }
        let _ = std::fs::remove_file("aria2.tar.gz");
        if !found {
            let mut s = INSTALL_STATE.write().await;
            *s = InstallProgress { status: "failed".into(), downloaded: 0, total: 0, message: "压缩包中未找到 aria2c".into() };
            return Err(err_response("压缩包中未找到 aria2c"));
        }
    }

    // 4) 完成
    {
        let mut s = INSTALL_STATE.write().await;
        *s = InstallProgress {
            status: "done".into(),
            downloaded: bytes.len() as u64,
            total: bytes.len() as u64,
            message: "Aria2 安装成功！".into(),
        };
    }
    info!("Aria2 安装完成");
    
    // 自动触发启动
    let config = state.config.read().await;
    if let Err(e) = spawn_aria2_from_config(&config) {
        tracing::error!("Aria2 提取成功但自动启动失败: {}", e);
    } else {
        state.aria2_client.set_secret(config.rpc_secret.clone()).await;
        info!("Aria2 安装后自动启动成功");
    }

    Ok(ok_response("Aria2 安装成功".to_string()))
}

pub async fn upload_aria2(
    State(state): State<Arc<AppState>>,
    mut multipart: Multipart
) -> Result<Json<ApiResponse<String>>, (StatusCode, Json<ApiResponse<String>>)> {
    while let Some(field) = multipart.next_field().await.unwrap() {
        let name = field.name().unwrap().to_string();
        if name == "file" {
            let data = field.bytes().await.unwrap();
            let target_name = if cfg!(windows) { "aria2c.exe" } else { "aria2c" };
            let mut f = File::create(target_name).unwrap();
            f.write_all(&data).unwrap();

            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(target_name).unwrap().permissions();
                perms.set_mode(0o755);
                std::fs::set_permissions(target_name, perms).unwrap();
            }

            // 自动触发启动
            let config = state.config.read().await;
            if let Err(e) = spawn_aria2_from_config(&config) {
                tracing::error!("Aria2 上传成功但自动启动失败: {}", e);
            } else {
                state.aria2_client.set_secret(config.rpc_secret.clone()).await;
                info!("Aria2 上传后自动启动成功");
            }

            return Ok(ok_response("离线文件上传配置成功。".to_string()));
        }
    }
    Err(err_response("上传失败"))
}

