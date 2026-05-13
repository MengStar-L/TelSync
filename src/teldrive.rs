use crate::state::FileNode;
use reqwest::{Client, StatusCode};
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
    client: Client,
    base_url: String,
    access_token: String,
}

impl TelDriveClient {
    pub fn new(base_url: &str, access_token: &str) -> Self {
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("failed to create TelDrive HTTP client");

        Self {
            client,
            base_url: base_url.trim_end_matches('/').to_string(),
            access_token: access_token.to_string(),
        }
    }

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

    pub async fn fetch_tree(&self, path: &str) -> Result<Vec<FileNode>, String> {
        info!("Scanning remote path: {}", path);
        let files = self.list_path(path).await?;
        let mut nodes = Vec::new();

        for file in files {
            let child_path = if path == "/" {
                format!("/{}", file.name)
            } else {
                format!("{}/{}", path, file.name)
            };

            if file.file_type == "folder" {
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

    pub async fn test_connection(&self) -> Result<String, String> {
        let url = format!("{}/api/auth/session", self.base_url);
        let resp = self
            .client
            .get(&url)
            .header("Cookie", format!("access_token={}", self.access_token))
            .send()
            .await
            .map_err(|e| format!("连接失败: {}", e))?;

        classify_test_connection_status(resp.status())
    }
}

fn classify_test_connection_status(status: StatusCode) -> Result<String, String> {
    if status == StatusCode::NO_CONTENT {
        Err("认证令牌无效，请检查 access_token".to_string())
    } else if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        Err("认证失败，请重新获取 access_token".to_string())
    } else if status.is_success() {
        Ok("连接成功".to_string())
    } else {
        Err(format!("连接失败，状态码: {}", status))
    }
}

#[cfg(test)]
mod tests {
    use super::classify_test_connection_status;
    use reqwest::StatusCode;

    #[test]
    fn treats_200_as_success() {
        assert!(classify_test_connection_status(StatusCode::OK).is_ok());
    }

    #[test]
    fn treats_204_as_invalid_token() {
        let err = classify_test_connection_status(StatusCode::NO_CONTENT).unwrap_err();
        assert!(err.contains("access_token"));
    }

    #[test]
    fn treats_401_and_403_as_auth_failures() {
        assert!(classify_test_connection_status(StatusCode::UNAUTHORIZED)
            .unwrap_err()
            .contains("认证失败"));
        assert!(classify_test_connection_status(StatusCode::FORBIDDEN)
            .unwrap_err()
            .contains("认证失败"));
    }
}
