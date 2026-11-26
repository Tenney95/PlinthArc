use crate::sd_cli::{self, Generation};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as RoutePath, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use rusqlite::{Connection, OptionalExtension, Row, params, types::Type};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio_util::io::ReaderStream;
use tower_http::services::ServeDir;
use uuid::Uuid;

pub const DEFAULT_PORT: u16 = 47361;

pub struct ServerConfig {
    pub data_dir: PathBuf,
    pub ui_dir: PathBuf,
    pub engine: Option<PathBuf>,
    pub port: u16,
}

pub struct LocalServer {
    listener: TcpListener,
    origin: String,
    app: Router,
}

pub fn default_data_dir() -> Result<PathBuf> {
    Ok(dirs::data_local_dir()
        .context("could not locate your local application data directory")?
        .join("PlinthArc"))
}

impl LocalServer {
    pub fn bind(config: ServerConfig) -> Result<Self> {
        let ui_dir = config.ui_dir.canonicalize().with_context(|| {
            format!(
                "build the Arc interface before starting the server ({})",
                config.ui_dir.display()
            )
        })?;
        ensure!(
            ui_dir.join("index.html").is_file(),
            "Arc build is missing index.html"
        );
        let engine = config
            .engine
            .map(|path| {
                let engine = path.canonicalize().with_context(|| {
                    format!("could not open configured sd-cli at {}", path.display())
                })?;
                ensure!(engine.is_file(), "the configured sd-cli must be a file");
                Ok(engine)
            })
            .transpose()?;

        fs::create_dir_all(&config.data_dir)?;
        let owner = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(config.data_dir.join("owner.lock"))?;
        owner
            .try_lock()
            .context("this PlinthArc data directory is already in use")?;
        let database = Connection::open(config.data_dir.join("arc.sqlite3"))?;
        database.execute_batch(
            "
            PRAGMA journal_mode = DELETE;
            PRAGMA synchronous = EXTRA;
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS settings (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                body TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                submission_key TEXT NOT NULL UNIQUE,
                request TEXT NOT NULL,
                status TEXT NOT NULL,
                error TEXT,
                report TEXT,
                image TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            );
            UPDATE runs SET status = 'interrupted', error = 'Service stopped during generation'
                WHERE status = 'running';
        ",
        )?;

        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, config.port))
            .context("cannot bind the local Arc server")?;
        listener.set_nonblocking(true)?;
        let host = listener.local_addr()?.to_string();
        let origin = format!("http://{host}");
        let state = Arc::new(Core {
            database: Mutex::new(database),
            engine,
            _owner: owner,
        });
        let api = Router::new()
            .route("/settings", get(get_settings).put(put_settings))
            .route("/runs", get(list_runs).post(start_run))
            .route("/runs/{id}", get(get_run))
            .route("/runs/{id}/image", get(get_image))
            .fallback(api_not_found)
            .layer(DefaultBodyLimit::max(64 * 1024))
            .with_state(state);
        let app = Router::new()
            .nest("/api/v1", api)
            .fallback_service(ServeDir::new(ui_dir))
            .layer(middleware::from_fn_with_state(
                (host, origin.clone()),
                local_origin,
            ));
        Ok(Self {
            listener,
            origin,
            app,
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub async fn run(self) -> Result<()> {
        axum::serve(tokio::net::TcpListener::from_std(self.listener)?, self.app).await?;
        Ok(())
    }
}

async fn local_origin(
    State((host, origin)): State<(String, String)>,
    request: Request,
    next: Next,
) -> Response {
    let headers = request.headers();
    if headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        != Some(host.as_str())
    {
        return AppError::new(StatusCode::MISDIRECTED_REQUEST, "Use the local Arc URL")
            .into_response();
    }
    let read_only = matches!(*request.method(), Method::GET | Method::HEAD);
    let api = request.uri().path().starts_with("/api/v1/");
    let cross_site = headers
        .get("sec-fetch-site")
        .is_some_and(|value| value == "cross-site");
    if (api && cross_site)
        || (!read_only
            && headers
                .get(header::ORIGIN)
                .and_then(|value| value.to_str().ok())
                != Some(origin.as_str()))
    {
        return AppError::new(
            StatusCode::FORBIDDEN,
            "The request must come from this Arc page",
        )
        .into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost https://ipc.localhost; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ));
    response
}

struct Core {
    database: Mutex<Connection>,
    engine: Option<PathBuf>,
    _owner: File,
}

#[derive(Deserialize, Serialize)]
struct Settings {
    model_dir: String,
    output_dir: String,
    backend: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            model_dir: String::new(),
            output_dir: String::new(),
            backend: if cfg!(target_os = "macos") {
                "MTL0"
            } else {
                "CUDA0"
            }
            .to_owned(),
        }
    }
}

