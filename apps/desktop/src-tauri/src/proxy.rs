use crate::connection::{
    clear_pending_pairing, connect_profile, forget_profile, load_pending_pairing, load_profile,
    parse_pairing_uri, pinned_http_client, pinned_tls_config, save_pending_pairing, save_profile,
    ImportedConnection, NetworkPreference, PendingPairing, ServerProfile,
};
use crate::ssh_install::{self, InstallServerRequest};
use axum::{
    body::{to_bytes, Body},
    extract::{
        ws::{Message as BrowserMessage, WebSocket, WebSocketUpgrade},
        FromRequestParts, Json, Request, State,
    },
    http::{
        header::{CONTENT_LENGTH, COOKIE, HOST, LOCATION, ORIGIN, REFERER, SET_COOKIE, UPGRADE},
        HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
    },
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Arc, time::SystemTime};
use tokio::{
    net::TcpListener,
    sync::{Mutex, RwLock},
};
use tokio_tungstenite::{
    connect_async_tls_with_config,
    tungstenite::{client::IntoClientRequest, Message as ServerMessage},
    Connector, MaybeTlsStream, WebSocketStream,
};

#[path = "preview_proxy.rs"]
mod preview_proxy;

const RETRYABLE_BODY_LIMIT: usize = 16 * 1024 * 1024;
const SERVER_SESSION_COOKIE: &str = "__Host-garden_session";
const LOCAL_SESSION_COOKIE: &str = "garden_native_session";
/*
 * What this program is, on the request side of the gateway.
 *
 * The shell already stamped `x-garden-native-client` on every *response* so the page could learn
 * it was talking through the gateway, and stamped nothing on the way out - so the box saw a plain
 * WKWebView/WebView2/WebKitGTK User-Agent and labelled the owner's desktop app "Safari on macOS",
 * byte-identical to their real Safari in the Devices list that is also the revoke-a-session
 * control. The platform is a build fact, not a runtime one, so it is a constant.
 */
#[cfg(target_os = "macos")]
const CLIENT_IDENTITY: &str = concat!("garden-macos/", env!("CARGO_PKG_VERSION"));
#[cfg(target_os = "windows")]
const CLIENT_IDENTITY: &str = concat!("garden-windows/", env!("CARGO_PKG_VERSION"));
#[cfg(target_os = "linux")]
const CLIENT_IDENTITY: &str = concat!("garden-linux/", env!("CARGO_PKG_VERSION"));
#[cfg(target_os = "ios")]
const CLIENT_IDENTITY: &str = concat!("garden-ios/", env!("CARGO_PKG_VERSION"));
#[cfg(target_os = "android")]
const CLIENT_IDENTITY: &str = concat!("garden-android/", env!("CARGO_PKG_VERSION"));
const CLIENT_HEADER: &str = "x-garden-client";

#[derive(Clone)]
struct ActiveServer {
    profile: ServerProfile,
    http: reqwest::Client,
    websocket_tls: Arc<rustls::ClientConfig>,
}

pub struct ClientState {
    profile_path: PathBuf,
    pending_pairing_path: PathBuf,
    profile: RwLock<Option<ServerProfile>>,
    active: RwLock<Option<ActiveServer>>,
    activation: Mutex<()>,
    pairing_code: RwLock<Option<PendingPairing>>,
    local_origin: RwLock<String>,
    installer_origin: RwLock<String>,
    preview: preview_proxy::PreviewState,
    /*
     * Why the connection last failed, for the owner rather than for stderr.
     *
     * `ClientStatus` shipped with an `error` field that no code path could ever set, so the one
     * route that can tell a packaged owner why their app cannot reach their box answered `null`
     * every time. The activation attempt is the only place that knows, so it records here.
     */
    last_error: RwLock<Option<String>>,
}

impl ClientState {
    pub async fn authorization_browser_url(self: &Arc<Self>, raw: &str) -> Result<String, String> {
        let active = self.current().await?;
        checked_authorization_browser_url(raw, &active.profile.endpoints)
    }
    pub async fn preview_browser_url(self: &Arc<Self>, raw: &str) -> Result<String, String> {
        let active = self.current().await?;
        let preview = preview_proxy::connection(self, &active).await;
        checked_preview_browser_url(
            raw,
            canonical_origin(&active),
            preview
                .as_ref()
                .map(|connection| connection.remote.origin().ascii_serialization())
                .as_deref(),
        )
    }

    pub fn load(profile_path: PathBuf, pending_pairing_path: PathBuf) -> Result<Arc<Self>, String> {
        let profile = load_profile(&profile_path)?;
        let pairing_code = load_pending_pairing(&pending_pairing_path, SystemTime::now())?;
        Ok(Arc::new(Self {
            profile_path,
            pending_pairing_path,
            profile: RwLock::new(profile),
            active: RwLock::new(None),
            activation: Mutex::new(()),
            pairing_code: RwLock::new(pairing_code),
            local_origin: RwLock::new(String::new()),
            installer_origin: RwLock::new(String::new()),
            preview: preview_proxy::PreviewState::default(),
            last_error: RwLock::new(None),
        }))
    }

    async fn activate(self: &Arc<Self>, profile: ServerProfile) -> Result<ActiveServer, String> {
        let refreshed = connect_profile(&profile).await?;
        let http = pinned_http_client(&refreshed.identity, None)?;
        let mut websocket_tls = pinned_tls_config(&refreshed.identity)?;
        websocket_tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        let active = ActiveServer {
            profile: refreshed.clone(),
            http,
            websocket_tls: Arc::new(websocket_tls),
        };
        let profile_path = self.profile_path.clone();
        let to_save = refreshed.clone();
        tokio::task::spawn_blocking(move || save_profile(&profile_path, &to_save))
            .await
            .map_err(|_| "The client profile writer stopped unexpectedly")??;
        *self.profile.write().await = Some(refreshed);
        *self.active.write().await = Some(active.clone());
        Ok(active)
    }

    async fn current(self: &Arc<Self>) -> Result<ActiveServer, String> {
        if let Some(active) = self.active.read().await.clone() {
            return Ok(active);
        }
        let _activation = self.activation.lock().await;
        if let Some(active) = self.active.read().await.clone() {
            return Ok(active);
        }
        let profile = self
            .profile
            .read()
            .await
            .clone()
            .ok_or("Paste the one-time connection ticket from your garden server")?;
        match self.activate(profile).await {
            Ok(active) => {
                *self.last_error.write().await = None;
                Ok(active)
            }
            Err(message) => {
                *self.last_error.write().await = Some(message.clone());
                Err(message)
            }
        }
    }

    async fn import(self: &Arc<Self>, raw: &str) -> Result<(), String> {
        let ImportedConnection {
            profile,
            pairing_code,
            pairing_expires_at,
        } = parse_pairing_uri(raw, SystemTime::now())?;
        let _activation = self.activation.lock().await;
        self.activate(profile).await?;
        let path = self.pending_pairing_path.clone();
        let pending = tokio::task::spawn_blocking(move || {
            save_pending_pairing(&path, pairing_code, pairing_expires_at)
        })
        .await
        .map_err(|_| "The pending pairing-code writer stopped unexpectedly")??;
        *self.pairing_code.write().await = Some(pending);
        Ok(())
    }

    async fn clear_pairing_code(&self) -> Result<(), String> {
        let path = self.pending_pairing_path.clone();
        tokio::task::spawn_blocking(move || clear_pending_pairing(&path))
            .await
            .map_err(|_| "The pending pairing-code remover stopped unexpectedly")??;
        *self.pairing_code.write().await = None;
        Ok(())
    }

    /*
     * Disconnect this device from its server.
     *
     * `import` could replace a profile and nothing could remove one: pairing is reachable only from
     * the offline page, and the offline page renders only when the connection is already broken. So
     * moving the app to another box, or signing the app out of one, meant breaking the connection
     * first or hand-deleting server-profile.json. The pending pairing code goes with it - it is the
     * registration secret for the box being forgotten, and keeping it on disk after the owner has
     * said "not this server" is the one thing that would be worse than not having this at all.
     */
    async fn forget(self: &Arc<Self>) -> Result<(), String> {
        let _activation = self.activation.lock().await;
        let profile_path = self.profile_path.clone();
        tokio::task::spawn_blocking(move || forget_profile(&profile_path))
            .await
            .map_err(|_| "The client profile remover stopped unexpectedly")??;
        *self.profile.write().await = None;
        *self.active.write().await = None;
        *self.last_error.write().await = None;
        drop(_activation);
        self.clear_pairing_code().await
    }

    pub async fn import_deep_link(self: &Arc<Self>, raw: &str) -> Result<(), String> {
        self.import(raw).await
    }

