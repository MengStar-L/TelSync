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

    let mut entries: Vec<_> = entries
        .collect::<Result<_, _>>()
        .map_err(|e| format!("读取目录项失败 {:?}: {}", dir, e))?;
    entries.sort_by_key(|a| a.file_name());

    for entry in entries {
        let file_name = entry.file_name().to_string_lossy().to_string();
        // 跳过隐藏文件和临时文件
        if file_name.starts_with('.')
            || file_name.ends_with(".part")
            || file_name.ends_with(".aria2")
            || file_name.ends_with(".aria2__temp")
        {
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

        // aria2 会提前分配目标文件；控制文件存在时，目标仍是不完整的下载。
        if !metadata.is_dir()
            && (dir.join(format!("{}.aria2", file_name)).exists()
                || dir.join(format!("{}.aria2__temp", file_name)).exists())
        {
            continue;
        }

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
        } else if metadata.is_file() {
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
pub fn mark_local_existence(remote_nodes: &mut [FileNode], local_nodes: &[FileNode]) {
    for remote in remote_nodes.iter_mut() {
        // 先重置为 false，再根据本地树的匹配结果重新标记
        remote.exists_locally = false;
        let local_match = local_nodes.iter().find(|l| l.name == remote.name);

        if remote.is_dir {
            if let Some(local) = local_match.filter(|local| local.is_dir) {
                remote.exists_locally = true;
                mark_local_existence(&mut remote.children, &local.children);
            } else {
                // 缺失目录或同名文件阻挡目录时，子节点都不能沿用旧标记。
                reset_exists_locally(&mut remote.children);
            }
        } else if let Some(local) = local_match.filter(|local| !local.is_dir) {
            remote.exists_locally = remote.size == local.size;
        }
    }
}

/// 递归重置所有节点的 exists_locally 为 false
fn reset_exists_locally(nodes: &mut [FileNode]) {
    for node in nodes.iter_mut() {
        node.exists_locally = false;
        if node.is_dir {
            reset_exists_locally(&mut node.children);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn file(name: &str, size: u64) -> FileNode {
        FileNode {
            name: name.to_string(),
            path: format!("/{}", name),
            is_dir: false,
            size,
            remote_id: None,
            mime_type: None,
            exists_locally: true,
            children: vec![],
        }
    }

    #[test]
    fn incomplete_downloads_are_not_reported_as_local_files() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("telsync-scan-{}", suffix));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("partial.bin"), b"preallocated").unwrap();
        std::fs::write(root.join("partial.bin.aria2"), b"state").unwrap();
        std::fs::write(root.join("temporary.bin"), b"preallocated").unwrap();
        std::fs::write(root.join("temporary.bin.aria2__temp"), b"state").unwrap();
        std::fs::write(root.join("complete.bin"), b"done").unwrap();

        let local = scan_local_dir(root.to_str().unwrap()).unwrap();
        assert_eq!(local.len(), 1);
        assert_eq!(local[0].name, "complete.bin");

        std::fs::remove_file(root.join("partial.bin.aria2")).unwrap();
        let local = scan_local_dir(root.to_str().unwrap()).unwrap();
        assert!(local.iter().any(|node| node.name == "partial.bin"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_named_file_requires_matching_size() {
        let mut remote = vec![file("incomplete.bin", 100), file("complete.bin", 100)];
        let local = vec![file("incomplete.bin", 50), file("complete.bin", 100)];
        mark_local_existence(&mut remote, &local);
        assert!(!remote[0].exists_locally);
        assert!(remote[1].exists_locally);
    }

    #[test]
    fn file_blocking_remote_directory_clears_descendant_flags() {
        let mut directory = file("folder", 0);
        directory.is_dir = true;
        directory.children = vec![file("child.bin", 10)];
        let mut remote = vec![directory];
        mark_local_existence(&mut remote, &[file("folder", 5)]);
        assert!(!remote[0].exists_locally);
        assert!(!remote[0].children[0].exists_locally);
    }
}