#[derive(Serialize)]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    engine: String,
    model_ready: bool,
    engine_ready: bool,
}

fn load_settings(database: &Connection) -> Result<Settings> {
    let saved: Option<String> = database
        .query_row("SELECT body FROM settings WHERE singleton = 1", [], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(saved
        .as_deref()
        .map(serde_json::from_str)
        .transpose()?
        .unwrap_or_default())
}

fn directory(value: &str, label: &str) -> Result<String> {
    if value.is_empty() {
        return Ok(String::new());
    }
    let path = Path::new(value);
    ensure!(
        path.is_absolute(),
        "{label} must be an absolute path on the machine running Arc"
    );
    let path = path
        .canonicalize()
        .with_context(|| format!("{label} does not exist"))?;
    ensure!(path.is_dir(), "{label} must be an existing directory");
    Ok(path
        .to_str()
        .context("directory path must be UTF-8")?
        .to_owned())
}

fn has_manifest(directory: &str) -> bool {
    !directory.is_empty()
        && Path::new(directory)
            .join("model.json")
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_file())
}

fn settings_view(core: &Core, settings: Settings) -> SettingsView {
    SettingsView {
        model_ready: has_manifest(&settings.model_dir),
        engine_ready: core.engine.as_deref().is_some_and(Path::is_file),
        engine: core
            .engine
            .as_deref()
            .map_or_else(String::new, |path| path.display().to_string()),
        settings,
    }
}

async fn get_settings(State(core): State<Arc<Core>>) -> ApiResult<Json<SettingsView>> {
    let settings = {
        let database = lock(&core)?;
        load_settings(&database)?
    };
    Ok(Json(settings_view(&core, settings)))
}

async fn put_settings(
    State(core): State<Arc<Core>>,
    Json(mut settings): Json<Settings>,
) -> ApiResult<Json<SettingsView>> {
    settings.model_dir =
        directory(&settings.model_dir, "Model directory").map_err(AppError::bad)?;
    settings.output_dir =
        directory(&settings.output_dir, "Output directory").map_err(AppError::bad)?;
    settings.backend = settings.backend.trim().to_owned();
    if settings.backend.is_empty()
        || settings.backend.len() > 40
        || !settings
            .backend
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(AppError::bad(
            "Enter one device name shown by sd-cli --list-devices",
        ));
    }
    if !settings.output_dir.is_empty() {
        tempfile::NamedTempFile::new_in(&settings.output_dir)
            .map_err(|error| AppError::bad(format!("Output directory is not writable: {error}")))?;
    }
    let body = serde_json::to_string(&settings).map_err(anyhow::Error::from)?;
    lock(&core)?.execute(
        "INSERT INTO settings (singleton, body) VALUES (1, ?1)
         ON CONFLICT (singleton) DO UPDATE SET body = excluded.body",
        [body],
    )?;
    Ok(Json(settings_view(&core, settings)))
}

#[derive(Clone, Deserialize, Serialize)]
struct RunRequest {
    #[serde(flatten)]
    generation: Generation,
    #[serde(default)]
    offload_to_cpu: bool,
}