    pub async fn local_origin(&self) -> String {
        self.local_origin.read().await.clone()
    }

    async fn installer_origin(&self) -> String {
        self.installer_origin.read().await.clone()
    }

    async fn invalidate(&self) {
        *self.active.write().await = None;
    }

    async fn set_network_preference(
        self: &Arc<Self>,
        preference: NetworkPreference,
    ) -> Result<(), String> {
        let mut profile_guard = self.profile.write().await;
        let Some(profile) = profile_guard.as_mut() else {
            return Err("Connect an garden server before saving network preferences".into());
        };
        profile.network_preference = preference;
        let profile_path = self.profile_path.clone();
        let to_save = profile.clone();
        tokio::task::spawn_blocking(move || save_profile(&profile_path, &to_save))
            .await
            .map_err(|_| "The client profile writer stopped unexpectedly")??;
        drop(profile_guard);
        if let Some(active) = self.active.write().await.as_mut() {
            active.profile.network_preference = preference;
        }
        Ok(())
    }
}

fn checked_preview_browser_url(
    raw: &str,
    owner: &str,
    preview: Option<&str>,
) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "Invalid preview browser address")?;
    let origin = url.origin().ascii_serialization();
    if raw.len() > 16384
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || !is_preview_path(url.path())
        || (origin != owner && preview != Some(origin.as_str()))
    {
        return Err("Browser results must use this garden server's preview address".into());
    }
    // Retain the grant-bearing URL; the external browser must perform its own cookie exchange.
    Ok(raw.to_owned())
}

fn checked_authorization_browser_url(raw: &str, endpoints: &[String]) -> Result<String, String> {
    let url = url::Url::parse(raw).map_err(|_| "Invalid browser authorization address")?;
    if raw.len() > 8192
        || url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || !endpoints.iter().any(|endpoint| {
            url::Url::parse(endpoint).is_ok_and(|endpoint| endpoint.origin() == url.origin())
        })
    {
        return Err("Browser authorization must use this garden server".into());
    }
    let fields: Vec<_> =
        url::form_urlencoded::parse(url.fragment().unwrap_or("").as_bytes()).collect();
    if fields.is_empty()
        || fields.len() > 2
        || fields[0].0 != "native-auth"
        || uuid::Uuid::parse_str(&fields[0].1).is_err()
        || (fields.len() == 2
            && (fields[1].0 != "native-onboard"
                || fields[1].1.is_empty()
                || !fields[1]
                    .1
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')))
    {
        return Err("This address is not a garden device authorization".into());
    }
    Ok(url.to_string())
}

#[derive(Deserialize)]
struct PairRequest {
    ticket: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NetworkPreferenceRequest {
    preference: NetworkPreference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClientStatus {
    configured: bool,
    connected: bool,
    identity: Option<String>,
    endpoints: Vec<String>,
    error: Option<String>,
    network_preference: Option<NetworkPreference>,
    app_version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    pairing_code: Option<String>,
    installer_url: String,
}

#[derive(Deserialize)]
struct SshProbeRequest {
    host: String,
    port: u16,
}

pub async fn start(state: Arc<ClientState>) -> Result<String, String> {
    let installer_listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|error| format!("Could not start the secure installer: {error}"))?;
    let installer_address = installer_listener
        .local_addr()
        .map_err(|error| format!("Could not read the secure installer address: {error}"))?;
    let installer_origin = format!("http://localhost:{}", installer_address.port());
    *state.installer_origin.write().await = installer_origin;
    let installer_router = Router::new()
        .route("/", get(installer))
        .route("/probe", post(probe_ssh))
        .route("/install", post(install_server));
    #[cfg(desktop)]
    let installer_router = installer_router.route("/choose-key", post(choose_ssh_key));
    let installer_router =
        installer_router
            .with_state(state.clone())
            .layer(middleware::from_fn_with_state(
                installer_address.port(),
                only_this_gateway,
            ));
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(installer_listener, installer_router).await {
            eprintln!("garden secure installer stopped: {error}");
        }
    });

    /*
     * The same port every launch, because the port is part of the origin.
     *
     * Binding 0 takes whatever is free, so the shell came up on a different origin each time it
     * started - and a browser keys local storage to an origin including its port. Every launch was
     * therefore a brand new profile: the model choice, the open panel, and every draft this device
     * had not yet synced were all addressed to an origin that no longer existed. The port is
     * remembered beside the server profile and reused; if something else has taken it in the
     * meantime the ephemeral bind is still there as a fallback, which is no worse than before.
     */
    let port_path = state.profile_path.with_file_name("client-gateway-port");
    let remembered = std::fs::read_to_string(&port_path)
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .filter(|port| *port >= 1024);
    let listener = match remembered {
        Some(port) => match TcpListener::bind(("127.0.0.1", port)).await {
            Ok(bound) => bound,
            Err(_) => TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|error| format!("Could not start the private client gateway: {error}"))?,
        },
        None => TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Could not start the private client gateway: {error}"))?,
    };
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the private client address: {error}"))?;
    if remembered != Some(address.port()) {
        // Best effort: a shell that cannot write this still runs, it just starts somewhere else
        // next time, which is exactly what it did before.
        //
        // 0600 like the profile beside it. This file names the port on which the process holding
        // the owner's session is listening, and `std::fs::write` would have left it 0644 next to a
        // neighbour that goes to the trouble of create-new + rename + fsync at 0600.
        let _ = write_private_port(&port_path, address.port());
    }
    let origin = format!("http://localhost:{}", address.port());
    *state.local_origin.write().await = origin.clone();
    preview_proxy::start(state.clone()).await?;
    let router = Router::new()
        .route("/__garden/client/status", get(client_status))
        .route("/__garden/client/pair", post(pair))
        .route(
            "/__garden/client/network-preference",
            post(save_network_preference),
        )
        .route("/__garden/client/profile", delete(forget_server))
        .route("/__garden/client/bootstrap", get(bootstrap))
        .fallback(proxy)
        .with_state(state)
        .layer(middleware::from_fn_with_state(
            address.port(),
            only_this_gateway,
        ));
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("garden private client gateway stopped: {error}");
        }
    });
    Ok(origin)
}

async fn client_status(State(state): State<Arc<ClientState>>) -> Json<ClientStatus> {
    let profile = state.profile.read().await.clone();
    let connected = state.active.read().await.is_some();
    Json(ClientStatus {
        configured: profile.is_some(),
        connected,
        identity: profile.as_ref().map(|value| value.identity.clone()),
        endpoints: profile
            .as_ref()
            .map(|value| value.endpoints.clone())
            .unwrap_or_default(),
        // Only while disconnected. A connection that came back should not keep showing the
        // failure that preceded it.
        error: if connected {
            None
        } else {
            state.last_error.read().await.clone()
        },
        network_preference: profile.as_ref().map(|value| value.network_preference),
        app_version: env!("CARGO_PKG_VERSION"),
    })
}

fn is_local_client_origin(headers: &HeaderMap, expected: &str) -> bool {
    headers.get(ORIGIN).and_then(|value| value.to_str().ok()) == Some(expected)
}

/*
 * A request that names an origin, and names one that is not this gateway.
 *
 * This is deliberately not `!is_local_client_origin`. The four named routes here are called by
 * script and can insist on an exact `Origin`; the fallback carries every page load, every
 * same-origin `GET` and every navigation, and a browser sends no `Origin` header on any of those.
 * Refusing an absent origin there would refuse the app itself. So the fallback asks the weaker
 * question the API upstream asks of its own callers (`server.ts`: `if (origin && origin !==
 * PUBLIC_APP_URL) throw invalid_origin`) - and it has to be asked *here*, because `forwarded_headers`
 * overwrites `Origin` with the box's canonical origin before the request leaves this process, so
 * the upstream check can only ever see a value this gateway wrote. This is the last point at which
 * the truth is still known.
 */
fn is_foreign_origin(headers: &HeaderMap, expected: &str) -> bool {
    headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value != expected)
}

/*
 * Is this request addressed to the loopback gateway, or to a name that merely resolves to it?
 *
 * Binding 127.0.0.1 keeps the network out; it does not keep a *web page* out. DNS rebinding points
 * an attacker's own hostname at 127.0.0.1, after which the page's fetches to `http://their-name:PORT/`
 * are same-origin from the browser's point of view: no `Origin` header is sent, no CORS check runs,
 * and the response body is readable. The session cookie does not travel (it is scoped to the host
 * `localhost`), so the proxied API stays unauthenticated - but `/__garden/client/status` and
 * `/__garden/client/bootstrap` need no session, and between them they hand out the box's public
 * endpoints and the first-owner pairing code. The port stopped being a secret when it was fixed and
 * written to disk so that local storage would survive a restart.
 *
 * The `Host` header is what distinguishes the two cases, and it is the only thing that does. It is
 * checked once, in front of every route including the fallback, rather than route by route.
 */
