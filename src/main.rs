mod api;
mod config;
mod aria2;
mod scanner;
mod state;
mod teldrive;

use axum::http::header;
use axum::response::Html;
use axum::routing::{get, post};
use axum::Router;
use tower_http::cors::CorsLayer;
use tracing::info;

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

    info!("TelSync 正在启动...");

    let config = config::AppConfig::load();
    info!("配置加载完成");

    // Aria2 的预设交互端口为 16800
    let rpc_port = 16800;
    
    // 如果存在本地 aria2，则启动它作为子进程（如果不存在，前台页面引导用户下载）
    if aria2::check_aria2_exists() {
        let _ = aria2::spawn_aria2(
            &config.local_path,
            rpc_port,
            config.max_concurrent_downloads,
            &config.proxy_url,
            &config.proxy_user,
            &config.proxy_passwd,
            config.rpc_allow_remote,
            &config.rpc_secret,
        );
    } else {
        info!("未检测到 Aria2 核心，需要进入配置向导");
    }

    let app_state = state::AppState::new(config, rpc_port);

    // 构建路由
    let app = Router::new()
        // 静态文件
        .route("/", get(serve_html))
        .route("/style.css", get(serve_css))
        .route("/app.js", get(serve_js))
        // API 路由
        .route("/api/config", get(api::get_config).post(api::save_config))
        .route("/api/test-connection", post(api::test_connection))
        .route("/api/trees", get(api::get_trees))
        .route("/api/trees/refresh", post(api::refresh_trees))
        .route("/api/download/enqueue", post(api::enqueue_download))
        .route("/api/download/delete", post(api::delete_local_file))
        .route("/api/download/status", get(api::download_status))
        .route("/api/download/cancel", post(api::cancel_download))
        .route("/api/download/retry", post(api::retry_download))
        .route("/api/download/pause-all", post(api::pause_all))
        .route("/api/download/resume-all", post(api::resume_all))

        .route("/api/download/clear-failed", post(api::clear_failed))
        .route("/api/download/clear-all", post(api::clear_all))
        .route("/api/system/init-status", get(api::init_status))
        .route("/api/system/install-aria2", post(api::install_aria2))
        .route("/api/system/install-progress", get(api::install_progress))
        .route("/api/system/upload-aria2", post(api::upload_aria2))
        .layer(CorsLayer::permissive())
        .with_state(app_state.clone());

    let port = 5300;
    let addr = format!("0.0.0.0:{}", port);
    info!("TelSync 已启动: http://localhost:{}", port);

    // 自动打开浏览器
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
