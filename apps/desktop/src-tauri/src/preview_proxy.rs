//! A separate browser origin for generated applications. Only a pinned bootstrap response can
//! configure its upstream; sharing a cookie site with the native shell does not share API authority.
use super::*;
use url::Url;

const REMOTE_COOKIE: &str = "__Secure-garden-preview-access";
const LOCAL_COOKIE: &str = "garden_native_preview_access";
const BASE_PATH: &str = "/__garden/preview";

#[derive(Default)]
pub(super) struct PreviewState {
    pub origin: RwLock<String>,
    target: RwLock<Option<Target>>,
}
#[derive(Clone)]
struct Target {
    identity: String,
    owner: String,
    remote: Url,
    relay: Option<Url>,
}
#[derive(Clone)]
pub(super) struct Connection {
    pub remote: Url,
    pub local: String,
    relay: Option<Url>,
}

pub(super) async fn start(state: Arc<ClientState>) -> Result<(), String> {
    let port_path = state.profile_path.with_file_name("preview-gateway-port");
    let remembered = std::fs::read_to_string(&port_path)
        .ok()
        .and_then(|value| value.trim().parse::<u16>().ok())
        .filter(|port| *port != 0);
    let listener = match remembered {
        Some(port) => match TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await {
            Ok(listener) => listener,
            Err(_) => TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|error| error.to_string())?,
        },
        None => TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .map_err(|error| error.to_string())?,
    };
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let _ = write_private_port(&port_path, port);
    *state.preview.origin.write().await = format!("http://localhost:{port}");
    let router = Router::new()
        .fallback(serve)
        .with_state(state)
        .layer(middleware::from_fn_with_state(port, only_this_gateway));
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router).await {
            eprintln!("garden private preview gateway stopped: {error}");
        }
    });
    Ok(())
}

fn checked_target(value: &str, owner: &str) -> Option<Url> {
    let target = Url::parse(value).ok()?;
    let owner = Url::parse(owner).ok()?;
    (target.scheme() == "https"
        && target.origin() != owner.origin()
        && target.username().is_empty()
        && target.password().is_none()
        && target.path().trim_end_matches('/') == BASE_PATH
        && target.query().is_none()
        && target.fragment().is_none())
    .then_some(target)
}

fn checked_relay(value: &str) -> Option<Url> {
    let relay = Url::parse(value).ok()?;
    (relay.scheme() == "https"
        && relay.origin().ascii_serialization() == value
        && relay.username().is_empty()
        && relay.password().is_none()
        && relay.query().is_none()
        && relay.fragment().is_none())
    .then_some(relay)
}

pub(super) async fn observe(
    state: &ClientState,
    active: &ActiveServer,
    path: &str,
    method: &Method,
    response: &reqwest::Response,
) {
    if path != "/v1/bootstrap" || *method != Method::GET || !response.status().is_success() {
        return;
    }
    let owner = canonical_origin(active);
    let target = response
        .headers()
        .get("x-garden-preview-base-url")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| checked_target(value, owner));
    let relay = response
        .headers()
        .get("x-garden-relay-preview-origin")
        .and_then(|value| value.to_str().ok())
        .and_then(checked_relay);
    *state.preview.target.write().await = target.map(|remote| Target {
        identity: active.profile.identity.clone(),
        owner: owner.to_owned(),
        remote,
        relay,
    });
}

pub(super) async fn connection(state: &ClientState, active: &ActiveServer) -> Option<Connection> {
    let target = state.preview.target.read().await.clone()?;
    if target.identity != active.profile.identity || target.owner != canonical_origin(active) {
        return None;
    }
    Some(Connection {
        remote: target.remote,
        relay: target.relay,
        local: state.preview.origin.read().await.clone(),
    })
}