fn is_this_gateway_authority(value: &str, port: u16) -> bool {
    // An IPv6 literal keeps its brackets, so the colons inside it are not port separators.
    let (host, authority_port) = match value.rsplit_once(':') {
        Some((host, tail)) if !tail.contains(']') => (host, tail.parse::<u16>().ok()),
        _ => (value, None),
    };
    authority_port == Some(port) && matches!(host, "localhost" | "127.0.0.1" | "[::1]")
}

async fn only_this_gateway(State(port): State<u16>, request: Request, next: Next) -> Response {
    let addressed_to = request
        .headers()
        .get(HOST)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or_else(|| {
            request
                .uri()
                .authority()
                .map(|authority| authority.as_str().to_owned())
        });
    match addressed_to {
        Some(authority) if is_this_gateway_authority(&authority, port) => next.run(request).await,
        _ => (
            StatusCode::MISDIRECTED_REQUEST,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_host",
                    "message": "This address is not the garden client gateway"
                }
            })),
        )
            .into_response(),
    }
}

async fn pair(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<PairRequest>,
) -> Response {
    let local_origin = state.local_origin().await;
    if !is_local_client_origin(&headers, &local_origin) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_origin",
                    "message": "Connection tickets are accepted only from the garden client"
                }
            })),
        )
            .into_response();
    }
    match state.import(&request.ticket).await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "connected": true })),
        )
            .into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "connection_failed", "message": message }
            })),
        )
            .into_response(),
    }
}

async fn save_network_preference(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<NetworkPreferenceRequest>,
) -> Response {
    if !is_local_client_origin(&headers, &state.local_origin().await) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_origin",
                    "message": "Network preferences are accepted only from the garden client"
                }
            })),
        )
            .into_response();
    }
    match state.set_network_preference(request.preference).await {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "saved": true }))).into_response(),
        Err(message) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "error": { "code": "preference_failed", "message": message }
            })),
        )
            .into_response(),
    }
}

async fn forget_server(State(state): State<Arc<ClientState>>, headers: HeaderMap) -> Response {
    if !is_local_client_origin(&headers, &state.local_origin().await) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_origin",
                    "message": "Disconnecting a server is accepted only from the garden client"
                }
            })),
        )
            .into_response();
    }
    match state.forget().await {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "connected": false })),
        )
            .into_response(),
        Err(message) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": { "code": "disconnect_failed", "message": message }
            })),
        )
            .into_response(),
    }
}

async fn bootstrap(State(state): State<Arc<ClientState>>) -> Json<Bootstrap> {
    Json(Bootstrap {
        pairing_code: state
            .pairing_code
            .read()
            .await
            .as_ref()
            .map(|pending| pending.pairing_code.clone()),
        installer_url: state.installer_origin().await,
    })
}

fn installer_error(status: StatusCode, code: &str, message: String) -> Response {
    (
        status,
        Json(serde_json::json!({
            "error": { "code": code, "message": message }
        })),
    )
        .into_response()
}

async fn installer(State(state): State<Arc<ClientState>>) -> Response {
    let configured = state.profile.read().await.is_some();
    let mut response = Html(ssh_install::installer_page(
        configured,
        &state.local_origin().await,
    ))
    .into_response();
    let headers = response.headers_mut();
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static(
            "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        HeaderName::from_static("cache-control"),
        HeaderValue::from_static("no-store"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    response
}

async fn probe_ssh(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<SshProbeRequest>,
) -> Response {
    if !is_local_client_origin(&headers, &state.installer_origin().await) {
        return installer_error(
            StatusCode::FORBIDDEN,
            "invalid_installer_origin",
            "SSH checks are accepted only from the secure garden installer".into(),
        );
    }
    match ssh_install::probe(request.host, request.port).await {
        Ok(identity) => (StatusCode::OK, Json(identity)).into_response(),
        Err(message) => installer_error(StatusCode::BAD_REQUEST, "ssh_probe_failed", message),
    }
}

#[cfg(desktop)]
async fn choose_ssh_key(State(state): State<Arc<ClientState>>, headers: HeaderMap) -> Response {
    if !is_local_client_origin(&headers, &state.installer_origin().await) {
        return installer_error(
            StatusCode::FORBIDDEN,
            "invalid_installer_origin",
            "Private keys can be selected only from the secure garden installer".into(),
        );
    }
    let selected = rfd::AsyncFileDialog::new()
        .set_title("Choose the SSH private key")
        .pick_file()
        .await;
    let path = selected
        .as_ref()
        .and_then(|file| file.path().to_str())
        .map(str::to_owned);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "path": path
        })),
    )
        .into_response()
}

async fn install_server(
    State(state): State<Arc<ClientState>>,
    headers: HeaderMap,
    Json(request): Json<InstallServerRequest>,
) -> Response {
    if !is_local_client_origin(&headers, &state.installer_origin().await) {
        return installer_error(
            StatusCode::FORBIDDEN,
            "invalid_installer_origin",
            "Server installation is accepted only from the secure garden installer".into(),
        );
    }
    match ssh_install::install(request).await {
        Ok(result) => match state.import(&result.ticket).await {
            Ok(()) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "connected": true,
                    "clientUrl": state.local_origin().await
                })),
            )
                .into_response(),
            Err(message) => installer_error(
                StatusCode::BAD_GATEWAY,
                "server_pairing_failed",
                format!("garden installed, but its private HTTPS connection failed: {message}"),
            ),
        },
        Err(message) => installer_error(StatusCode::BAD_REQUEST, "server_install_failed", message),
    }
}

fn write_private_port(path: &std::path::Path, port: u16) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(port.to_string().as_bytes())
}

fn is_hop_by_hop(name: &HeaderName) -> bool {
    matches!(
        name.as_str().to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn forwarded_headers(input: &HeaderMap, canonical_origin: &str) -> HeaderMap {
    let mut output = HeaderMap::new();
    for (name, value) in input {
        if !is_hop_by_hop(name) && name != HOST && name != CONTENT_LENGTH {
            output.append(name.clone(), value.clone());
        }
    }
    /*
     * Insert, not append: the page may have set this header itself, and the box must read the one
     * the shell wrote. Every session created through this gateway is labelled from it.
     */
    output.insert(
        HeaderName::from_static(CLIENT_HEADER),
        HeaderValue::from_static(CLIENT_IDENTITY),
    );
    if input.contains_key(ORIGIN) {
        if let Ok(value) = HeaderValue::from_str(canonical_origin) {
            output.insert(ORIGIN, value);
        }
    }
    if input.contains_key(REFERER) {
        if let Ok(value) = HeaderValue::from_str(&format!("{canonical_origin}/")) {
            output.insert(REFERER, value);
        }
    }
    if let Some(value) = input.get(COOKIE).and_then(|value| value.to_str().ok()) {
        let translated = value
            .split(';')
            .map(str::trim)
            .map(|cookie| {
                cookie
                    .strip_prefix(&format!("{LOCAL_SESSION_COOKIE}="))
                    .map(|value| format!("{SERVER_SESSION_COOKIE}={value}"))
                    .unwrap_or_else(|| cookie.to_owned())
            })
            .collect::<Vec<_>>()
            .join("; ");
        if let Ok(value) = HeaderValue::from_str(&translated) {
            output.insert(COOKIE, value);
        }
    }
    output
}

fn local_set_cookie(raw: &str) -> Option<HeaderValue> {
    let prefix = format!("{SERVER_SESSION_COOKIE}=");
    let value = raw.strip_prefix(&prefix)?;
    let mut parts = value.split(';');
    let session = parts.next()?;
    let mut translated = format!("{LOCAL_SESSION_COOKIE}={session}");
    for attribute in parts {
        let attribute = attribute.trim();
        if attribute.eq_ignore_ascii_case("secure")
            || attribute.to_ascii_lowercase().starts_with("domain=")
        {
            continue;
        }
        translated.push_str("; ");
        translated.push_str(attribute);
    }
    HeaderValue::from_str(&translated).ok()
}

fn issued_server_session(path: &str, status: StatusCode, headers: &HeaderMap) -> bool {
    let prefix = format!("{SERVER_SESSION_COOKIE}=");
    path.starts_with("/v1/auth/")
        && status.is_success()
        && headers.get_all(SET_COOKIE).iter().any(|value| {
            value
                .to_str()
                .ok()
                .and_then(|value| value.strip_prefix(&prefix))
                .is_some_and(|value| !value.split(';').next().unwrap_or("").is_empty())
        })
}

fn upstream_url(active: &ActiveServer, path_and_query: &str) -> String {
    format!(
        "{}{}",
        active
            .profile
            .last_endpoint
            .as_ref()
            .unwrap_or(&active.profile.endpoints[0]),
        path_and_query
    )
}

fn canonical_origin(active: &ActiveServer) -> &str {
    &active.profile.endpoints[0]
}

fn is_preview_path(path: &str) -> bool {
    let Some(remainder) = path.strip_prefix("/__garden/preview/") else {
        return false;
    };
    let slug = remainder.split('/').next().unwrap_or("");
    slug.len() == 32
        && slug
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value))
}

