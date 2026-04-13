use crate::state::FileNode;
use reqwest::Client;
use serde::Deserialize;
use tracing::info;

#[derive(Debug, Deserialize)]
struct TelDriveFileList {
    items: Vec<TelDriveFile>,
    meta: TelDriveMeta,
}

#[derive(Debug, Deserialize)]
struct TelDriveFile {
    id: Option<String>,
    name: String,
    #[serde(rename = "type")]
    file_type: String,
    #[serde(default)]
    size: Option<u64>,
    #[serde(rename = "mimeType")]
    mime_type: Option<String>,
    #[allow(dead_code)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelDriveMeta {
    #[serde(rename = "nextCursor")]
    next_cursor: Option<String>,
}

pub struct TelDriveClient {
    /// API 客户端（列文件、测试连接等，支持自动解压）
    client: Client,
    base_url: String,
    access_token: String,
}

impl TelDriveClient {
    pub fn new(base_url: &str, access_token: &str) -> Self {
        // API 客户端：短超时，自动解压
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("创建 HTTP 客户端失败");

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            access_token: access_token.to_string(),
        }
    }

    /// 列出指定路径下的所有文件和文件夹（单层）
    async fn list_path(&self, path: &str) -> Result<Vec<TelDriveFile>, String> {
        let mut all_files = Vec::new();
        let mut cursor: Option<String> = None;

        loop {
            let mut url = format!(
                "{}/api/files?path={}&sort=name&order=asc&limit=500",
                self.base_url,
                urlencoding::encode(path)
            );
            if let Some(ref c) = cursor {
                url.push_str(&format!("&cursor={}", urlencoding::encode(c)));
            }

            let resp = self
                .client
                .get(&url)
                .header("Cookie", format!("access_token={}", self.access_token))
                .send()
                .await
                .map_err(|e| format!("请求 TelDrive 失败: {}", e))?;

            if !resp.status().is_success() {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                return Err(format!("TelDrive API 返回 {}: {}", status, body));
            }

            let file_list: TelDriveFileList = resp
                .json()
                .await
                .map_err(|e| format!("解析响应失败: {}", e))?;

            all_files.extend(file_list.items);

            match file_list.meta.next_cursor {
                Some(c) if !c.is_empty() => cursor = Some(c),
                _ => break,
            }
        }

        Ok(all_files)
    }

    /// 递归获取指定路径下的完整文件树
    pub async fn fetch_tree(&self, path: &str) -> Result<Vec<FileNode>, String> {
        info!("正在扫描远程路径: {}", path);
        let files = self.list_path(path).await?;
        let mut nodes = Vec::new();

        for file in files {
            let child_path = if path == "/" {
                format!("/{}", file.name)
            } else {
                format!("{}/{}", path, file.name)
            };

            if file.file_type == "folder" {
                // 递归获取子目录
                let children = Box::pin(self.fetch_tree(&child_path)).await?;
                nodes.push(FileNode {
                    name: file.name,
                    path: child_path,
                    is_dir: true,
                    size: 0,
                    remote_id: file.id,
                    mime_type: None,
                    exists_locally: false,
                    children,
                });
            } else {
                nodes.push(FileNode {
                    name: file.name,
                    path: child_path,
                    is_dir: false,
                    size: file.size.unwrap_or(0),
                    remote_id: file.id,
                    mime_type: file.mime_type,
                    exists_locally: false,
                    children: vec![],
                });
            }
        }

        Ok(nodes)
    }



    /// 测试连接
    pub async fn test_connection(&self) -> Result<String, String> {
        let url = format!("{}/api/auth/session", self.base_url);
        let resp = self
            .client
            .get(&url)
            .header("Cookie", format!("access_token={}", self.access_token))
            .send()
            .await
            .map_err(|e| format!("连接失败: {}", e))?;

        if resp.status().is_success() {
            Ok("连接成功".to_string())
        } else if resp.status().as_u16() == 204 {
            Err("认证令牌无效，请检查 access_token".to_string())
        } else {
            Err(format!("连接失败，状态码: {}", resp.status()))
        }
    }
}