/// Augment only the frame source list, including each independently enforced CSP policy.
pub(super) fn app_policy(raw: &str, local: &str) -> String {
    raw.split(',')
        .map(|policy| {
            let mut found = false;
            let mut mapped = policy
                .split(';')
                .map(|directive| {
                    if directive
                        .split_ascii_whitespace()
                        .next()
                        .is_some_and(|name| name.eq_ignore_ascii_case("frame-src"))
                    {
                        found = true;
                        // 'none' has no effect alongside a source; removing it avoids a browser warning.
                        let parts = directive
                            .split_ascii_whitespace()
                            .filter(|part| *part != "'none'")
                            .collect::<Vec<_>>();
                        format!("{} {local}", parts.join(" "))
                    } else {
                        directive.to_owned()
                    }
                })
                .collect::<Vec<_>>()
                .join(";");
            if !found {
                mapped.push_str(&format!("; frame-src 'self' {local}"));
            }
            mapped
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn target_url(connection: &Connection, path_and_query: &str) -> Option<Url> {
    if !path_and_query.starts_with('/') || path_and_query.starts_with("//") {
        return None;
    }
    let target = connection.remote.join(path_and_query).ok()?;
    (target.origin() == connection.remote.origin()
        && is_preview_path(target.path())
        && !target.path().contains('\\'))
    .then_some(target)
}

// Discovery changes transport, never the configured HTTP origin or the pinned box identity.
fn transport_url(active: &ActiveServer, connection: &Connection, canonical: &Url) -> Option<Url> {
    let owner = Url::parse(canonical_origin(active)).ok()?;
    let endpoint = Url::parse(
        active
            .profile
            .last_endpoint
            .as_deref()
            .unwrap_or(canonical_origin(active)),
    )
    .ok()?;
    let mut transport = canonical.clone();
    if canonical.host_str() == owner.host_str() && endpoint.host_str() != owner.host_str() {
        if endpoint.scheme() != "https"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
        {
            return None;
        }
        transport.set_host(endpoint.host_str()).ok()?;
        if let Some(relay) = connection
            .relay
            .as_ref()
            .filter(|relay| relay.host_str() == endpoint.host_str())
        {
            transport.set_port(relay.port()).ok()?;
        }
    }
    Some(transport)
}

fn owner_cookie(name: &str) -> bool {
    matches!(
        name,
        LOCAL_SESSION_COOKIE | SERVER_SESSION_COOKIE | "garden_session"
    )
}

fn request_headers(input: &HeaderMap, remote: &Url) -> HeaderMap {
    let mut output = HeaderMap::new();
    for (name, value) in input {
        if is_hop_by_hop(name)
            || matches!(
                name.as_str(),
                "host" | "content-length" | "authorization" | "cookie" | "origin" | "referer"
            )
            || name.as_str().starts_with("x-garden-")
            || name.as_str().starts_with("x-forwarded-")
            || name.as_str() == "forwarded"
        {
            continue;
        }
        output.append(name.clone(), value.clone());
    }
    output.insert(
        HOST,
        HeaderValue::from_str(&remote[url::Position::BeforeHost..url::Position::AfterPort])
            .unwrap(),
    );
    let cookies = input
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|cookie| {
            let (name, value) = cookie.trim().split_once('=')?;
            if owner_cookie(name) || name == REMOTE_COOKIE {
                return None;
            }
            Some(format!(
                "{}={value}",
                if name == LOCAL_COOKIE {
                    REMOTE_COOKIE
                } else {
                    name
                }
            ))
        })
        .collect::<Vec<_>>()
        .join("; ");
    if !cookies.is_empty() {
        if let Ok(value) = HeaderValue::from_str(&cookies) {
            output.insert(COOKIE, value);
        }
    }
    if input.contains_key(ORIGIN) {
        output.insert(
            ORIGIN,
            HeaderValue::from_str(&remote.origin().ascii_serialization()).unwrap(),
        );
    }
    if input.contains_key(REFERER) {
        output.insert(REFERER, HeaderValue::from_str(remote.as_str()).unwrap());
    }
    output
}

fn response_cookie(raw: &str) -> Option<HeaderValue> {
    let (first, attributes) = raw.split_once(';').unwrap_or((raw, ""));
    let (name, value) = first.split_once('=')?;
    if owner_cookie(name.trim()) || name.trim() == LOCAL_COOKIE {
        return None;
    }
    let translated = name == REMOTE_COOKIE;
    let mut result = format!("{}={value}", if translated { LOCAL_COOKIE } else { name });
    for attribute in attributes
        .split(';')
        .map(str::trim)
        .filter(|attribute| !attribute.is_empty())
    {
        if attribute.to_ascii_lowercase().starts_with("domain=")
            || (translated && attribute.eq_ignore_ascii_case("secure"))
        {
            continue;
        }
        result.push_str("; ");
        result.push_str(attribute);
    }
    HeaderValue::from_str(&result).ok()
}

fn local_location(raw: &str, connection: &Connection) -> Option<String> {
    let target = connection.remote.join(raw).ok()?;
    if target.origin() != connection.remote.origin()
        || !is_preview_path(target.path())
        || !target.username().is_empty()
        || target.password().is_some()
    {
        return None;
    }
    native_location(
        target.as_str(),
        &[connection.remote.origin().ascii_serialization()],
        &connection.local,
    )
}

fn response(
    upstream: reqwest::Response,
    connection: &Connection,
    owner: &str,
    local_owner: &str,
) -> Response {
    let mut builder = Response::builder().status(upstream.status());
    if let Some(headers) = builder.headers_mut() {
        for (name, value) in upstream.headers() {
            if is_hop_by_hop(name)
                || name == CONTENT_LENGTH
                || name.as_str().starts_with("x-garden-")
            {
                continue;
            }
            if name == SET_COOKIE {
                if let Some(cookie) = value.to_str().ok().and_then(response_cookie) {
                    headers.append(name.clone(), cookie);
                }
                continue;
            }
            if name.as_str() == "content-security-policy" {
                if let Some(mapped) = value.to_str().ok().and_then(|raw| {
                    HeaderValue::from_str(&native_preview_policy(raw, owner, local_owner)).ok()
                }) {
                    headers.append(name.clone(), mapped);
                    continue;
                }
            }
            if name == LOCATION {
                if let Some(mapped) = value
                    .to_str()
                    .ok()
                    .and_then(|raw| local_location(raw, connection))
                    .and_then(|raw| HeaderValue::from_str(&raw).ok())
                {
                    headers.append(name.clone(), mapped);
                    continue;
                }
            }
            headers.append(name.clone(), value.clone());
        }
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

async fn serve(State(state): State<Arc<ClientState>>, request: Request) -> Response {
    if !is_preview_path(request.uri().path()) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let local_owner = state.local_origin().await;
    let local_preview = state.preview.origin.read().await.clone();
    if request
        .headers()
        .get(ORIGIN)
        .is_some_and(|origin| origin != local_owner.as_str() && origin != local_preview.as_str())
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let active = match state.current().await {
        Ok(active) => active,
        Err(_) => return StatusCode::SERVICE_UNAVAILABLE.into_response(),
    };
    let Some(connection) = connection(&state, &active).await else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "Open garden to verify this server's isolated preview address.",
        )
            .into_response();
    };
    let path = request
        .uri()
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or("");
    let Some(target) = target_url(&connection, path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if request
        .headers()
        .get(UPGRADE)
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"))
    {
        return websocket(request, &active, &connection, target).await;
    }
    let Some(transport) = transport_url(&active, &connection, &target) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let (parts, body) = request.into_parts();
    match active
        .http
        .request(parts.method, transport)
        .headers(request_headers(&parts.headers, &target))
        .body(reqwest::Body::wrap_stream(body.into_data_stream()))
        .send()
        .await
    {
        Ok(upstream) => response(
            upstream,
            &connection,
            canonical_origin(&active),
            &local_owner,
        ),
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            "The pinned preview server is unavailable.",
        )
            .into_response(),
    }
}

async fn websocket(
    request: Request,
    active: &ActiveServer,
    connection: &Connection,
    target: Url,
) -> Response {
    let (mut parts, _) = request.into_parts();
    let browser = match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
        Ok(value) => value,
        Err(error) => return error.into_response(),
    };
    let Some(mut websocket_url) = transport_url(active, connection, &target) else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let _ = websocket_url.set_scheme("wss");
    let Ok(mut outgoing) = websocket_url.as_str().into_client_request() else {
        return StatusCode::BAD_GATEWAY.into_response();
    };
    let forwarded = request_headers(&parts.headers, &target);
    for name in [
        HOST,
        COOKIE,
        ORIGIN,
        HeaderName::from_static("sec-websocket-protocol"),
        HeaderName::from_static("user-agent"),
    ] {
        if let Some(value) = forwarded.get(&name) {
            outgoing.headers_mut().insert(name, value.clone());
        }
    }
    // Connect before accepting so the browser sees only a protocol actually selected upstream.
    match connect_async_tls_with_config(
        outgoing,
        None,
        true,
        Some(Connector::Rustls(active.websocket_tls.clone())),
    )
    .await
    {
        Ok((server, handshake)) => {
            let browser = match handshake
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
            {
                Some(protocol) => browser.protocols([protocol.to_owned()]),
                None => browser,
            };
            browser.on_upgrade(move |browser| async move {
                let _ = relay_websocket_streams(browser, server).await;
            })
        }
        Err(_) => StatusCode::BAD_GATEWAY.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const OWNER: &str = "https://garden.test";
    const PREVIEW: &str = "https://garden.test:8443/__garden/preview";
    const SLUG_PATH: &str = "/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/";
    fn connection_fixture() -> Connection {
        Connection {
            remote: Url::parse(PREVIEW).unwrap(),
            local: "http://localhost:41001".into(),
            relay: None,
        }
    }

    #[tokio::test]
    #[ignore = "Launch with the bounded synthetic TLS/browser fixture; never uses an owner profile"]
    async fn native_preview_browser_gateway_fixture() {
        let directory = PathBuf::from(
            std::env::var("GARDEN_PREVIEW_FIXTURE").expect("synthetic fixture directory"),
        );
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("fixture.json")).unwrap())
                .unwrap();
        let mut profile = super::super::tests::test_profile();
        profile.identity = config["identity"].as_str().unwrap().to_owned();
        profile.endpoints = vec![config["owner"].as_str().unwrap().to_owned()];
        profile.last_endpoint = Some(
            config["selected"]
                .as_str()
                .unwrap_or(&profile.endpoints[0])
                .to_owned(),
        );
        let state =
            ClientState::load(directory.join("profile"), directory.join("pairing")).unwrap();
        let mut tls = pinned_tls_config(&profile.identity).unwrap();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        *state.active.write().await = Some(ActiveServer {
            http: pinned_http_client(&profile.identity, None).unwrap(),
            websocket_tls: Arc::new(tls),
            profile,
        });
        let owner = super::super::start(state.clone()).await.unwrap();
        std::fs::write(directory.join("ready.json"), serde_json::to_vec(&serde_json::json!({"owner":owner,"preview":state.preview.origin.read().await.clone()})).unwrap()).unwrap();
        for _ in 0..1200 {
            if directory.join("stop").exists() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        panic!("Synthetic browser fixture did not finish within its bound");
    }

    #[test]
    fn native_preview_relay_transport_preserves_canonical_authority() {
        let mut profile = super::super::tests::test_profile();
        profile.endpoints[0] = OWNER.into();
        profile.last_endpoint = Some("https://box.relay.test".into());
        let active = ActiveServer {
            http: reqwest::Client::new(),
            websocket_tls: Arc::new(pinned_tls_config(&profile.identity).unwrap()),
            profile,
        };
        let canonical =
            Url::parse(&format!("{PREVIEW}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/asset")).unwrap();
        let transport = transport_url(&active, &connection_fixture(), &canonical).unwrap();
        assert_eq!(
            transport.origin().ascii_serialization(),
            "https://box.relay.test:8443"
        );
        assert_eq!(transport.path(), canonical.path());
        let headers = request_headers(&HeaderMap::new(), &canonical);
        assert_eq!(headers.get(HOST).unwrap(), "garden.test:8443");
        let distinct = Url::parse(
            "https://apps.test:8443/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        )
        .unwrap();
        assert_eq!(
            transport_url(&active, &connection_fixture(), &distinct).unwrap(),
            distinct
        );
    }

    #[test]
    fn native_preview_negotiated_relay_port_is_scoped_to_selected_hostname() {
        let mut profile = super::super::tests::test_profile();
        profile.endpoints[0] = OWNER.into();
        profile.last_endpoint = Some("https://box.relay.test".into());
        let mut active = ActiveServer {
            http: reqwest::Client::new(),
            websocket_tls: Arc::new(pinned_tls_config(&profile.identity).unwrap()),
            profile,
        };
        let canonical = Url::parse(
            "https://garden.test:9443/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
        )
        .unwrap();
        let mut connection = connection_fixture();
        connection.relay = checked_relay("https://box.relay.test:18443");
        assert!(connection.relay.is_some());
        assert_eq!(
            transport_url(&active, &connection, &canonical)
                .unwrap()
                .origin()
                .ascii_serialization(),
            "https://box.relay.test:18443"
        );
        assert_eq!(
            request_headers(&HeaderMap::new(), &canonical)
                .get(HOST)
                .unwrap(),
            "garden.test:9443"
        );
        active.profile.last_endpoint = Some("https://192.0.2.8".into());
        assert_eq!(
            transport_url(&active, &connection, &canonical)
                .unwrap()
                .origin()
                .ascii_serialization(),
            "https://192.0.2.8:9443"
        );
        active.profile.last_endpoint = Some("https://unrelated.relay.test".into());
        assert_eq!(
            transport_url(&active, &connection, &canonical)
                .unwrap()
                .origin()
                .ascii_serialization(),
            "https://unrelated.relay.test:9443"
        );
        for value in [
            "https://box.relay.test:18443/path",
            "https://box.relay.test:18443?query",
            "https://name@box.relay.test:18443",
            "http://box.relay.test:18443",
        ] {
            assert!(checked_relay(value).is_none());
        }
    }

    #[test]
    fn native_preview_configuration_and_routes_are_narrow() {
        assert!(checked_target(PREVIEW, OWNER).is_some());
        let denied = [
            OWNER.to_owned() + BASE_PATH,
            "http://garden.test:8443/__garden/preview".into(),
            "https://user@garden.test:8443/__garden/preview".into(),
            format!("{PREVIEW}?target=other"),
            format!("{PREVIEW}#part"),
            "https://garden.test:8443/v1".into(),
        ];
        assert!(!denied.is_empty());
        for value in denied {
            assert!(checked_target(&value, OWNER).is_none(), "{value}");
        }
        let connection = connection_fixture();
        assert_eq!(
            target_url(&connection, &(SLUG_PATH.to_owned() + "module.js?x=1"))
                .unwrap()
                .path(),
            &(SLUG_PATH.to_owned() + "module.js")
        );
        let denied_paths = [
            "/v1/bootstrap",
            "/",
            "/__garden/runner/",
            "/__garden/preview/invalid/",
            "//evil.test/path",
            "/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/../../v1/bootstrap",
            "/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/%2e%2e/%2e%2e/v1/bootstrap",
        ];
        assert!(!denied_paths.is_empty());
        for value in denied_paths {
            assert!(target_url(&connection, value).is_none(), "{value}");
        }
        assert!(local_location("https://garden.test/v1/bootstrap", &connection).is_none());
        assert!(local_location("https://garden.test:8443.evil.test/a", &connection).is_none());
        assert_eq!(
            local_location(SLUG_PATH, &connection).unwrap(),
            format!("{}{SLUG_PATH}", connection.local)
        );
    }

    #[test]
    fn native_preview_never_transports_owner_credentials() {
        let mut input = HeaderMap::new();
        input.insert(COOKIE, HeaderValue::from_static("garden_native_session=owner; __Host-garden_session=other; garden_session=dev; garden_native_preview_access=grant; theme=dark"));
        input.append(
            COOKIE,
            HeaderValue::from_static("__Secure-garden-preview-access=spoof; colour=green"),
        );
        input.insert("authorization", HeaderValue::from_static("Bearer owner"));
        input.insert("x-garden-client", HeaderValue::from_static("forged"));
        input.insert("x-forwarded-host", HeaderValue::from_static("garden.test"));
        input.insert(ORIGIN, HeaderValue::from_static("http://localhost:41001"));
        let headers = request_headers(&input, &Url::parse(PREVIEW).unwrap());
        assert_eq!(
            headers.get(COOKIE).unwrap(),
            "__Secure-garden-preview-access=grant; theme=dark; colour=green"
        );
        assert!(!headers.contains_key("authorization"));
        assert!(!headers.contains_key("x-garden-client"));
        assert!(!headers.contains_key("x-forwarded-host"));
        assert_eq!(headers.get(ORIGIN).unwrap(), "https://garden.test:8443");
        for name in [
            LOCAL_SESSION_COOKIE,
            SERVER_SESSION_COOKIE,
            "garden_session",
            LOCAL_COOKIE,
        ] {
            assert!(response_cookie(&format!("{name}=changed; Path=/; HttpOnly")).is_none());
        }
        assert_eq!(response_cookie("__Secure-garden-preview-access=grant; Path=/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; Secure; HttpOnly; SameSite=Lax; Domain=garden.test").unwrap(),
            "garden_native_preview_access=grant; Path=/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; HttpOnly; SameSite=Lax");
    }

    #[test]
    fn native_preview_app_policy_preserves_independent_restrictions() {
        assert_eq!(app_policy("default-src 'self'; frame-src https://garden.test:8443; script-src 'nonce-x'", "http://localhost:41001"),
            "default-src 'self';frame-src https://garden.test:8443 http://localhost:41001; script-src 'nonce-x'");
        assert_eq!(app_policy("default-src 'self', default-src 'none'; frame-src 'none'", "http://localhost:41001"),
            "default-src 'self'; frame-src 'self' http://localhost:41001, default-src 'none';frame-src http://localhost:41001");
    }

    #[tokio::test]
    async fn native_preview_metadata_is_bound_to_pinned_bootstrap_and_identity() {
        let temporary =
            std::env::temp_dir().join(format!("garden-preview-{}", uuid::Uuid::new_v4()));
        let state =
            ClientState::load(temporary.join("profile"), temporary.join("pairing")).unwrap();
        *state.preview.origin.write().await = "http://localhost:41001".into();
        let profile = super::super::tests::test_profile();
        let mut active = ActiveServer {
            http: reqwest::Client::new(),
            websocket_tls: Arc::new(pinned_tls_config(&profile.identity).unwrap()),
            profile,
        };
        let upstream = |status| {
            reqwest::Response::from(
                axum::http::Response::builder()
                    .status(status)
                    .header("x-garden-preview-base-url", PREVIEW)
                    .header(
                        "x-garden-relay-preview-origin",
                        "https://box.relay.test:18443",
                    )
                    .body("metadata")
                    .unwrap(),
            )
        };
        observe(
            &state,
            &active,
            "/v1/bootstrap",
            &Method::POST,
            &upstream(200),
        )
        .await;
        assert!(connection(&state, &active).await.is_none());
        observe(&state, &active, "/v1/tasks", &Method::GET, &upstream(200)).await;
        assert!(connection(&state, &active).await.is_none());
        observe(
            &state,
            &active,
            "/v1/bootstrap",
            &Method::GET,
            &upstream(401),
        )
        .await;
        assert!(connection(&state, &active).await.is_none());
        observe(
            &state,
            &active,
            "/v1/bootstrap",
            &Method::GET,
            &upstream(200),
        )
        .await;
        assert!(connection(&state, &active).await.is_some());
        assert_eq!(
            connection(&state, &active)
                .await
                .unwrap()
                .relay
                .unwrap()
                .origin()
                .ascii_serialization(),
            "https://box.relay.test:18443"
        );
        active.profile.identity.push('x');
        assert!(connection(&state, &active).await.is_none());
        active.profile.identity.pop();
        active.profile.endpoints[0] = "https://other.test".into();
        assert!(connection(&state, &active).await.is_none());
        active.profile.endpoints[0] = "https://example.test".into();
        observe(
            &state,
            &active,
            "/v1/bootstrap",
            &Method::GET,
            &reqwest::Response::from(axum::http::Response::builder().body("").unwrap()),
        )
        .await;
        assert!(connection(&state, &active).await.is_none());
    }

    #[tokio::test]
    async fn native_preview_bridge_preserves_response_security_and_streaming() {
        let connection = connection_fixture();
        let upstream = reqwest::Response::from(axum::http::Response::builder()
            .header("content-security-policy", format!("frame-ancestors {OWNER}; object-src 'none'"))
            .header("content-security-policy", "script-src 'self'; base-uri 'self'")
            .header("set-cookie", "__Secure-garden-preview-access=grant; Path=/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; HttpOnly; Secure; SameSite=Lax")
            .header("set-cookie", "garden_native_session=poison; Path=/")
            .header("x-garden-native-client", "1")
            .header("location", format!("https://garden.test:8443{SLUG_PATH}"))
            .body("module and asset bytes").unwrap());
        let response = response(upstream, &connection, OWNER, "http://localhost:41000");
        let policies = response
            .headers()
            .get_all("content-security-policy")
            .iter()
            .map(|value| value.to_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            policies,
            [
                "frame-ancestors http://localhost:41000; object-src 'none'",
                "script-src 'self'; base-uri 'self'"
            ]
        );
        assert_eq!(response.headers().get_all(SET_COOKIE).iter().count(), 1);
        assert!(!response.headers().contains_key("x-garden-native-client"));
        assert_eq!(
            response.headers().get(LOCATION).unwrap(),
            format!("http://localhost:41001{SLUG_PATH}").as_str()
        );
        assert_eq!(
            to_bytes(response.into_body(), 1000).await.unwrap(),
            "module and asset bytes"
        );
    }
}