fn native_preview_policy(raw: &str, trusted_origin: &str, local_origin: &str) -> String {
    raw.split_inclusive([';', ','])
        .map(|part| {
            let directive = part.trim_end_matches([';', ',']);
            if !directive
                .split_ascii_whitespace()
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("frame-ancestors"))
            {
                return part.to_owned();
            }
            let mut mapped = directive
                .split_inclusive(|value: char| value.is_ascii_whitespace())
                .map(|piece| {
                    let source = piece.trim_end_matches(|value: char| value.is_ascii_whitespace());
                    if source == trusted_origin {
                        format!("{local_origin}{}", &piece[source.len()..])
                    } else {
                        piece.to_owned()
                    }
                })
                .collect::<String>();
            mapped.push_str(&part[directive.len()..]);
            mapped
        })
        .collect()
}

fn native_location(raw: &str, endpoints: &[String], local_origin: &str) -> Option<String> {
    let destination = url::Url::parse(raw).ok()?;
    if !destination.username().is_empty()
        || destination.password().is_some()
        || !endpoints.iter().any(|endpoint| {
            url::Url::parse(endpoint).is_ok_and(|trusted| trusted.origin() == destination.origin())
        })
    {
        return None;
    }
    let mut local = url::Url::parse(local_origin).ok()?;
    local.set_path(destination.path());
    local.set_query(destination.query());
    local.set_fragment(destination.fragment());
    Some(local.to_string())
}

fn should_buffer_for_retry(
    method: &Method,
    headers: &HeaderMap,
    content_length: Option<usize>,
) -> bool {
    let inherently_safe = matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS);
    let replayable = inherently_safe || headers.contains_key("idempotency-key");
    let known_small_body = content_length
        .map(|length| length <= RETRYABLE_BODY_LIMIT)
        .unwrap_or(inherently_safe);
    replayable && known_small_body
}

async fn send_buffered(
    active: &ActiveServer,
    method: Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: bytes::Bytes,
) -> Result<reqwest::Response, reqwest::Error> {
    active
        .http
        .request(method, upstream_url(active, path_and_query))
        .headers(forwarded_headers(&headers, canonical_origin(active)))
        .body(body)
        .send()
        .await
}

async fn send_streaming(
    active: &ActiveServer,
    method: Method,
    path_and_query: &str,
    headers: HeaderMap,
    body: Body,
) -> Result<reqwest::Response, reqwest::Error> {
    active
        .http
        .request(method, upstream_url(active, path_and_query))
        .headers(forwarded_headers(&headers, canonical_origin(active)))
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
}

fn upstream_response(
    response: reqwest::Response,
    active: &ActiveServer,
    local_origin: &str,
    request_path: &str,
    preview: Option<&preview_proxy::Connection>,
    preview_local_origin: &str,
) -> Response {
    let status = response.status();
    let mut builder = Response::builder().status(status);
    if let Some(headers) = builder.headers_mut() {
        headers.insert(
            HeaderName::from_static("x-garden-native-client"),
            HeaderValue::from_static("1"),
        );
        if let Ok(origin) = HeaderValue::from_str(canonical_origin(active)) {
            headers.insert(HeaderName::from_static("x-garden-server-origin"), origin);
        }
        if let Some(preview) = preview {
            headers.insert(
                HeaderName::from_static("x-garden-preview-origin"),
                HeaderValue::from_str(&preview.remote.origin().ascii_serialization()).unwrap(),
            );
            headers.insert(
                HeaderName::from_static("x-garden-preview-local-origin"),
                HeaderValue::from_str(&preview.local).unwrap(),
            );
        }
        for (name, value) in response.headers() {
            if !is_hop_by_hop(name) && name != CONTENT_LENGTH {
                if matches!(
                    name.as_str(),
                    "x-garden-native-client"
                        | "x-garden-server-origin"
                        | "x-garden-preview-origin"
                        | "x-garden-preview-local-origin"
                ) {
                    continue;
                }
                if name.as_str() == "content-security-policy" && is_preview_path(request_path) {
                    if let Some(policy) = value.to_str().ok().and_then(|raw| {
                        HeaderValue::from_str(&native_preview_policy(
                            raw,
                            canonical_origin(active),
                            local_origin,
                        ))
                        .ok()
                    }) {
                        headers.append(name.clone(), policy);
                        continue;
                    }
                }
                if name.as_str() == "content-security-policy" && request_path == "/" {
                    if let Ok(raw) = value.to_str() {
                        if let Ok(policy) = HeaderValue::from_str(&preview_proxy::app_policy(
                            raw,
                            preview_local_origin,
                        )) {
                            headers.append(name.clone(), policy);
                            continue;
                        }
                    }
                }
                if name == SET_COOKIE {
                    if let Some(value) = value.to_str().ok().and_then(local_set_cookie) {
                        headers.append(name.clone(), value);
                    } else {
                        headers.append(name.clone(), value.clone());
                    }
                    continue;
                }
                if name == LOCATION {
                    if let Ok(raw) = value.to_str() {
                        let rewritten =
                            native_location(raw, &active.profile.endpoints, local_origin);
                        if let Some(rewritten) = rewritten {
                            if let Ok(rewritten) = HeaderValue::from_str(&rewritten) {
                                headers.append(name.clone(), rewritten);
                                continue;
                            }
                        }
                    }
                }
                headers.append(name.clone(), value.clone());
            }
        }
    }
    builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

fn gateway_error(
    message: String,
    html: bool,
    preference: Option<NetworkPreference>,
    installer_url: &str,
) -> Response {
    if html {
        let mut response = Html(offline_page(&message, preference, installer_url)).into_response();
        let headers = response.headers_mut();
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            ),
        );
        headers.insert(
            HeaderName::from_static("referrer-policy"),
            HeaderValue::from_static("no-referrer"),
        );
        headers.insert(
            HeaderName::from_static("x-content-type-options"),
            HeaderValue::from_static("nosniff"),
        );
        return response;
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(serde_json::json!({
            "error": { "code": "server_unreachable", "message": message }
        })),
    )
        .into_response()
}

async fn proxy(State(state): State<Arc<ClientState>>, request: Request) -> Response {
    if is_foreign_origin(request.headers(), &state.local_origin().await) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "error": {
                    "code": "invalid_client_origin",
                    "message": "This request did not come from the garden client"
                }
            })),
        )
            .into_response();
    }
    let wants_html = request.method() == Method::GET
        && request.uri().path() == "/"
        && request
            .headers()
            .get("accept")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("text/html"));

    let active = match state.current().await {
        Ok(active) => active,
        Err(message) => {
            let message = if state.profile.read().await.is_none() {
                String::new()
            } else {
                message
            };
            let preference = state
                .profile
                .read()
                .await
                .as_ref()
                .map(|profile| profile.network_preference);
            return gateway_error(
                message,
                wants_html,
                preference,
                &state.installer_origin().await,
            );
        }
    };

    if request
        .headers()
        .get(UPGRADE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("websocket"))
    {
        return websocket_proxy(state, active, request).await;
    }

    let (parts, body) = request.into_parts();
    let request_path = parts.uri.path().to_owned();
    let request_method = parts.method.clone();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_owned();
    let content_length = parts
        .headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<usize>().ok());

    let response = if should_buffer_for_retry(&parts.method, &parts.headers, content_length) {
        let buffered = match to_bytes(body, RETRYABLE_BODY_LIMIT).await {
            Ok(value) => value,
            Err(_) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "This request is too large for automatic address failover",
                )
                    .into_response()
            }
        };
        match send_buffered(
            &active,
            parts.method.clone(),
            &path_and_query,
            parts.headers.clone(),
            buffered.clone(),
        )
        .await
        {
            Ok(response) => Ok((response, active.clone())),
            Err(_) => {
                state.invalidate().await;
                match state.current().await {
                    Ok(refreshed) => send_buffered(
                        &refreshed,
                        parts.method,
                        &path_and_query,
                        parts.headers,
                        buffered,
                    )
                    .await
                    .map(|response| (response, refreshed)),
                    Err(message) => {
                        let preference = state
                            .profile
                            .read()
                            .await
                            .as_ref()
                            .map(|profile| profile.network_preference);
                        return gateway_error(
                            message,
                            wants_html,
                            preference,
                            &state.installer_origin().await,
                        );
                    }
                }
            }
        }
    } else {
        send_streaming(&active, parts.method, &path_and_query, parts.headers, body)
            .await
            .map(|response| (response, active.clone()))
    };

    match response {
        Ok((response, used)) => {
            preview_proxy::observe(&state, &used, &request_path, &request_method, &response).await;
            let preview = preview_proxy::connection(&state, &used).await;
            if issued_server_session(&path_and_query, response.status(), response.headers()) {
                if let Err(error) = state.clear_pairing_code().await {
                    eprintln!("garden could not remove the consumed pairing code: {error}");
                }
            }
            upstream_response(
                response,
                &used,
                &state.local_origin().await,
                &request_path,
                preview.as_ref(),
                &state.preview.origin.read().await,
            )
        }
        Err(error) => {
            state.invalidate().await;
            let preference = state
                .profile
                .read()
                .await
                .as_ref()
                .map(|profile| profile.network_preference);
            gateway_error(
                format!("The server connection was interrupted: {error}"),
                wants_html,
                preference,
                &state.installer_origin().await,
            )
        }
    }
}

