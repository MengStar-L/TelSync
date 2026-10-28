use crate::api::{
    build_update_info_from_release, cleanup_download_artifacts, cleanup_empty_parent_dirs,
    collect_incomplete_task_file_paths, replace_executable_with_update, resolve_local_target,
    update_artifact_paths, tree_relative_path, download_directory, unprotected_task_file_paths,
    ensure_resumable_target,
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
fn tree_virtual_paths_resolve_without_allowing_root_or_traversal() {
    let root = temp_test_dir("tree-path");
    fs::write(root.join("name with spaces.txt"), b"keep").unwrap();
    let relative = tree_relative_path("/name with spaces.txt").unwrap();
    assert!(resolve_local_target(&root, &relative).unwrap().is_file());
    for invalid in ["/", "//server/share", "/../outside", "/a/../../outside"] {
        assert!(tree_relative_path(invalid).is_err(), "{invalid}");
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn download_destination_creates_nested_dirs_and_rejects_traversal() {
    let root = temp_test_dir("download-dir");
    let destination = download_directory(&root, "a/b/file.txt").unwrap();
    assert_eq!(destination, fs::canonicalize(root.join("a/b")).unwrap());
    assert!(download_directory(&root, "../outside.txt").is_err());
    assert!(download_directory(&root, "/absolute.txt").is_err());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn download_conflict_checks_require_a_real_control_file() {
    let root = temp_test_dir("download-conflict");
    let target = root.join("file.bin");
    assert!(ensure_resumable_target(&target).is_ok());
    fs::write(&target, b"").unwrap();
    assert!(ensure_resumable_target(&target).is_ok());
    fs::write(&target, b"existing local content").unwrap();
    assert!(ensure_resumable_target(&target).is_err());
    fs::write(root.join("file.bin.aria2__temp"), b"temporary control").unwrap();
    assert!(ensure_resumable_target(&target).is_err());
    let control = root.join("file.bin.aria2");
    fs::create_dir(&control).unwrap();
    assert!(ensure_resumable_target(&target).is_err());
    fs::remove_dir(&control).unwrap();
    fs::write(&control, b"control file").unwrap();
    assert!(ensure_resumable_target(&target).is_ok());
    assert_eq!(fs::read(target).unwrap(), b"existing local content");
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn download_conflict_preflight_protects_batch_and_retry() {
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    use crate::state::FileNode;
    let root = temp_test_dir("download-preflight");
    let folder = root.join("folder");
    fs::create_dir(&folder).unwrap();
    let conflict = folder.join("conflict.bin");
    fs::write(&conflict, b"user file").unwrap();
    let task = serde_json::json!({"gid":"old", "status":"error", "dir":folder.to_string_lossy(),
        "files":[{"path":conflict.to_string_lossy()}]});
    let additions = Arc::new(AtomicUsize::new(0));
    let calls = additions.clone();
    let app = axum::Router::new().route("/jsonrpc", axum::routing::post(move |axum::Json(body): axum::Json<serde_json::Value>| {
        let task = task.clone();
        let calls = calls.clone();
        async move {
            let result = match body["method"].as_str().unwrap() {
                "aria2.tellStatus" => task.clone(),
                "aria2.tellStopped" => serde_json::json!([task]),
                "aria2.tellActive" | "aria2.tellWaiting" => serde_json::json!([]),
                "aria2.addUri" => { calls.fetch_add(1, Ordering::SeqCst); serde_json::json!("new-gid") },
                _ => serde_json::json!("OK"),
            };
            axum::Json(serde_json::json!({"jsonrpc":"2.0", "id":"telsync", "result":result}))
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let config = crate::config::AppConfig {
        teldrive_url: "https://current.example".into(), access_token: "test-token".into(),
        local_path: root.to_string_lossy().to_string(), ..Default::default()
    };
    let state = crate::state::AppState::new(config, port);
    let file = |name: &str| FileNode {
        name: name.into(), path: format!("/folder/{name}"), is_dir: false, size: 100,
        remote_id: Some(name.into()), mime_type: None, exists_locally: false, children: vec![],
    };
    *state.remote_tree.write().await = Some(vec![FileNode {
        name: "folder".into(), path: "/folder".into(), is_dir: true, size: 0,
        remote_id: Some("folder-id".into()), mime_type: None, exists_locally: false,
        // flatten_files processes the last child first: a safe candidate precedes the conflict.
        children: vec![file("conflict.bin"), file("safe.bin")],
    }]);
    let result = crate::api::enqueue_download(axum::extract::State(state.clone()), axum::Json(crate::api::EnqueueRequest {path:"/folder".into()})).await;
    let Err((_, error)) = result else { panic!("同名冲突必须拒绝整批入队"); };
    assert!(error.message.as_deref().unwrap().contains("同名文件冲突"));
    assert_eq!(additions.load(Ordering::SeqCst), 0);
    let result = crate::api::retry_download(axum::extract::State(state), axum::Json(crate::api::TaskAction {task_id:"old".into()})).await;
    let Err((_, error)) = result else { panic!("重试不能拼接用户已有文件"); };
    assert!(error.message.as_deref().unwrap().contains("同名文件冲突"));
    assert_eq!(additions.load(Ordering::SeqCst), 0);
    assert_eq!(fs::read(conflict).unwrap(), b"user file");
    server.abort();
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn old_failed_task_cannot_clean_a_new_active_or_completed_file() {
    let failed = serde_json::json!({"gid":"old", "status":"error", "files":[{"path":"same.bin"}]});
    for status in ["active", "waiting", "paused", "complete"] {
        let other = serde_json::json!({"gid":"new", "status":status, "files":[{"path":"same.bin"}]});
        assert!(unprotected_task_file_paths(&failed, &[failed.clone(), other]).is_empty());
    }
    let complete = serde_json::json!({"gid":"done", "status":"complete", "files":[{"path":"done.bin"}]});
    assert!(unprotected_task_file_paths(&complete, &[]).is_empty());
    assert_eq!(unprotected_task_file_paths(&failed, &[failed.clone()]), vec![PathBuf::from("same.bin")]);
}

async fn mock_rpc(task: serde_json::Value, reject: bool) -> (std::sync::Arc<crate::state::AppState>, tokio::task::JoinHandle<()>) {
    use axum::{extract::State, Json, Router, routing::post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = std::sync::Arc::new(task);
    let app = Router::new().route("/jsonrpc", post(move |State(task): State<std::sync::Arc<serde_json::Value>>, Json(body): Json<serde_json::Value>| async move {
        if reject {
            return Json(serde_json::json!({"jsonrpc":"2.0", "id":"telsync", "error":{"code":1,"message":"mock rejected"}}));
        }
        let result = match body["method"].as_str().unwrap() {
            "aria2.tellStatus" => (*task).clone(),
            "aria2.tellActive" | "aria2.tellWaiting" => serde_json::json!([]),
            "aria2.tellStopped" => serde_json::json!([(*task).clone()]),
            _ => serde_json::json!("OK"),
        };
        Json(serde_json::json!({"jsonrpc":"2.0", "id":"telsync", "result":result}))
    })).with_state(task);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let state = crate::state::AppState::new(crate::config::AppConfig::default(), port);
    (state, server)
}

#[tokio::test]
async fn rpc_errors_are_reported_by_status_and_actions() {
    let (state, server) = mock_rpc(serde_json::json!({}), true).await;
    assert!(state.aria2_client.tell_all().await.is_err());
    assert!(state.aria2_client.force_remove("gid").await.is_err());
    assert!(state.aria2_client.remove_download_result("gid").await.is_err());
    assert!(state.aria2_client.purge_download_result().await.is_err());
    assert!(crate::api::pause_all(axum::extract::State(state.clone())).await.is_err());
    assert!(crate::api::resume_all(axum::extract::State(state.clone())).await.is_err());
    assert!(crate::api::download_status(axum::extract::State(state)).await.is_err());
    server.abort();
}

#[tokio::test]
async fn polling_failed_download_keeps_partial_data_and_completed_cancel_is_rejected() {
    let root = temp_test_dir("read-only-status");
    let path = root.join("file.bin");
    fs::write(&path, b"preserve").unwrap();
    for status in ["error", "complete"] {
        let task = serde_json::json!({"gid":"task", "status":status, "dir":root.to_string_lossy(), "files":[{"path":path.to_string_lossy()}]});
        let (state, server) = mock_rpc(task, false).await;
        state.config.write().await.local_path = root.to_string_lossy().to_string();
        assert!(crate::api::download_status(axum::extract::State(state.clone())).await.is_ok());
        if status == "complete" {
            assert!(crate::api::cancel_download(axum::extract::State(state), axum::Json(crate::api::TaskAction {task_id:"task".into()})).await.is_err());
        }
        assert_eq!(fs::read(&path).unwrap(), b"preserve");
        server.abort();
    }
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn invalid_config_update_does_not_change_in_memory_configuration() {
    let state = crate::state::AppState::new(crate::config::AppConfig::default(), 1);
    let update = serde_json::from_value(serde_json::json!({"teldrive_url":"https://changed.example", "local_path":"/changed", "proxy_url":"invalid"})).unwrap();
    assert!(crate::api::save_config(axum::extract::State(state.clone()), axum::Json(update)).await.is_err());
    let config = state.config.read().await;
    assert!(config.teldrive_url.is_empty());
    assert!(config.local_path.is_empty());
}

#[tokio::test]
async fn setup_connection_test_does_not_require_a_local_directory() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let app = axum::Router::new().route("/api/auth/session", axum::routing::get(|| async { axum::Json(serde_json::json!({"userId":123456})) }));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let mut config = crate::config::AppConfig::default();
    config.teldrive_url = format!("http://127.0.0.1:{port}");
    config.access_token = "mock-token".into();
    let state = crate::state::AppState::new(config, 1);
    assert!(crate::api::test_connection(axum::extract::State(state)).await.is_ok());
    server.abort();
}

#[tokio::test]
async fn rpc_changes_are_rejected_before_saving_when_downloads_are_unfinished() {
    if !crate::aria2::check_aria2_exists() { return; }
    for status in ["active", "waiting", "paused"] {
        let (state, server) = mock_rpc(serde_json::json!({"gid":"task", "status":status}), false).await;
        let update = serde_json::from_value(serde_json::json!({"rpc_secret":"new-secret"})).unwrap();
        let result = crate::api::save_config(axum::extract::State(state.clone()), axum::Json(update)).await;
        assert!(result.is_err());
        assert!(state.config.read().await.rpc_secret.is_empty());
        server.abort();
    }
}

#[tokio::test]
async fn retry_does_not_use_a_url_from_a_previous_server() {
    let root = temp_test_dir("retry-server");
    let path = root.join("file.bin");
    fs::write(&path, b"partial").unwrap();
    let task = serde_json::json!({"gid":"task", "status":"error", "dir":root.to_string_lossy(),
        "files":[{"path":path.to_string_lossy(), "uris":[{"uri":"https://old.example/api/files/old/download?ts_path=%2Ffile.bin"}]}]});
    let (state, server) = mock_rpc(task, false).await;
    {
        let mut config = state.config.write().await;
        config.teldrive_url = "https://new.example".into();
        config.access_token = "new-token".into();
        config.local_path = root.to_string_lossy().to_string();
    }
    *state.remote_tree.write().await = Some(vec![]);
    assert!(crate::api::retry_download(axum::extract::State(state), axum::Json(crate::api::TaskAction {task_id:"task".into()})).await.is_err());
    assert_eq!(fs::read(path).unwrap(), b"partial");
    server.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn deleting_a_directory_with_an_unfinished_download_is_rejected() {
    if !crate::aria2::check_aria2_exists() { return; }
    let root = temp_test_dir("delete-running");
    fs::create_dir(root.join("folder")).unwrap();
    let path = root.join("folder/file.bin");
    fs::write(&path, b"partial").unwrap();
    let task = serde_json::json!({"gid":"task", "status":"active", "files":[{"path":path.to_string_lossy()}]});
    let (state, server) = mock_rpc(task, false).await;
    state.config.write().await.local_path = root.to_string_lossy().to_string();
    assert!(crate::api::delete_local_file(axum::extract::State(state), axum::Json(crate::api::DeleteFileRequest {path:"/folder".into()})).await.is_err());
    assert_eq!(fs::read(path).unwrap(), b"partial");
    server.abort();
    fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn invalid_local_directory_is_rejected_before_configuration_is_saved() {
    let root = temp_test_dir("config-dir");
    let path = root.join("file.bin");
    fs::write(&path, b"preserve").unwrap();
    let state = crate::state::AppState::new(crate::config::AppConfig::default(), 1);
    let update = serde_json::from_value(serde_json::json!({"local_path":path.to_string_lossy()})).unwrap();
    assert!(crate::api::save_config(axum::extract::State(state.clone()), axum::Json(update)).await.is_err());
    assert!(state.config.read().await.local_path.is_empty());
    fs::remove_dir_all(root).unwrap();
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
