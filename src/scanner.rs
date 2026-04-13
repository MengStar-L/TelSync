use crate::state::FileNode;
use std::path::Path;
use tracing::info;

/// 递归扫描本地目录，返回文件树
pub fn scan_local_dir(root: &str) -> Result<Vec<FileNode>, String> {
    let root_path = Path::new(root);
    if !root_path.exists() {
        return Err(format!("本地路径不存在: {}", root));
    }
    if !root_path.is_dir() {
        return Err(format!("路径不是文件夹: {}", root));
    }

    info!("正在扫描本地路径: {}", root);
    scan_dir_recursive(root_path, "/")
}

fn scan_dir_recursive(dir: &Path, relative_prefix: &str) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();

    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败 {:?}: {}", dir, e))?;

    let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for entry in entries {
        let file_name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件和临时文件
        if file_name.starts_with('.') || file_name.ends_with(".part") {
            continue;
        }

        let child_path = if relative_prefix == "/" {
            format!("/{}", file_name)
        } else {
            format!("{}/{}", relative_prefix, file_name)
        };

        let metadata = entry
            .metadata()
            .map_err(|e| format!("读取元数据失败: {}", e))?;

        if metadata.is_dir() {
            let children = scan_dir_recursive(&entry.path(), &child_path)?;
            nodes.push(FileNode {
                name: file_name,
                path: child_path,
                is_dir: true,
                size: 0,
                remote_id: None,
                mime_type: None,
                exists_locally: true,
                children,
            });
        } else {
            nodes.push(FileNode {
                name: file_name,
                path: child_path,
                is_dir: false,
                size: metadata.len(),
                remote_id: None,
                mime_type: None,
                exists_locally: true,
                children: vec![],
            });
        }
    }

    Ok(nodes)
}

/// 将远程树与本地树对比，标记 exists_locally
pub fn mark_local_existence(remote_nodes: &mut Vec<FileNode>, local_nodes: &[FileNode]) {
    for remote in remote_nodes.iter_mut() {
        // 先重置为 false，再根据本地树的匹配结果重新标记
        remote.exists_locally = false;
        let local_match = local_nodes.iter().find(|l| l.name == remote.name);

        if let Some(local) = local_match {
            if remote.is_dir && local.is_dir {
                remote.exists_locally = true;
                mark_local_existence(&mut remote.children, &local.children);
            } else if !remote.is_dir && !local.is_dir {
                remote.exists_locally = true;
            }
        } else if remote.is_dir {
            // 本地不存在该文件夹，递归重置子节点
            reset_exists_locally(&mut remote.children);
        }
    }
}

/// 递归重置所有节点的 exists_locally 为 false
fn reset_exists_locally(nodes: &mut Vec<FileNode>) {
    for node in nodes.iter_mut() {
        node.exists_locally = false;
        if node.is_dir {
            reset_exists_locally(&mut node.children);
        }
    }
}
