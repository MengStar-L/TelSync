use crate::api::{build_update_info_from_release, cleanup_empty_parent_dirs, resolve_local_target};
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_test_dir(name: &str) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("telsync-{}-{}", name, suffix));
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn allows_deleting_nested_files_inside_root() {
    let root = temp_test_dir("nested");
    let nested = root.join("a").join("b");
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("file.txt"), b"ok").unwrap();

    let resolved = resolve_local_target(&root, "a/b/file.txt").unwrap();
    let canonical_root = fs::canonicalize(&root).unwrap();
    assert!(resolved.starts_with(&canonical_root));

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_prunes_empty_parent_dirs_but_keeps_root() {
    let root = temp_test_dir("cleanup");
    let nested = root.join("a").join("b");
    fs::create_dir_all(&nested).unwrap();
    let file_path = nested.join("file.txt");
    fs::write(&file_path, b"ok").unwrap();

    fs::remove_file(&file_path).unwrap();
    cleanup_empty_parent_dirs(&file_path, &root);

    assert!(root.exists());
    assert!(!root.join("a").exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_parent_directory_traversal() {
    let root = temp_test_dir("parent");
    let err = resolve_local_target(&root, "../outside.txt").unwrap_err();
    assert_eq!(err, "目标路径非法");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn rejects_absolute_paths() {
    let root = temp_test_dir("absolute");
    let absolute = std::env::temp_dir().join("escape.txt");
    let err = resolve_local_target(&root, absolute.to_string_lossy().as_ref()).unwrap_err();
    assert_eq!(err, "目标路径非法");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn update_info_detects_newer_version() {
    let release = serde_json::json!({
        "tag_name": "v1.2.0",
        "published_at": "2026-05-13T12:49:23Z",
        "body": "notes",
        "html_url": "https://example.com/release",
        "assets": []
    });

    let info = build_update_info_from_release(&release, "1.1.0");
    assert!(info.has_update);
    assert_eq!(info.download_url, "https://example.com/release");
}

#[test]
fn update_info_detects_same_version() {
    let release = serde_json::json!({
        "tag_name": "v1.2.0",
        "published_at": null,
        "body": "",
        "html_url": "https://example.com/release",
        "assets": []
    });

    let info = build_update_info_from_release(&release, "1.2.0");
    assert!(!info.has_update);
    assert_eq!(info.release_notes, "No release notes.");
}