async fn websocket_proxy(
    state: Arc<ClientState>,
    active: ActiveServer,
    request: Request,
) -> Response {
    let (mut parts, _) = request.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_owned();
    let incoming_headers = parts.headers.clone();
    let upgrade = match WebSocketUpgrade::from_request_parts(&mut parts, &state).await {
        Ok(upgrade) => upgrade,
        Err(rejection) => return rejection.into_response(),
    };
    let offered = incoming_headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let upgrade = if offered
        .split(',')
        .any(|value| value.trim() == "garden-capability")
    {
        upgrade.protocols(["garden-capability"])
    } else {
        upgrade
    };
    upgrade.on_upgrade(move |browser| async move {
        if let Err(error) = bridge_websocket(
            browser,
            state.clone(),
            active,
            path_and_query,
            incoming_headers,
        )
        .await
        {
            state.invalidate().await;
            eprintln!("garden websocket gateway closed: {error}");
        }
    })
}

async fn connect_server_websocket(
    active: &ActiveServer,
    path_and_query: &str,
    incoming_headers: &HeaderMap,
) -> Result<WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>, String> {
    let target = upstream_url(active, path_and_query).replacen("https://", "wss://", 1);
    let mut request = target
        .into_client_request()
        .map_err(|error| format!("Could not create the server WebSocket request: {error}"))?;
    for name in [
        "authorization",
        "cookie",
        "sec-websocket-protocol",
        "user-agent",
    ] {
        if let Some(value) = incoming_headers.get(name) {
            request
                .headers_mut()
                .insert(HeaderName::from_static(name), value.clone());
        }
    }
    request.headers_mut().insert(
        ORIGIN,
        HeaderValue::from_str(canonical_origin(active))
            .map_err(|_| "The canonical server origin is invalid")?,
    );
    connect_async_tls_with_config(
        request,
        None,
        true,
        Some(Connector::Rustls(active.websocket_tls.clone())),
    )
    .await
    .map_err(|error| format!("Could not connect to the pinned server WebSocket: {error}"))
    .map(|(server, _)| server)
}

// axum and tungstenite each wrap their own UTF-8-checked view over the same `Bytes`, so a text
// frame crosses the bridge by handing the buffer over: one validation pass rather than a copy of
// every streamed token. The check cannot fail on a payload that arrived inside the peer's own
// checked type, but a relay is the wrong place to assert that.
fn relay_text<T: TryFrom<bytes::Bytes>>(payload: impl Into<bytes::Bytes>) -> Result<T, String> {
    T::try_from(payload.into())
        .map_err(|_| "A WebSocket text frame was not valid UTF-8".to_string())
}

async fn bridge_websocket(
    browser: WebSocket,
    state: Arc<ClientState>,
    active: ActiveServer,
    path_and_query: String,
    incoming_headers: HeaderMap,
) -> Result<(), String> {
    let server = match connect_server_websocket(&active, &path_and_query, &incoming_headers).await {
        Ok(server) => server,
        Err(first_error) => {
            state.invalidate().await;
            let refreshed = state.current().await.map_err(|refresh_error| {
                format!("{first_error}; address refresh failed: {refresh_error}")
            })?;
            connect_server_websocket(&refreshed, &path_and_query, &incoming_headers)
                .await
                .map_err(|retry_error| format!("{first_error}; reconnect failed: {retry_error}"))?
        }
    };
    relay_websocket_streams(browser, server).await
}

async fn relay_websocket_streams(
    browser: WebSocket,
    server: WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>,
) -> Result<(), String> {
    let (mut browser_out, mut browser_in) = browser.split();
    let (mut server_out, mut server_in) = server.split();
    loop {
        tokio::select! {
            incoming = browser_in.next() => match incoming {
                Some(Ok(message)) => {
                    let message = match message {
                        BrowserMessage::Text(value) => ServerMessage::Text(relay_text(value)?),
                        BrowserMessage::Binary(value) => ServerMessage::Binary(value),
                        BrowserMessage::Ping(value) => ServerMessage::Ping(value),
                        BrowserMessage::Pong(value) => ServerMessage::Pong(value),
                        BrowserMessage::Close(_) => ServerMessage::Close(None),
                    };
                    server_out.send(message).await.map_err(|error| error.to_string())?;
                }
                _ => break,
            },
            incoming = server_in.next() => match incoming {
                Some(Ok(message)) => {
                    let message = match message {
                        ServerMessage::Text(value) => Some(BrowserMessage::Text(relay_text(value)?)),
                        ServerMessage::Binary(value) => Some(BrowserMessage::Binary(value)),
                        ServerMessage::Ping(value) => Some(BrowserMessage::Ping(value)),
                        ServerMessage::Pong(value) => Some(BrowserMessage::Pong(value)),
                        ServerMessage::Close(_) => Some(BrowserMessage::Close(None)),
                        ServerMessage::Frame(_) => None,
                    };
                    if let Some(message) = message {
                        browser_out.send(message).await.map_err(|error| error.to_string())?;
                    }
                }
                _ => break,
            }
        }
    }
    Ok(())
}

