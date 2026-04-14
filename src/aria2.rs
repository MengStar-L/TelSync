use reqwest::Client;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;
use tokio::process::Command;
use tokio::sync::RwLock;
use tracing::{info, warn};

#[derive(Clone)]
pub struct Aria2Client {
    client: Client,
    rpc_url: String,
    rpc_secret: Arc<RwLock<String>>,
}

impl Aria2Client {
    pub fn new(port: u16, rpc_secret: String) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            rpc_url: format!("http://localhost:{}/jsonrpc", port),
            rpc_secret: Arc::new(RwLock::new(rpc_secret)),
        }
    }

    pub async fn set_secret(&self, rpc_secret: String) {
        *self.rpc_secret.write().await = rpc_secret;
    }

    async fn call(&self, method: &str, mut params: Vec<Value>) -> Result<Value, String> {
        let rpc_secret = self.rpc_secret.read().await.clone();
        if !rpc_secret.is_empty() {
            params.insert(0, json!(format!("token:{}", rpc_secret)));
        }

        let req_body = json!({
            "jsonrpc": "2.0",
            "id": "telsync",
            "method": method,
            "params": params,
        });

        let resp = self
            .client
            .post(&self.rpc_url)
            .json(&req_body)
            .send()
            .await
            .map_err(|e| format!("RPC 请求失败: {}", e))?;

        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取响应失败: {}", e))?;
        let json_resp: Value =
            serde_json::from_str(&text).map_err(|e| format!("解析 JSON 失败: {}", e))?;

        if let Some(err) = json_resp.get("error") {
            return Err(format!("RPC 返回错误: {:?}", err));
        }

        Ok(json_resp["result"].clone())
    }

    pub async fn add_uri(
        &self,
        url: &str,
        out_path: &str,
        dir: &str,
        cookie: &str,
    ) -> Result<String, String> {
        let options = json!({
            "out": out_path,
            "dir": dir,
            "header": [format!("Cookie: access_token={}", cookie)],
            "max-connection-per-server": "16",
            "split": "16",
            "continue": "true",
            "allow-overwrite": "false"
        });
        let res = self
            .call("aria2.addUri", vec![json!([url]), options])
            .await?;
        Ok(res.as_str().unwrap_or("").to_string())
    }

    /// 获取所有状态的任务：活跃的，等待的，已停止的
    pub async fn tell_all(&self) -> Result<Vec<Value>, String> {
        let keys = json!([
            "gid",
            "status",
            "totalLength",
            "completedLength",
            "downloadSpeed",
            "files",
            "dir",
            "errorMessage"
        ]);

        let mut all = Vec::new();
        if let Ok(active) = self.call("aria2.tellActive", vec![keys.clone()]).await {
            if let Some(arr) = active.as_array() {
                all.extend(arr.clone());
            }
        }
        if let Ok(waiting) = self
            .call("aria2.tellWaiting", vec![json!(0), json!(1000), keys.clone()])
            .await
        {
            if let Some(arr) = waiting.as_array() {
                all.extend(arr.clone());
            }
        }
        if let Ok(stopped) = self
            .call("aria2.tellStopped", vec![json!(0), json!(1000), keys.clone()])
            .await
        {
            if let Some(arr) = stopped.as_array() {
                all.extend(arr.clone());
            }
        }
        Ok(all)
    }

    /// 查询单个任务的状态信息
    pub async fn tell_status(&self, gid: &str) -> Result<Value, String> {
        let keys = json!(["gid", "status", "files", "dir"]);
        self.call("aria2.tellStatus", vec![json!(gid), keys]).await
    }

    pub async fn remove(&self, gid: &str) -> Result<(), String> {
        let _ = self.call("aria2.remove", vec![json!(gid)]).await;
        Ok(())
    }

    pub async fn purge_download_result(&self) -> Result<(), String> {
        let _ = self.call("aria2.purgeDownloadResult", vec![]).await;
        Ok(())
    }

    pub async fn remove_download_result(&self, gid: &str) -> Result<(), String> {
        let _ = self.call("aria2.removeDownloadResult", vec![serde_json::json!(gid)]).await;
        Ok(())
    }

    pub async fn pause_all(&self) -> Result<(), String> {
        let _ = self.call("aria2.pauseAll", vec![]).await;
        Ok(())
    }

    pub async fn unpause_all(&self) -> Result<(), String> {
        let _ = self.call("aria2.unpauseAll", vec![]).await;
        Ok(())
    }

    pub async fn force_remove(&self, gid: &str) -> Result<(), String> {
        let _ = self.call("aria2.forceRemove", vec![serde_json::json!(gid)]).await;
        Ok(())
    }

    pub async fn change_global_option(&self, options: serde_json::Value) -> Result<Value, String> {
        self.call("aria2.changeGlobalOption", vec![options]).await
    }

    pub async fn force_shutdown(&self) -> Result<(), String> {
        self.call("aria2.forceShutdown", vec![]).await.map(|_| ())
    }
}

