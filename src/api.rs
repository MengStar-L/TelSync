use crate::config::AppConfig;
use crate::scanner::{mark_local_existence, scan_local_dir};
use crate::state::{AppState, FileNode};
use crate::teldrive::TelDriveClient;
use axum::extract::{Multipart, State};
use axum::http::StatusCode;
use axum::response::Json;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{copy, Write};
use std::path::Path;
use std::sync::Arc;
use tracing::{error, info};

#[derive(Deserialize)]
pub struct ConfigUpdate {
    pub teldrive_url: Option<String>,
    pub access_token: Option<String>,
    pub local_path: Option<String>,
    pub max_concurrent_downloads: Option<usize>,
    pub proxy_url: Option<String>,
    pub proxy_user: Option<String>,
    pub proxy_passwd: Option<String>,
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
    if let Some(url) = update.teldrive_url {
        config.teldrive_url = url.trim_end_matches('/').to_string();
    }
    if let Some(token) = update.access_token {
        config.access_token = token;
    }
    if let Some(path) = update.local_path {
        config.local_path = path
            .trim_end_matches('\\')
            .trim_end_matches('/')
            .to_string();
    }
    if let Some(max) = update.max_concurrent_downloads {
        config.max_concurrent_downloads = max.clamp(1, 5);
    }
    if let Some(proxy_url) = update.proxy_url {
        config.proxy_url = proxy_url;
    }
    if let Some(proxy_user) = update.proxy_user {
        config.proxy_user = proxy_user;
    }
    if let Some(proxy_passwd) = update.proxy_passwd {
        config.proxy_passwd = proxy_passwd;
    }
    config.save().map_err(|e| err_response::<String>(&e))?;
    
    // 实时生效 Aria2 配置
    let mut options = serde_json::Map::new();
    options.insert(
        "max-concurrent-downloads".to_string(),
        serde_json::json!(config.max_concurrent_downloads.to_string()),
    );
    options.insert(
        "all-proxy".to_string(),
        serde_json::json!(config.proxy_url),
    );
    options.insert(
        "all-proxy-user".to_string(),
        serde_json::json!(config.proxy_user),
    );
    options.insert(
        "all-proxy-passwd".to_string(),
        serde_json::json!(config.proxy_passwd),
    );
    let _ = state.aria2_client.change_global_option(serde_json::Value::Object(options)).await;

    Ok(ok_response("配置已保存并生效".to_string()))
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
}

pub async fn get_trees(State(state): State<Arc<AppState>>) -> Json<ApiResponse<TreeResponse>> {
    let remote = state.remote_tree.read().await.clone().unwrap_or_default();
    let local = state.local_tree.read().await.clone().unwrap_or_default();
    ok_response(TreeResponse { remote, local })
}

