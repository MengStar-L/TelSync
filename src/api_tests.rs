use crate::api::{
    build_update_info_from_release, cleanup_download_artifacts, cleanup_empty_parent_dirs,
    collect_incomplete_task_file_paths, replace_executable_with_update, resolve_local_target,
    update_artifact_paths,
};
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
fn cleanup_download_artifacts_removes_partial_file_and_sidecars() {
    let root = temp_test_dir("download-artifacts");
    let nested = root.join("a").join("b");
    fs::create_dir_all(&nested).unwrap();
    let file_path = nested.join("file.bin");
    fs::write(&file_path, b"partial").unwrap();
    fs::write(nested.join("file.bin.aria2"), b"state").unwrap();
    fs::write(nested.join("file.bin.aria2__temp"), b"temp").unwrap();

    cleanup_download_artifacts(&[file_path.clone()], &root);

    assert!(!file_path.exists());
    assert!(!nested.join("file.bin.aria2").exists());
    assert!(!nested.join("file.bin.aria2__temp").exists());
    assert!(root.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn cleanup_download_artifacts_removes_sidecars_when_target_missing() {
    let root = temp_test_dir("download-sidecars");
    let nested = root.join("a").join("b");
    fs::create_dir_all(&nested).unwrap();
    let file_path = nested.join("file.bin");
    fs::write(nested.join("file.bin.aria2"), b"state").unwrap();
    fs::write(nested.join("file.bin.aria2__temp"), b"temp").unwrap();

    cleanup_download_artifacts(&[file_path.clone()], &root);

    assert!(!nested.join("file.bin.aria2").exists());
    assert!(!nested.join("file.bin.aria2__temp").exists());
    assert!(root.exists());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn collect_incomplete_task_file_paths_skips_completed_tasks() {
    let root = temp_test_dir("task-paths");
    let completed = root.join("done.bin");
    let active = root.join("partial.bin");
    let failed = root.join("failed.bin");
    let tasks = vec![
        serde_json::json!({
            "status": "complete",
            "files": [{ "path": completed.to_string_lossy() }]
        }),
        serde_json::json!({
            "status": "active",
            "files": [{ "path": active.to_string_lossy() }]
        }),
        serde_json::json!({
            "status": "error",
            "files": [{ "path": failed.to_string_lossy() }]
        }),
    ];

    let paths = collect_incomplete_task_file_paths(&tasks);

    assert_eq!(paths, vec![active, failed]);

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn update_artifact_paths_use_executable_directory() {
    let root = temp_test_dir("update-paths");
    let exe_path = root.join("telsync");

    let (temp_path, backup_path) = update_artifact_paths(&exe_path).unwrap();

    assert_eq!(temp_path, root.join("telsync.update.tmp"));
    assert_eq!(backup_path, root.join("telsync.bak"));
    assert!(update_artifact_paths(&PathBuf::new()).is_err());

    fs::remove_dir_all(root).unwrap();
}

#[test]
fn replace_executable_with_update_keeps_backup() {
    let root = temp_test_dir("replace-update");
    let exe_path = root.join("telsync");
    let temp_path = root.join("telsync.update.tmp");
    let backup_path = root.join("telsync.bak");
    fs::write(&exe_path, b"old").unwrap();
    fs::write(&temp_path, b"new").unwrap();

    replace_executable_with_update(&exe_path, &temp_path, &backup_path).unwrap();

    assert_eq!(fs::read(&exe_path).unwrap(), b"new");
    assert_eq!(fs::read(&backup_path).unwrap(), b"old");
    assert!(!temp_path.exists());

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
    assert_eq!(info.release_notes, "暂无发布说明。");
}