fn aria2_binary_path() -> PathBuf {
    let file_name = if cfg!(windows) { "aria2c.exe" } else { "aria2c" };

    if let Ok(current_dir) = std::env::current_dir() {
        let candidate = current_dir.join(file_name);
        if candidate.exists() {
            return candidate;
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(dir) = current_exe.parent() {
            let candidate = dir.join(file_name);
            if candidate.exists() {
                return candidate;
            }
        }
    }

    PathBuf::from(file_name)
}

fn normalize_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = normalize_path(left);
    let right = normalize_path(right);

    if cfg!(windows) {
        left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn cleanup_managed_aria2_processes(port: u16, aria2_path: &Path) {
    let target_path = normalize_path(aria2_path);
    let mut system = System::new_all();
    system.refresh_all();

    let mut killed = 0;
    let port_flag = format!("--rpc-listen-port={}", port);

    for process in system.processes().values() {
        let cmd = process
            .cmd()
            .iter()
            .map(|part| part.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        let port_matches = cmd.contains(&port_flag);
        let exe_matches = process
            .exe()
            .map(|exe| same_path(exe, &target_path))
            .unwrap_or(false);
        let looks_like_aria2 = process
            .name()
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("aria2");

        if (exe_matches && (port_matches || cmd.contains("--enable-rpc=true")))
            || (port_matches && looks_like_aria2)
        {
            if process.kill() {
                killed += 1;
            } else {
                warn!("未能终止旧的 aria2 进程: {:?}", process.name());
            }
        }
    }

    if killed > 0 {
        info!("已清理 {} 个旧的 Aria2 进程", killed);
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub fn check_aria2_exists() -> bool {
    aria2_binary_path().exists()
}

pub fn spawn_aria2(
    local_dir: &str,
    port: u16,
    max_concurrent: usize,
    proxy_url: &str,
    proxy_user: &str,
    proxy_passwd: &str,
    rpc_allow_remote: bool,
    rpc_secret: &str,
) -> Result<(), String> {
    let aria2_exe = aria2_binary_path();

    if !aria2_exe.exists() {
        return Err("未找到 Aria2".to_string());
    }

    cleanup_managed_aria2_processes(port, &aria2_exe);

    info!("启动 Aria2 进程 (端口 {})...", port);
    let mut cmd = Command::new(&aria2_exe);
    cmd.arg("--enable-rpc=true")
        .arg(format!("--rpc-listen-port={}", port))
        .arg(format!("--rpc-listen-all={}", rpc_allow_remote))
        .arg("--rpc-allow-origin-all=true")
        .arg(format!("--max-concurrent-downloads={}", max_concurrent))
        .arg("--continue=true")
        .arg("--auto-file-renaming=false")
        .arg("--allow-overwrite=false")
        .arg(format!("--dir={}", local_dir));

    if !rpc_secret.is_empty() {
        cmd.arg(format!("--rpc-secret={}", rpc_secret));
    }

    if !proxy_url.is_empty() {
        cmd.arg(format!("--all-proxy={}", proxy_url));
        if !proxy_user.is_empty() {
            cmd.arg(format!("--all-proxy-user={}", proxy_user));
        }
        if !proxy_passwd.is_empty() {
            cmd.arg(format!("--all-proxy-passwd={}", proxy_passwd));
        }
        info!("Aria2 代理已配置: {}", proxy_url);
    }

    if rpc_allow_remote {
        info!("Aria2 RPC 已允许外部访问");
    }
    if !rpc_secret.is_empty() {
        info!("Aria2 RPC 密码已配置");
    }

    let mut child = cmd
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("无法启动 aria2: {}", e))?;

    std::thread::sleep(Duration::from_millis(200));
    if let Some(status) = child
        .try_wait()
        .map_err(|e| format!("检查 aria2 启动状态失败: {}", e))?
    {
        return Err(format!("Aria2 启动后立即退出: {}", status));
    }

    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => tracing::error!("Aria2 进程已退出, 状态码: {}", status),
            Err(e) => tracing::error!("Aria2 进程退出监听异常: {}", e),
        }
    });

    Ok(())
}