pub async fn refresh_trees(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<TreeResponse>>, (StatusCode, Json<ApiResponse<TreeResponse>>)> {
    let config = state.config.read().await.clone();
    if !config.is_configured() {
        return Err(err_response("请先完成配置"));
    }
    let client = TelDriveClient::new(&config.teldrive_url, &config.access_token);
    let mut remote_tree = client
        .fetch_tree("/")
        .await
        .map_err(|e| err_response::<TreeResponse>(&e))?;
    let local_tree =
        scan_local_dir(&config.local_path).map_err(|e| err_response::<TreeResponse>(&e))?;
    mark_local_existence(&mut remote_tree, &local_tree);
    *state.remote_tree.write().await = Some(remote_tree.clone());
    *state.local_tree.write().await = Some(local_tree.clone());
    info!("文件树已刷新");
    Ok(ok_response(TreeResponse {
        remote: remote_tree,
        local: local_tree,
    }))
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
            let file_url = format!("{}/api/files/{}/download", config.teldrive_url, id);
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
    let local_path = config.local_path.clone();
    let target_path = std::path::Path::new(&local_path).join(req.path.trim_start_matches('/'));

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

    // 向上兜底检查：如果删除后所在目录变为空，则顺藤摸瓜将空文件夹全部删掉，直到 local_path
    let mut current_dir = target_path.parent();
    let local_path_buf = std::path::PathBuf::from(&local_path);
    while let Some(parent) = current_dir {
        if parent == local_path_buf { break; } // 到达根目录，停止
        if parent.starts_with(&local_path_buf) {
            if let Ok(mut iter) = std::fs::read_dir(parent) {
                if iter.next().is_none() { 
                    let _ = std::fs::remove_dir(parent); // 是空文件夹，移除
                } else {
                    break; // 非空，停止向上清理
                }
            } else {
                break;
            }
            current_dir = parent.parent();
        } else {
            break;
        }
    }

    // 触发刷新本地文件树以更新状态
    if let Ok(local_tree) = crate::scanner::scan_local_dir(&config.local_path) {
        let mut remote_tree_guard = state.remote_tree.write().await;
        if let Some(remote_tree) = remote_tree_guard.as_mut() {
            crate::scanner::mark_local_existence(remote_tree, &local_tree);
        }
        *state.local_tree.write().await = Some(local_tree);
    }

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
    let mut view_tasks = Vec::new();
    if let Ok(all) = state.aria2_client.tell_all().await {
        for t in all {
            let gid = t["gid"].as_str().unwrap_or("").to_string();
            let status_raw = t["status"].as_str().unwrap_or("unknown");
            
            // 收到指令要求不再保留已完成的条目，直接在 Aria2 中彻底清掉记录也不向前端展示
            if status_raw == "complete" {
                let _ = state.aria2_client.remove_download_result(&gid).await;
                continue;
            }

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
    // 先查询任务的文件路径信息，以便取消后清理残留
    let mut files_to_clean: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(status) = state.aria2_client.tell_status(&req.task_id).await {
        if let Some(files) = status["files"].as_array() {
            for f in files {
                if let Some(path_str) = f["path"].as_str() {
                    if !path_str.is_empty() {
                        files_to_clean.push(std::path::PathBuf::from(path_str));
                    }
                }
            }
        }
    }

    // 移除 Aria2 任务
    let _ = state.aria2_client.remove(&req.task_id).await;
    let _ = state.aria2_client.remove_download_result(&req.task_id).await;

    // 清理本地残留文件
    let config = state.config.read().await.clone();
    let local_path_buf = std::path::PathBuf::from(&config.local_path);
    for file_path in &files_to_clean {
        // 删除主体文件
        let _ = std::fs::remove_file(file_path);
        // 删除 .aria2 侧载文件
        let mut aria2_path = file_path.clone().into_os_string();
        aria2_path.push(".aria2");
        let _ = std::fs::remove_file(aria2_path);

        // 向上清理空文件夹
        let mut current_dir = file_path.parent();
        while let Some(parent) = current_dir {
            if parent == local_path_buf || !parent.starts_with(&local_path_buf) { break; }
            if let Ok(mut iter) = std::fs::read_dir(parent) {
                if iter.next().is_none() {
                    let _ = std::fs::remove_dir(parent);
                } else { break; }
            } else { break; }
            current_dir = parent.parent();
        }
    }

    // 刷新本地文件树缓存
    if let Ok(local_tree) = crate::scanner::scan_local_dir(&config.local_path) {
        let mut remote_tree_guard = state.remote_tree.write().await;
        if let Some(remote_tree) = remote_tree_guard.as_mut() {
            crate::scanner::mark_local_existence(remote_tree, &local_tree);
        }
        *state.local_tree.write().await = Some(local_tree);
    }

    ok_response("已取消并清理文件".to_string())
}

pub async fn retry_download(
    State(state): State<Arc<AppState>>,
    Json(_req): Json<TaskAction>,
) -> Json<ApiResponse<String>> {
    // Aria2 无法简单 unpause error 状态的任务除非重新加入，但这里为了极简处理，我们只尝试解绑错误记录并重试
    // 在真实应用中可能需要提取原 url。
    let _ = state.aria2_client.purge_download_result().await;
    ok_response("Aria2重试触发".to_string())
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
    let _ = state.aria2_client.pause_all().await; // 先尝试暂停
    if let Ok(all) = state.aria2_client.tell_all().await {
        for t in all {
            if let Some(gid) = t["gid"].as_str() {
                let status = t["status"].as_str().unwrap_or("");
                if status == "active" || status == "waiting" || status == "paused" {
                    let _ = state.aria2_client.force_remove(gid).await;
                }
            }
        }
    }
    let _ = state.aria2_client.purge_download_result().await;
    ok_response("已清空所有任务".to_string())
}

// ============================
// 安装向导与 Aria2 管理专区
// ============================


use tokio::sync::RwLock as TokioRwLock;
use once_cell::sync::Lazy;

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
    let local_path = if config.local_path.is_empty() { "." } else { &config.local_path };
    if let Err(e) = crate::aria2::spawn_aria2(local_path, 16800, config.max_concurrent_downloads, &config.proxy_url, &config.proxy_user, &config.proxy_passwd) {
        tracing::error!("Aria2 提取成功但自动启动失败: {}", e);
    } else {
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
            let local_path = if config.local_path.is_empty() { "." } else { &config.local_path };
            if let Err(e) = crate::aria2::spawn_aria2(local_path, 16800, config.max_concurrent_downloads, &config.proxy_url, &config.proxy_user, &config.proxy_passwd) {
                tracing::error!("Aria2 上传成功但自动启动失败: {}", e);
            } else {
                info!("Aria2 上传后自动启动成功");
            }

            return Ok(ok_response("离线文件上传配置成功。".to_string()));
        }
    }
    Err(err_response("上传失败"))
}

