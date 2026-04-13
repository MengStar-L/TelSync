use reqwest::Client;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tracing::info;

#[derive(Clone)]
pub struct Aria2Client {
    client: Client,
    rpc_url: String,
}

impl Aria2Client {
    pub fn new(port: u16) -> Self {
        Self {
            client: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            rpc_url: format!("http://localhost:{}/jsonrpc", port),
        }
    }

    async fn call(&self, method: &str, params: Vec<Value>) -> Result<Value, String> {
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
}

pub fn check_aria2_exists() -> bool {
    let aria2_exe = if cfg!(windows) {
        "aria2c.exe"
    } else {
        "./aria2c"
    };
    std::path::Path::new(aria2_exe).exists()
}

pub fn spawn_aria2(local_dir: &str, port: u16, max_concurrent: usize, proxy_url: &str, proxy_user: &str, proxy_passwd: &str) -> Result<(), String> {
    let aria2_exe = if cfg!(windows) {
        ".\\aria2c.exe"
    } else {
        "./aria2c"
    };

    if !std::path::Path::new(aria2_exe).exists() {
        return Err("未找到 Aria2".to_string());
    }

    info!("启动 Aria2 进程 (端口 {})...", port);
    // 使用 Command 启动子进程，并将输出放入 null 以避免污染日志
    let mut cmd = Command::new(aria2_exe);
    cmd.arg("--enable-rpc=true")
        .arg(format!("--rpc-listen-port={}", port))
        .arg("--rpc-listen-all=false")
        .arg("--rpc-allow-origin-all=true")
        .arg(format!("--max-concurrent-downloads={}", max_concurrent))
        .arg("--continue=true")
        .arg("--auto-file-renaming=false")
        .arg("--allow-overwrite=false")
        .arg(format!("--dir={}", local_dir));

    // 代理配置
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

    let child = cmd
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("无法启动 aria2: {}", e))?;


    // 监控意外退出
    let mut child = child;
    tokio::spawn(async move {
        match child.wait().await {
            Ok(status) => tracing::error!("Aria2 进程已退出, 状态码: {}", status),
            Err(e) => tracing::error!("Aria2 进程退出监听异常: {}", e),
        }
    });

    Ok(())
}
