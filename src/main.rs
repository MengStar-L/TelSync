mod api;
mod aria2;
mod config;
mod scanner;
mod state;
mod teldrive;
mod tree_cache;
mod tree_sync;
#[cfg(test)]
mod api_tests;

use axum::http::header;
use axum::response::Html;
use axum::routing::{get, post};
use axum::Router;
use std::time::Duration;
use tracing::{info, warn};

const STATIC_HTML: &str = include_str!("../static/index.html");
const STATIC_CSS: &str = include_str!("../static/style.css");
const STATIC_JS: &str = include_str!("../static/app.js");

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "telsync=info".parse().unwrap()),
        )
        .init();

    info!("TelSync starting...");

    let config = config::AppConfig::load();
    info!("Configuration loaded");

    let rpc_port = 16800;

    if aria2::check_aria2_exists() {
        let _ = aria2::spawn_aria2(aria2::SpawnAria2Options {
            local_dir: &config.local_path,
            port: rpc_port,
            max_concurrent: config.max_concurrent_downloads,
            proxy_url: &config.proxy_url,
            proxy_user: &config.proxy_user,
            proxy_passwd: &config.proxy_passwd,
            rpc_allow_remote: config.rpc_allow_remote,
            rpc_secret: &config.rpc_secret,
        });
    } else {
        info!("Aria2 binary not found, setup wizard will guide installation");
    }

    let app_state = state::AppState::new(config, rpc_port);
    let scheduled_refresh_state = app_state.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(5 * 60));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(e) = tree_sync::refresh_and_store(&scheduled_refresh_state, "scheduled").await {
                warn!("Background tree refresh failed: {}", e);
            }
        }
    });

    let mutating_api = Router::new()
        .route("/api/config", get(api::get_config).post(api::save_config))
        .route("/api/test-connection", post(api::test_connection))
        .route("/api/trees/initial", post(api::initial_trees))
        .route("/api/trees/refresh", post(api::refresh_trees))
        .route("/api/download/enqueue", post(api::enqueue_download))
        .route("/api/download/delete", post(api::delete_local_file))
        .route("/api/download/cancel", post(api::cancel_download))
        .route("/api/download/remove", post(api::remove_download))
        .route("/api/download/retry", post(api::retry_download))
        .route("/api/download/pause-all", post(api::pause_all))
        .route("/api/download/resume-all", post(api::resume_all))
        .route("/api/download/clear-failed", post(api::clear_failed))
        .route("/api/download/clear-all", post(api::clear_all))
        .route("/api/system/open-update-download", post(api::open_update_download))
        .route("/api/system/install-aria2", post(api::install_aria2))
        .route("/api/system/upload-aria2", post(api::upload_aria2));

    let app = Router::new()
        .route("/", get(serve_html))
        .route("/style.css", get(serve_css))
        .route("/app.js", get(serve_js))
        .route("/api/trees", get(api::get_trees))
        .route("/api/trees/events", get(api::tree_events))
        .route("/api/download/status", get(api::download_status))
        .route("/api/system/init-status", get(api::init_status))
        .route("/api/system/update-info", get(api::get_update_info))
        .route("/api/system/install-progress", get(api::install_progress))
        .merge(mutating_api)
        .with_state(app_state.clone());

    let port = 5300;
    let addr = format!("0.0.0.0:{}", port);
    info!("TelSync listening on http://0.0.0.0:{}", port);

    let _ = open::that(format!("http://localhost:{}", port));

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn serve_html() -> Html<&'static str> {
    Html(STATIC_HTML)
}

async fn serve_css() -> ([(header::HeaderName, &'static str); 1], &'static str) {
    ([(header::CONTENT_TYPE, "text/css")], STATIC_CSS)
}

async fn serve_js() -> ([(header::HeaderName, &'static str); 1], &'static str) {
    (
        [(header::CONTENT_TYPE, "application/javascript")],
        STATIC_JS,
    )
}