fn offline_page(
    message: &str,
    preference: Option<NetworkPreference>,
    installer_url: &str,
) -> String {
    let safe_message = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");
    let network_help = match preference {
        None | Some(NetworkPreference::Fixed) => String::new(),
        Some(NetworkPreference::Unknown) => r#"
  <section class="network-help" id="network-help">
    <strong>Did the server's public address change?</strong>
    <p>Some home connections and VPS plans use dynamic public IP addresses.</p>
    <div class="choice-row">
      <button class="secondary" data-network="dynamic">It may have changed</button>
      <button class="quiet" data-network="fixed">My address is fixed</button>
    </div>
  </section>"#
            .to_owned(),
        Some(NetworkPreference::Dynamic) => r#"
  <section class="network-help" id="network-help">
    <strong>A stable hostname prevents this next time</strong>
    <ol>
      <li>Choose a dynamic-DNS hostname from your router, VPS provider, DuckDNS, or your own DNS provider.</li>
      <li>Keep that hostname updated to the server's current public IP and ensure TCP 443 reaches garden.</li>
      <li>On the server run <code>sudo garden set-hostname your-name.example.com</code>, then scan the refreshed QR ticket.</li>
    </ol>
    <p class="privacy">Dynamic DNS learns the hostname and IP required to provide DNS. It never bypasses garden's pinned identity, passkey, or TLS checks.</p>
  </section>"#
            .to_owned(),
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect garden</title>
<style>
  :root {{ color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; min-height: 100vh; display: grid; place-items: center; color: #e9eee2;
    background: #151d19; }}
  main {{ width: min(580px, calc(100vw - 32px)); padding: 36px; border-radius: 24px;
    border: 1px solid #48573e; background: #202c24;
    box-shadow: 0 24px 80px #000a, inset 0 1px #ffffff1a; }}
  .brand {{ font: 38px Georgia, serif; letter-spacing: -.05em; margin-bottom: 32px; }}
  .eyebrow {{ color: #adbaa4; text-transform: uppercase; letter-spacing: .14em; font-size: 11px; }}
  h1 {{ font-size: clamp(29px, 5vw, 42px); line-height: 1.05; margin: 10px 0 14px; }}
  p {{ color: #adbaa4; line-height: 1.55; }}
  label {{ display: block; margin-top: 20px; font-size: 14px; font-weight: 650; }}
  textarea {{ width: 100%; min-height: 120px; resize: vertical; margin: 8px 0 12px; padding: 15px;
    color: #e9eee2; background: #151d19; border: 1px solid #48573e; border-radius: 14px; outline: none; }}
  textarea:focus {{ border-color: #d5e8a9; box-shadow: 0 0 0 3px #e9ecef14, 0 0 28px #dfe3e61c; }}
  button {{ width: 100%; border: 1px solid #d5e8a9; border-radius: 13px; padding: 13px 18px;
    color: #151d19; background: #d5e8a9; font-weight: 720;
    cursor: pointer; }}
  button:disabled {{ opacity: .55; cursor: wait; }}
  .error {{ min-height: 24px; margin-top: 12px; color: #e6a8a8; font-size: 13px; }}
  .hint {{ font-size: 13px; }}
  .network-help {{ margin-top: 22px; padding-top: 20px; border-top: 1px solid #48573e; }}
  .network-help strong {{ display: block; margin-bottom: 4px; }}
  .network-help ol {{ padding-left: 21px; color: #adbaa4; line-height: 1.55; }}
  .network-help code {{ color: #e9eee2; }}
  .choice-row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 12px; }}
  .choice-row button {{ padding: 10px; }}
  button.secondary {{ color: #e9eee2; background: #2a382d; border-color: #48573e; box-shadow: none; }}
  button.quiet {{ color: #adbaa4; background: transparent; border-color: #48573e; box-shadow: none; }}
  .privacy {{ font-size: 12px; }}
  .install-link {{ display: block; margin-top: 18px; color: #adbaa4; text-align: center; font-size: 13px; }}
</style>
<main>
  <div class="brand">garden</div>
  <div class="eyebrow">Private server connection</div>
  <h1>Connect your AI computer</h1>
  <p id="ticket-help">Paste the one-time connection ticket printed after installing garden. The app will pin your server’s permanent identity and follow its address when the IP changes.</p>
  <label for="ticket">Connection ticket</label>
  <textarea id="ticket" aria-label="Connection ticket" aria-describedby="ticket-help error" spellcheck="false" autocomplete="off" placeholder="garden://pair/…"></textarea>
  <button id="connect">Connect securely</button>
  <div class="error" id="error" role="status" aria-live="polite">{safe_message}</div>
  <p class="hint">The server’s SSH login, IP address, and TLS warnings are not needed here.</p>
  <a class="install-link" href="{installer_url}">Install garden on a cloud server</a>
  {network_help}
</main>
<script>
  const button = document.querySelector('#connect');
  const error = document.querySelector('#error');
  const ticket = document.querySelector('#ticket');
  button.addEventListener('click', async () => {{
    button.disabled = true; ticket.removeAttribute('aria-invalid'); error.textContent = 'Verifying server identity…';
    try {{
      const response = await fetch('/__garden/client/pair', {{
        method: 'POST', headers: {{'content-type':'application/json'}},
        body: JSON.stringify({{ticket: ticket.value.trim()}})
      }});
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message || 'Connection failed');
      location.replace('/');
    }} catch (cause) {{
      error.textContent = cause.message || 'Connection failed'; button.disabled = false;
      ticket.setAttribute('aria-invalid', 'true'); ticket.focus();
    }}
  }});
  document.querySelectorAll('[data-network]').forEach((choice) => {{
    choice.addEventListener('click', async () => {{
      const preference = choice.dataset.network;
      const response = await fetch('/__garden/client/network-preference', {{
        method: 'POST',
        headers: {{'content-type': 'application/json'}},
        body: JSON.stringify({{preference}})
      }});
      if (!response.ok) return;
      if (preference === 'fixed') document.querySelector('#network-help')?.remove();
      else location.reload();
    }});
  }});
</script>
</html>"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{save_profile, Discovery, ServerProfile};
    use base64::Engine as _;

    #[test]
    fn pairing_secret_is_consumed_only_by_successful_session_issuance() {
        let mut headers = HeaderMap::new();
        for cookie in [
            "unrelated=opaque",
            "__Host-garden_session_extra=opaque",
            "__Host-garden_session=; HttpOnly",
        ] {
            headers.insert(SET_COOKIE, HeaderValue::from_str(cookie).unwrap());
            assert!(!issued_server_session(
                "/v1/auth/native/redeem",
                StatusCode::OK,
                &headers
            ));
        }
        headers.insert(
            SET_COOKIE,
            HeaderValue::from_static("__Host-garden_session=opaque; Secure; HttpOnly"),
        );
        assert!(issued_server_session(
            "/v1/auth/native/redeem",
            StatusCode::OK,
            &headers
        ));
        assert!(issued_server_session(
            "/v1/auth/register/verify",
            StatusCode::OK,
            &headers
        ));
        assert!(!issued_server_session(
            "/v1/auth/native/redeem",
            StatusCode::FORBIDDEN,
            &headers
        ));
        assert!(!issued_server_session(
            "/v1/unrelated",
            StatusCode::OK,
            &headers
        ));
    }

    #[test]
    fn authorization_browser_is_bound_to_the_pinned_server_and_exact_flow() {
        let endpoints = vec!["https://garden.example".to_owned()];
        let request = "#native-auth=11111111-1111-4111-8111-111111111111";
        let valid = format!("https://garden.example/{request}");
        assert_eq!(
            checked_authorization_browser_url(&valid, &endpoints).unwrap(),
            valid
        );
        assert!(checked_authorization_browser_url(
            &format!("{valid}&native-onboard=eyJtb2RlIjoicmVnaXN0ZXIifQ"),
            &endpoints
        )
        .is_ok());
        let denied = [
            format!("https://outside.example/{request}"),
            format!("http://garden.example/{request}"),
            format!("https://garden.example:444/{request}"),
            format!("https://secret@garden.example/{request}"),
            format!("https://garden.example/redirect{request}"),
            format!("https://garden.example/?redirect=https://outside.example{request}"),
            format!("{valid}&callback=https://outside.example"),
            format!("{valid}&native-auth=22222222-2222-4222-8222-222222222222"),
            format!("{valid}&native-onboard=has%2Bpadding%3D"),
            "https://garden.example/#native-auth=not-a-request".to_owned(),
        ];
        assert!(!denied.is_empty());
        for address in denied {
            assert!(
                checked_authorization_browser_url(&address, &endpoints).is_err(),
                "{address}"
            );
        }
    }

    #[test]
    fn strips_hop_by_hop_headers_and_rewrites_browser_origin() {
        let mut input = HeaderMap::new();
        input.insert(
            axum::http::header::CONNECTION,
            HeaderValue::from_static("keep-alive"),
        );
        input.insert(HOST, HeaderValue::from_static("localhost:41000"));
        input.insert(ORIGIN, HeaderValue::from_static("http://localhost:41000"));
        input.insert(
            COOKIE,
            HeaderValue::from_static("theme=dark; garden_native_session=private-value"),
        );
        let result = forwarded_headers(&input, "https://ai.example.test");
        assert!(!result.contains_key(axum::http::header::CONNECTION));
        assert!(!result.contains_key(HOST));
        assert_eq!(
            result.get(ORIGIN).unwrap(),
            &HeaderValue::from_static("https://ai.example.test")
        );
        assert_eq!(
            result.get(COOKIE).unwrap(),
            &HeaderValue::from_static("theme=dark; __Host-garden_session=private-value")
        );
    }

    /*
     * The Devices list is also the revoke-a-session control, and before this the packaged desktop
     * app and the owner's real Safari produced the same label from the same User-Agent.
     */
    #[test]
    fn stamps_this_client_on_every_request_the_gateway_forwards() {
        let mut input = HeaderMap::new();
        input.insert(ORIGIN, HeaderValue::from_static("http://localhost:41000"));
        input.insert(
            HeaderName::from_static(CLIENT_HEADER),
            HeaderValue::from_static("garden-macos/999.999.999"),
        );
        let result = forwarded_headers(&input, "https://ai.example.test");
        let stamped = result.get(CLIENT_HEADER).unwrap().to_str().unwrap();
        assert_eq!(stamped, CLIENT_IDENTITY);
        assert!(stamped.starts_with("garden-"));
        assert!(stamped.ends_with(concat!("/", env!("CARGO_PKG_VERSION"))));
        // Insert, not append: a page that stamped its own value must not reach the box with two.
        assert_eq!(result.get_all(CLIENT_HEADER).iter().count(), 1);
        assert!(
            forwarded_headers(&HeaderMap::new(), "https://ai.example.test")
                .contains_key(CLIENT_HEADER)
        );
    }

    /*
     * The fallback carries every navigation, and a browser sends no Origin on those, so the
     * question the gateway can ask is the upstream's own: present, and not ours.
     */
    #[test]
    fn refuses_only_a_request_that_names_a_different_origin() {
        let local = "http://localhost:41000";
        let mut absent = HeaderMap::new();
        absent.insert(HOST, HeaderValue::from_static("localhost:41000"));
        assert!(!is_foreign_origin(&absent, local));
        let mut ours = HeaderMap::new();
        ours.insert(ORIGIN, HeaderValue::from_static("http://localhost:41000"));
        assert!(!is_foreign_origin(&ours, local));
        for value in [
            "https://attacker.test",
            "null",
            "http://localhost:41001",
            "http://127.0.0.1:41000",
        ] {
            let mut foreign = HeaderMap::new();
            foreign.insert(ORIGIN, HeaderValue::from_str(value).unwrap());
            assert!(is_foreign_origin(&foreign, local), "{value}");
        }
    }

    /*
     * DNS rebinding: the attacker's hostname resolves to 127.0.0.1, the page's fetch is
     * same-origin, and no Origin header is sent. The Host header is the only thing that still
     * knows which name the request was addressed to.
     */
    #[test]
    fn answers_only_when_addressed_as_this_loopback_gateway() {
        for value in ["localhost:41000", "127.0.0.1:41000", "[::1]:41000"] {
            assert!(is_this_gateway_authority(value, 41_000), "{value}");
        }
        for value in [
            "rebound.attacker.test:41000",
            "localhost:41001",
            "localhost",
            "127.0.0.1",
            "localhost:41000.attacker.test",
            "attacker.test",
            "[::1]",
        ] {
            assert!(!is_this_gateway_authority(value, 41_000), "{value}");
        }
    }

    #[test]
    fn translates_the_secure_server_session_for_the_loopback_origin() {
        assert_eq!(
            local_set_cookie(
                "__Host-garden_session=private-value; Path=/; HttpOnly; Secure; SameSite=Lax"
            )
            .unwrap(),
            HeaderValue::from_static(
                "garden_native_session=private-value; Path=/; HttpOnly; SameSite=Lax"
            )
        );
        assert!(local_set_cookie("unrelated=value; Secure").is_none());
    }

    #[test]
    fn native_preview_ancestor_mapping_preserves_other_policy_authority() {
        let trusted = "https://example.test";
        let local = "http://localhost:41000";
        let cases = [
            ("frame-ancestors https://example.test", "frame-ancestors http://localhost:41000"),
            ("sandbox allow-scripts; frame-ancestors  https://example.test 'self'; object-src 'none'", "sandbox allow-scripts; frame-ancestors  http://localhost:41000 'self'; object-src 'none'"),
            ("frame-ancestors https://example.test.evil https://example.test:8443 https://example.test/path", "frame-ancestors https://example.test.evil https://example.test:8443 https://example.test/path"),
            ("connect-src https://example.test; sandbox allow-scripts, frame-ancestors https://example.test", "connect-src https://example.test; sandbox allow-scripts, frame-ancestors http://localhost:41000"),
            ("frame-ancestors 'none'; sandbox allow-scripts", "frame-ancestors 'none'; sandbox allow-scripts"),
        ];
        assert!(!cases.is_empty());
        for (raw, expected) in cases {
            assert_eq!(native_preview_policy(raw, trusted, local), expected);
        }
    }

    #[test]
    fn native_preview_browser_open_is_scoped_and_preserves_signed_url() {
        let owner = "https://garden.test";
        let preview = "https://garden.test:8443";
        let path = "/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
        let raw = format!("{preview}{path}?access=fixture%2Fsigned%3D&next=%2Findex.html#scene");
        assert_eq!(
            checked_preview_browser_url(&raw, owner, Some(preview)).unwrap(),
            raw
        );
        assert!(
            checked_preview_browser_url(&format!("{owner}{path}?access=old"), owner, None).is_ok()
        );
        let denied = [
            format!("https://garden.test.evil{path}"),
            format!("https://other.test{path}"),
            format!("http://localhost:41001{path}"),
            format!("https://name@garden.test{path}"),
            format!("{owner}/v1/bootstrap"),
            "file:///etc/passwd".into(),
            "javascript:alert(1)".into(),
        ];
        assert!(!denied.is_empty());
        for raw in denied {
            assert!(
                checked_preview_browser_url(&raw, owner, Some(preview)).is_err(),
                "{raw}"
            );
        }
        assert!(checked_preview_browser_url(&raw, owner, None).is_err());
    }

    #[test]
    fn native_preview_redirects_match_exact_parsed_origins() {
        let endpoints = vec!["https://example.test".to_owned()];
        let local = "http://localhost:41000";
        assert_eq!(
            native_location(
                "https://EXAMPLE.test:443/a%2Fb?q=1#result",
                &endpoints,
                local
            )
            .as_deref(),
            Some("http://localhost:41000/a%2Fb?q=1#result")
        );
        let denied = [
            "https://example.test:8443/a",
            "https://example.test.evil/a",
            "https://example.test@evil.test/a",
            "https://name@example.test/a",
            "http://example.test/a",
            "/relative",
            "//example.test/a",
        ];
        assert!(!denied.is_empty());
        for address in denied {
            assert!(
                native_location(address, &endpoints, local).is_none(),
                "{address}"
            );
        }
    }

    #[tokio::test]
    async fn native_preview_response_preserves_duplicate_sandbox_headers() {
        let profile = test_profile();
        let active = ActiveServer {
            http: reqwest::Client::new(),
            websocket_tls: Arc::new(pinned_tls_config(&profile.identity).unwrap()),
            profile,
        };
        let sandbox = "sandbox allow-scripts allow-forms allow-popups allow-downloads allow-modals";
        let upstream = || {
            reqwest::Response::from(axum::http::Response::builder()
            .header("content-security-policy", sandbox)
            .header("content-security-policy", "frame-ancestors https://example.test")
            .header("x-garden-native-client", "forged")
            .header("x-garden-server-origin", "https://outside.test")
            .header("location", "https://example.test:8443/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")
            .body("preview bytes").unwrap())
        };
        let result = upstream_response(
            upstream(),
            &active,
            "http://localhost:41000",
            "/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.html",
            None,
            "http://localhost:41001",
        );
        let csp = result
            .headers()
            .get_all("content-security-policy")
            .iter()
            .map(|value| value.to_str().unwrap().to_owned())
            .collect::<Vec<_>>();
        assert_eq!(csp, vec![sandbox, "frame-ancestors http://localhost:41000"]);
        assert_eq!(
            result
                .headers()
                .get_all("x-garden-native-client")
                .iter()
                .count(),
            1
        );
        assert_eq!(result.headers()["x-garden-native-client"], "1");
        assert_eq!(
            result.headers()["x-garden-server-origin"],
            "https://example.test"
        );
        assert_eq!(
            result.headers()[LOCATION],
            "https://example.test:8443/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"
        );
        assert_eq!(
            to_bytes(result.into_body(), 1024).await.unwrap().as_ref(),
            b"preview bytes"
        );
        let denied_paths = [
            "/v1/share",
            "/__garden/preview/other/",
            "/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-extra/",
        ];
        assert!(!denied_paths.is_empty());
        for path in denied_paths {
            let ordinary = upstream_response(
                upstream(),
                &active,
                "http://localhost:41000",
                path,
                None,
                "http://localhost:41001",
            );
            assert_eq!(
                ordinary
                    .headers()
                    .get_all("content-security-policy")
                    .iter()
                    .map(|value| value.to_str().unwrap())
                    .collect::<Vec<_>>(),
                vec![sandbox, "frame-ancestors https://example.test"]
            );
        }
        if let Ok(destination) = std::env::var("GARDEN_PREVIEW_HEADER_EVIDENCE") {
            std::fs::write(
                destination,
                serde_json::to_vec_pretty(&serde_json::json!({"csp":csp})).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn streams_large_or_unknown_mutations_instead_of_rejecting_them() {
        let mut idempotent = HeaderMap::new();
        idempotent.insert("idempotency-key", HeaderValue::from_static("operation-1"));
        assert!(should_buffer_for_retry(
            &Method::PUT,
            &idempotent,
            Some(1024)
        ));
        assert!(!should_buffer_for_retry(
            &Method::PUT,
            &idempotent,
            Some(RETRYABLE_BODY_LIMIT + 1)
        ));
        assert!(!should_buffer_for_retry(&Method::PUT, &idempotent, None));
        assert!(should_buffer_for_retry(
            &Method::GET,
            &HeaderMap::new(),
            None
        ));
    }

    #[test]
    fn carries_a_text_frame_both_ways_across_the_bridge_intact() {
        let original = "a streamed token — multi-byte, and \"quoted\"";
        let outbound: tokio_tungstenite::tungstenite::Utf8Bytes =
            relay_text(BrowserMessage::Text(original.into()).into_text().unwrap()).unwrap();
        assert_eq!(outbound.as_str(), original);
        let inbound: axum::extract::ws::Utf8Bytes = relay_text(outbound).unwrap();
        assert_eq!(inbound.as_str(), original);
    }

    #[test]
    fn escapes_connection_errors_in_the_local_onboarding_page() {
        let page = offline_page(
            "<script>alert(\"x\")</script>",
            Some(NetworkPreference::Unknown),
            "http://localhost:49123",
        );
        assert!(!page.contains("<script>alert"));
        assert!(page.contains("&lt;script&gt;"));
        assert!(page.contains("Did the server's public address change?"));
        assert!(page.contains("http://localhost:49123"));
        assert!(!offline_page(
            "offline",
            Some(NetworkPreference::Fixed),
            "http://localhost:49123"
        )
        .contains("public address change"));
        assert!(!offline_page("", None, "http://localhost:49123").contains("public address change"));
    }

    #[tokio::test]
    async fn loads_pending_pairing_only_from_the_explicit_cache_path() {
        let directory =
            std::env::temp_dir().join(format!("garden-pairing-cache-{}", uuid::Uuid::new_v4()));
        let data_directory = directory.join("data");
        let cache_directory = directory.join("cache");
        let profile_path = data_directory.join("server-profile.json");
        let pending_path = cache_directory.join("pending-pairing.json");
        save_pending_pairing(
            &pending_path,
            "temporary-pairing-code-1234567890".into(),
            u64::MAX,
        )
        .unwrap();

        let state = ClientState::load(profile_path.clone(), pending_path.clone()).unwrap();
        assert_eq!(
            state
                .pairing_code
                .read()
                .await
                .as_ref()
                .map(|pending| pending.pairing_code.as_str()),
            Some("temporary-pairing-code-1234567890")
        );
        assert!(!profile_path.with_file_name("pending-pairing.json").exists());
        assert!(pending_path.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    pub(super) fn test_profile() -> ServerProfile {
        ServerProfile {
            version: 1,
            identity: format!(
                "sha256/{}",
                base64::engine::general_purpose::STANDARD.encode([7_u8; 32])
            ),
            endpoints: vec!["https://example.test".into()],
            discovery: Discovery {
                mdns_service: "_garden._tcp.local".into(),
                mdns_port: 443,
            },
            last_endpoint: None,
            network_preference: NetworkPreference::Unknown,
        }
    }

    /*
     * There was no way to disconnect a device from its box. `import` could replace a profile;
     * nothing could remove one, and the only pairing door renders when the connection is already
     * broken. The pairing code goes with the profile: it is the registration secret for the box
     * being forgotten.
     */
    #[tokio::test]
    async fn forgetting_a_server_removes_the_profile_and_the_pairing_code_it_came_with() {
        let directory =
            std::env::temp_dir().join(format!("garden-forget-{}", uuid::Uuid::new_v4()));
        let profile_path = directory.join("server-profile.json");
        let pending_path = directory.join("pending-pairing.json");
        save_profile(&profile_path, &test_profile()).unwrap();
        save_pending_pairing(
            &pending_path,
            "temporary-pairing-code-1234567890".into(),
            u64::MAX,
        )
        .unwrap();

        let state = ClientState::load(profile_path.clone(), pending_path.clone()).unwrap();
        assert!(state.profile.read().await.is_some());
        state.forget().await.unwrap();

        assert!(!profile_path.exists());
        assert!(!pending_path.exists());
        assert!(state.profile.read().await.is_none());
        assert!(state.pairing_code.read().await.is_none());
        // Idempotent: the offline page can be reloaded, and a second disconnect is not an error.
        state.forget().await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    /*
     * `error` shipped hardcoded to `None` with no code path able to set it, so the one route that
     * can tell a packaged owner why their box is unreachable always said nothing.
     */
    #[tokio::test]
    async fn the_status_route_reports_why_the_connection_is_down() {
        let directory =
            std::env::temp_dir().join(format!("garden-status-{}", uuid::Uuid::new_v4()));
        let profile_path = directory.join("server-profile.json");
        save_profile(&profile_path, &test_profile()).unwrap();
        let state =
            ClientState::load(profile_path, directory.join("pending-pairing.json")).unwrap();

        let unexplained = client_status(State(state.clone())).await;
        assert!(unexplained.configured);
        assert!(!unexplained.connected);
        assert!(unexplained.error.is_none());
        assert_eq!(
            unexplained.network_preference,
            Some(NetworkPreference::Unknown)
        );
        assert_eq!(unexplained.app_version, env!("CARGO_PKG_VERSION"));

        *state.last_error.write().await = Some("No saved address could prove the identity".into());
        let explained = client_status(State(state.clone())).await;
        assert_eq!(
            explained.error.as_deref(),
            Some("No saved address could prove the identity")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    /*
     * Both guards, on a gateway that is actually listening, with no server behind it.
     *
     * A rebound name and a foreign origin are both refused before any of the work a real request
     * would do - which is the point: neither check may depend on the box being reachable, and
     * neither may cost the app a round trip when it is not.
     */
    #[tokio::test]
    async fn the_running_gateway_answers_only_its_own_name_and_its_own_origin() {
        let directory =
            std::env::temp_dir().join(format!("garden-gateway-guard-{}", uuid::Uuid::new_v4()));
        let profile_path = directory.join("server-profile.json");
        save_profile(&profile_path, &test_profile()).unwrap();
        let state =
            ClientState::load(profile_path, directory.join("pending-pairing.json")).unwrap();
        let origin = start(state).await.unwrap();
        let port = origin.rsplit(':').next().unwrap().to_owned();
        let client = reqwest::Client::new();

        let allowed = client
            .get(format!("{origin}/__garden/client/status"))
            .send()
            .await
            .unwrap();
        assert_eq!(allowed.status(), reqwest::StatusCode::OK);

        // DNS rebinding: the page's own hostname, resolved to 127.0.0.1 by the attacker's DNS.
        let rebound = client
            .get(format!("{origin}/__garden/client/bootstrap"))
            .header(HOST, format!("rebound.attacker.test:{port}"))
            .send()
            .await
            .unwrap();
        assert_eq!(rebound.status(), reqwest::StatusCode::MISDIRECTED_REQUEST);

        // A page on another origin, reaching the proxied API with the session cookie it cannot
        // read. Refused here, where the true origin is still known - `forwarded_headers` would
        // otherwise overwrite it with the box's own before the upstream check ever saw it.
        let foreign = client
            .get(format!("{origin}/v1/tasks"))
            .header(ORIGIN, "https://attacker.test")
            .send()
            .await
            .unwrap();
        assert_eq!(foreign.status(), reqwest::StatusCode::FORBIDDEN);

        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn proxies_the_live_pinned_server_when_explicitly_requested() {
        let Ok(path) = std::env::var("GARDEN_LIVE_MANIFEST") else {
            return;
        };
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct LiveManifest {
            identity: String,
            endpoints: Vec<String>,
            discovery: Discovery,
        }
        let manifest: LiveManifest = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let directory =
            std::env::temp_dir().join(format!("garden-live-proxy-{}", uuid::Uuid::new_v4()));
        let profile_path = directory.join("server-profile.json");
        save_profile(
            &profile_path,
            &ServerProfile {
                version: 1,
                identity: manifest.identity,
                endpoints: manifest.endpoints,
                discovery: manifest.discovery,
                last_endpoint: None,
                network_preference: NetworkPreference::Unknown,
            },
        )
        .unwrap();
        let state =
            ClientState::load(profile_path, directory.join("pending-pairing.json")).unwrap();
        let origin = start(state).await.unwrap();
        let response = reqwest::Client::new()
            .get(format!("{origin}/healthz"))
            .send()
            .await
            .unwrap();
        assert!(response.status().is_success());
        assert_eq!(
            response
                .headers()
                .get("x-garden-native-client")
                .and_then(|value| value.to_str().ok()),
            Some("1")
        );
        std::fs::remove_dir_all(directory).unwrap();
    }
}