#[derive(Serialize)]
struct Run {
    id: String,
    status: String,
    request: RunRequest,
    error: Option<String>,
    report: Option<Value>,
    created_at: i64,
}

const RUN_FIELDS: &str = "id, status, request, error, report, created_at";

fn run_from_row(row: &Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        id: row.get(0)?,
        status: row.get(1)?,
        request: decode_json(&row.get::<_, String>(2)?, 2)?,
        error: row.get(3)?,
        report: row
            .get::<_, Option<String>>(4)?
            .as_deref()
            .map(|json| decode_json(json, 4))
            .transpose()?,
        created_at: row.get(5)?,
    })
}

fn decode_json<T: serde::de::DeserializeOwned>(json: &str, index: usize) -> rusqlite::Result<T> {
    serde_json::from_str(json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

async fn list_runs(State(core): State<Arc<Core>>) -> ApiResult<Json<Vec<Run>>> {
    let database = lock(&core)?;
    let mut statement = database.prepare(&format!(
        "SELECT {RUN_FIELDS} FROM runs ORDER BY rowid DESC LIMIT 100"
    ))?;
    Ok(Json(
        statement
            .query_map([], run_from_row)?
            .collect::<rusqlite::Result<_>>()?,
    ))
}

async fn get_run(
    State(core): State<Arc<Core>>,
    RoutePath(id): RoutePath<String>,
) -> ApiResult<Json<Run>> {
    let database = lock(&core)?;
    let run = database
        .query_row(
            &format!("SELECT {RUN_FIELDS} FROM runs WHERE id = ?1"),
            [id],
            run_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::missing("Run not found"))?;
    Ok(Json(run))
}

async fn start_run(
    State(core): State<Arc<Core>>,
    headers: HeaderMap,
    Json(request): Json<RunRequest>,
) -> ApiResult<(StatusCode, Json<Run>)> {
    let key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| Uuid::parse_str(value).is_ok())
        .ok_or_else(|| AppError::bad("A UUID Idempotency-Key is required"))?;
    let body = serde_json::to_string(&request).map_err(anyhow::Error::from)?;
    let database = lock(&core)?;
    if let Some((existing, run)) = database
        .query_row(
            &format!("SELECT {RUN_FIELDS}, request FROM runs WHERE submission_key = ?1"),
            [key],
            |row| Ok((row.get::<_, String>(6)?, run_from_row(row)?)),
        )
        .optional()?
    {
        if existing != body {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "Submission key already used with different parameters",
            ));
        }
        return Ok((StatusCode::OK, Json(run)));
    }
    request.generation.validate().map_err(AppError::bad)?;
    if database.query_row(
        "SELECT EXISTS(SELECT 1 FROM runs WHERE status = 'running')",
        [],
        |row| row.get::<_, bool>(0),
    )? {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "Another generation is already running",
        ));
    }
    let engine = core.engine.clone().ok_or_else(|| {
        AppError::bad("Set PLINTHARC_ENGINE or start the web service with --engine")
    })?;
    let settings = load_settings(&database)?;
    if !has_manifest(&settings.model_dir) || settings.output_dir.is_empty() {
        return Err(AppError::bad(
            "Set an output directory and a model directory containing model.json",
        ));
    }
    let output_dir = directory(&settings.output_dir, "Output directory").map_err(AppError::bad)?;
    let model_dir = directory(&settings.model_dir, "Model directory").map_err(AppError::bad)?;
    if output_dir != settings.output_dir || model_dir != settings.model_dir {
        return Err(AppError::bad(
            "A configured directory has moved. Save its current path in Settings",
        ));
    }
    let id = Uuid::new_v4().to_string();
    let output = Path::new(&output_dir).join(format!("plintharc-{id}.png"));
    let manifest = Path::new(&model_dir).join("model.json");
    let output_path = output
        .to_str()
        .ok_or_else(|| AppError::bad("Output path must be UTF-8"))?;
    let run = database.query_row(
        &format!(
            "INSERT INTO runs (id, submission_key, request, status, image)
         VALUES (?1, ?2, ?3, 'running', ?4) RETURNING {RUN_FIELDS}"
        ),
        params![id, key, body, output_path],
        run_from_row,
    )?;
    drop(database);

    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking(move || {
            sd_cli::generate(
                &manifest,
                &engine,
                &settings.backend,
                request.offload_to_cpu,
                &output,
                request.generation,
            )
        })
        .await;
        let completed = match result {
            Ok(Ok(report)) => {
                serde_json::to_string(&report).context("could not serialize the run report")
            }
            Ok(Err(error)) => Err(error),
            Err(error) => Err(error).context("generation worker stopped unexpectedly"),
        };
        if let Err(error) = finish_run(&core, &id, completed) {
            eprintln!("Could not record result for {id}: {error}");
        }
    });
    Ok((StatusCode::ACCEPTED, Json(run)))
}

fn finish_run(core: &Core, id: &str, result: Result<String>) -> ApiResult<()> {
    let database = lock(core)?;
    match result {
        Ok(report) => database.execute(
            "UPDATE runs SET status = 'succeeded', report = ?2 WHERE id = ?1",
            params![id, report],
        ),
        Err(error) => database.execute(
            "UPDATE runs SET status = 'failed', error = ?2 WHERE id = ?1",
            params![id, format!("{error:#}")],
        ),
    }?;
    Ok(())
}

async fn get_image(
    State(core): State<Arc<Core>>,
    RoutePath(id): RoutePath<String>,
) -> ApiResult<Response> {
    let (path, report): (String, String) = {
        let database = lock(&core)?;
        database
            .query_row(
                "SELECT image, report FROM runs WHERE id = ?1 AND status = 'succeeded'",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| AppError::missing("Image not found"))?
    };
    let report: Value = serde_json::from_str(&report).map_err(anyhow::Error::from)?;
    let expected_size = report
        .get("output_bytes")
        .and_then(Value::as_u64)
        .ok_or_else(|| AppError::missing("Image receipt is missing"))?;
    let path = PathBuf::from(path);
    if tokio::fs::canonicalize(&path).await.ok().as_ref() != Some(&path) {
        return Err(AppError::missing("Image has moved or is unavailable"));
    }
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| AppError::missing("Image is unavailable"))?;
    let metadata = file
        .metadata()
        .await
        .map_err(|_| AppError::missing("Image is unavailable"))?;
    if !metadata.is_file() || metadata.len() != expected_size {
        return Err(AppError::missing("Image has changed or is unavailable"));
    }
    Ok((
        [
            (header::CONTENT_TYPE, "image/png".to_owned()),
            (header::CONTENT_LENGTH, expected_size.to_string()),
        ],
        Body::from_stream(ReaderStream::new(file)),
    )
        .into_response())
}

async fn api_not_found() -> AppError {
    AppError::missing("API route not found")
}

fn lock(core: &Core) -> ApiResult<std::sync::MutexGuard<'_, Connection>> {
    core.database.lock().map_err(|_| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The Arc store is unavailable",
        )
    })
}

type ApiResult<T> = std::result::Result<T, AppError>;

struct AppError(StatusCode, String);

impl AppError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self(status, message.into())
    }
    fn bad(error: impl std::fmt::Display) -> Self {
        Self::new(StatusCode::BAD_REQUEST, error.to_string())
    }
    fn missing(message: &'static str) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.1)
    }
}

impl From<anyhow::Error> for AppError {
    fn from(error: anyhow::Error) -> Self {
        eprintln!("Arc store error: {error}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The Arc store could not complete the request",
        )
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        anyhow::Error::from(error).into()
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        (self.0, Json(serde_json::json!({ "error": self.1 }))).into_response()
    }
}
