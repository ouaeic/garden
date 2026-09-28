use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use futures_util::{stream::FuturesUnordered, StreamExt};
use mdns_sd::{ServiceDaemon, ServiceEvent};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    crypto::{ring::default_provider, verify_tls12_signature, verify_tls13_signature},
    pki_types::{CertificateDer, ServerName, UnixTime},
    CertificateError, DigitallySignedStruct, Error as TlsError, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Write,
    net::IpAddr,
    path::Path,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use url::Url;

const MAX_TICKET_BYTES: usize = 32 * 1024;
const MAX_ENDPOINTS: usize = 16;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Discovery {
    pub mdns_service: String,
    pub mdns_port: u16,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PairingTicket {
    version: u8,
    endpoints: Vec<String>,
    identity: String,
    discovery: Discovery,
    pairing_code: String,
    expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerProfile {
    pub version: u8,
    pub identity: String,
    pub endpoints: Vec<String>,
    pub discovery: Discovery,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_endpoint: Option<String>,
    #[serde(default)]
    pub network_preference: NetworkPreference,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkPreference {
    #[default]
    Unknown,
    Dynamic,
    Fixed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImportedConnection {
    pub profile: ServerProfile,
    pub pairing_code: String,
    pub pairing_expires_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingPairing {
    version: u8,
    pub pairing_code: String,
    pub expires_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionManifest {
    version: u8,
    identity: String,
    endpoints: Vec<String>,
    discovery: Discovery,
}

fn canonical_endpoint(raw: &str) -> Result<String, String> {
    let parsed = Url::parse(raw).map_err(|_| "Connection endpoints must be valid HTTPS URLs")?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.host_str().is_none()
        || !matches!(parsed.port(), None | Some(443))
    {
        return Err(
            "Connection endpoints must be credential-free HTTPS origins on port 443".into(),
        );
    }
    Ok(parsed.origin().ascii_serialization())
}

fn validated_endpoints(values: Vec<String>) -> Result<Vec<String>, String> {
    if values.is_empty() || values.len() > MAX_ENDPOINTS {
        return Err(format!(
            "A connection ticket must contain 1-{MAX_ENDPOINTS} endpoints"
        ));
    }
    let mut seen = HashSet::new();
    let mut endpoints = Vec::new();
    for value in values {
        let endpoint = canonical_endpoint(&value)?;
        if seen.insert(endpoint.clone()) {
            endpoints.push(endpoint);
        }
    }
    if endpoints.is_empty() {
        return Err("A connection ticket did not contain a usable endpoint".into());
    }
    Ok(endpoints)
}

pub fn identity_digest(identity: &str) -> Result<[u8; 32], String> {
    let encoded = identity
        .strip_prefix("sha256/")
        .ok_or("Server identity must begin with sha256/")?;
    let decoded = STANDARD
        .decode(encoded)
        .map_err(|_| "Server identity is not valid base64")?;
    decoded
        .try_into()
        .map_err(|_| "Server identity must contain one SHA-256 digest".into())
}

fn validate_discovery(discovery: &Discovery) -> Result<(), String> {
    if discovery.mdns_service != "_garden._tcp.local" || discovery.mdns_port != 443 {
        return Err("The connection ticket contains unsupported discovery settings".into());
    }
    Ok(())
}

pub fn parse_pairing_uri(raw: &str, now: SystemTime) -> Result<ImportedConnection, String> {
    if raw.len() > MAX_TICKET_BYTES {
        return Err("The connection ticket is too large".into());
    }
    let parsed = Url::parse(raw.trim()).map_err(|_| "This is not a garden connection ticket")?;
    if !matches!(parsed.scheme(), "garden")
        || parsed.host_str() != Some("pair")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("This is not a garden connection ticket".into());
    }
    let encoded = parsed.path().strip_prefix('/').unwrap_or_default();
    if encoded.is_empty() || encoded.contains('/') {
        return Err("The garden connection ticket payload is missing".into());
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "The garden connection ticket is not valid base64url")?;
    if decoded.len() > MAX_TICKET_BYTES {
        return Err("The connection ticket is too large".into());
    }
    let ticket: PairingTicket =
        serde_json::from_slice(&decoded).map_err(|_| "The connection ticket is not valid JSON")?;
    if ticket.version != 2 {
        return Err("This client does not support that connection ticket version".into());
    }
    identity_digest(&ticket.identity)?;
    validate_discovery(&ticket.discovery)?;
    if ticket.pairing_code.len() < 20
        || ticket.pairing_code.len() > 128
        || !ticket
            .pairing_code
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_'))
    {
        return Err("The connection ticket contains an invalid pairing code".into());
    }
    let now = now
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is invalid")?
        .as_secs();
    if ticket.expires_at <= now {
        return Err("The one-time connection ticket has expired".into());
    }
    Ok(ImportedConnection {
        profile: ServerProfile {
            version: 1,
            identity: ticket.identity,
            endpoints: validated_endpoints(ticket.endpoints)?,
            discovery: ticket.discovery,
            last_endpoint: None,
            network_preference: NetworkPreference::Unknown,
        },
        pairing_code: ticket.pairing_code,
        pairing_expires_at: ticket.expires_at,
    })
}

fn unix_seconds(now: SystemTime) -> Result<u64, String> {
    now.duration_since(UNIX_EPOCH)
        .map_err(|_| "The system clock is invalid".into())
        .map(|duration| duration.as_secs())
}

fn valid_pairing_code(value: &str) -> bool {
    value.len() >= 20
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn save_private_json(path: &Path, bytes: &[u8], label: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("The {label} path has no parent directory"))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create the client data directory: {error}"))?;
    let temporary = parent.join(format!(
        ".{label}-{}.tmp",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Could not create the {label}: {error}"))?;
        file.write_all(bytes)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not save the {label}: {error}"))?;
        fs::rename(&temporary, path)
            .map_err(|error| format!("Could not activate the {label}: {error}"))?;
        #[cfg(unix)]
        fs::File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| format!("Could not make the {label} durable: {error}"))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn load_profile(path: &Path) -> Result<Option<ServerProfile>, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the server profile: {error}")),
    };
    let mut profile: ServerProfile =
        serde_json::from_slice(&contents).map_err(|_| "The saved server profile is invalid")?;
    if profile.version != 1 {
        return Err("The saved server profile version is not supported".into());
    }
    identity_digest(&profile.identity)?;
    validate_discovery(&profile.discovery)?;
    profile.endpoints = validated_endpoints(profile.endpoints)?;
    if let Some(value) = profile.last_endpoint.take() {
        let endpoint = canonical_endpoint(&value)?;
        if profile.endpoints.contains(&endpoint) {
            profile.last_endpoint = Some(endpoint);
        }
    }
    Ok(Some(profile))
}

pub fn save_profile(path: &Path, profile: &ServerProfile) -> Result<(), String> {
    let bytes =
        serde_json::to_vec_pretty(profile).map_err(|_| "Could not encode the server profile")?;
    save_private_json(path, &bytes, "server-profile")
}

pub fn load_pending_pairing(
    path: &Path,
    now: SystemTime,
) -> Result<Option<PendingPairing>, String> {
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read the pending pairing code: {error}")),
    };
    let pending: PendingPairing = serde_json::from_slice(&contents)
        .map_err(|_| "The saved pending pairing code is invalid")?;
    if pending.version != 1 || !valid_pairing_code(&pending.pairing_code) {
        return Err("The saved pending pairing code is invalid".into());
    }
    if pending.expires_at <= unix_seconds(now)? {
        clear_pending_pairing(path)?;
        return Ok(None);
    }
    Ok(Some(pending))
}

pub fn save_pending_pairing(
    path: &Path,
    pairing_code: String,
    expires_at: u64,
) -> Result<PendingPairing, String> {
    if !valid_pairing_code(&pairing_code) {
        return Err("The pending pairing code is invalid".into());
    }
    let pending = PendingPairing {
        version: 1,
        pairing_code,
        expires_at,
    };
    let bytes = serde_json::to_vec_pretty(&pending)
        .map_err(|_| "Could not encode the pending pairing code")?;
    save_private_json(path, &bytes, "pending-pairing")?;
    Ok(pending)
}

fn remove_private_json(path: &Path, label: &str) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => {
            #[cfg(unix)]
            if let Some(parent) = path.parent() {
                fs::File::open(parent)
                    .and_then(|directory| directory.sync_all())
                    .map_err(|error| {
                        format!("Could not make the {label} removal durable: {error}")
                    })?;
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Could not remove the {label}: {error}")),
    }
}

pub fn clear_pending_pairing(path: &Path) -> Result<(), String> {
    remove_private_json(path, "pending pairing code")
}

/*
 * Remove the saved server, durably.
 *
 * The counterpart `save_profile` never had: the file is the whole of this device's relationship
 * with a box, so forgetting a server has to survive the crash that follows it as reliably as
 * remembering one does - otherwise "disconnect" is a promise that a power cut can quietly revoke.
 */
pub fn forget_profile(path: &Path) -> Result<(), String> {
    remove_private_json(path, "server profile")
}

#[derive(Debug)]
struct PinnedServerVerifier {
    expected: [u8; 32],
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for PinnedServerVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, TlsError> {
        let spki = certificate_spki(end_entity.as_ref())
            .ok_or(TlsError::InvalidCertificate(CertificateError::BadEncoding))?;
        let actual: [u8; 32] = Sha256::digest(spki).into();
        if actual != self.expected {
            return Err(TlsError::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ));
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls12_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, TlsError> {
        verify_tls13_signature(
            message,
            cert,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

fn der_tlv(input: &[u8], offset: usize) -> Option<(u8, usize, usize)> {
    let tag = *input.get(offset)?;
    let first_length = *input.get(offset + 1)?;
    let (content, length) = if first_length & 0x80 == 0 {
        (offset.checked_add(2)?, first_length as usize)
    } else {
        let octets = (first_length & 0x7f) as usize;
        if octets == 0 || octets > std::mem::size_of::<usize>() {
            return None;
        }
        let mut length = 0usize;
        for byte in input.get(offset + 2..offset + 2 + octets)? {
            length = length.checked_mul(256)?.checked_add(*byte as usize)?;
        }
        (offset.checked_add(2 + octets)?, length)
    };
    let end = content.checked_add(length)?;
    if end > input.len() {
        return None;
    }
    Some((tag, content, end))
}

fn certificate_spki(certificate: &[u8]) -> Option<&[u8]> {
    let (outer_tag, outer_content, outer_end) = der_tlv(certificate, 0)?;
    if outer_tag != 0x30 || outer_end != certificate.len() {
        return None;
    }
    let (tbs_tag, tbs_content, tbs_end) = der_tlv(certificate, outer_content)?;
    if tbs_tag != 0x30 || tbs_end > outer_end {
        return None;
    }
    let mut cursor = tbs_content;
    if der_tlv(certificate, cursor)?.0 == 0xa0 {
        cursor = der_tlv(certificate, cursor)?.2;
    }
    for _ in 0..5 {
        cursor = der_tlv(certificate, cursor)?.2;
    }
    let start = cursor;
    let (tag, _, end) = der_tlv(certificate, start)?;
    if tag != 0x30 || end > tbs_end {
        return None;
    }
    Some(&certificate[start..end])
}

pub fn pinned_tls_config(identity: &str) -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(default_provider());
    let verifier = Arc::new(PinnedServerVerifier {
        expected: identity_digest(identity)?,
        provider: provider.clone(),
    });
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|error| format!("Could not configure TLS: {error}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    tls.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(tls)
}

pub fn pinned_http_client(
    identity: &str,
    timeout: Option<Duration>,
) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .use_preconfigured_tls(pinned_tls_config(identity)?)
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("garden-client/", env!("CARGO_PKG_VERSION")));
    if let Some(value) = timeout {
        builder = builder.timeout(value);
    }
    builder
        .build()
        .map_err(|error| format!("Could not create the pinned HTTPS client: {error}"))
}

pub async fn probe_profile(profile: &ServerProfile) -> Result<ServerProfile, String> {
    let client = pinned_http_client(&profile.identity, Some(Duration::from_secs(8)))?;
    let mut candidates = profile.endpoints.clone();
    if let Some(last) = &profile.last_endpoint {
        candidates.retain(|value| value != last);
        candidates.insert(0, last.clone());
    }
    let mut probes = FuturesUnordered::new();
    for endpoint in candidates {
        let client = client.clone();
        probes.push(async move {
            let result = client
                .get(format!("{endpoint}/.well-known/garden"))
                .send()
                .await;
            (endpoint, result)
        });
    }
    let mut failures = Vec::new();
    while let Some((endpoint, result)) = probes.next().await {
        match result {
            Ok(response) if response.status().is_success() => {
                let manifest = response
                    .json::<ConnectionManifest>()
                    .await
                    .map_err(|_| "The server returned an invalid connection manifest")?;
                if manifest.version != 1 || manifest.identity != profile.identity {
                    return Err("The endpoint returned a different garden server identity".into());
                }
                validate_discovery(&manifest.discovery)?;
                let mut refreshed = validated_endpoints(manifest.endpoints)?;
                if !refreshed.contains(&endpoint) {
                    refreshed.insert(0, endpoint.clone());
                }
                refreshed.truncate(MAX_ENDPOINTS);
                return Ok(ServerProfile {
                    version: 1,
                    identity: profile.identity.clone(),
                    endpoints: refreshed,
                    discovery: manifest.discovery,
                    last_endpoint: Some(endpoint),
                    network_preference: profile.network_preference,
                });
            }
            Ok(response) => failures.push(format!("{endpoint}: HTTP {}", response.status())),
            Err(error) => failures.push(format!("{endpoint}: {error}")),
        }
    }
    Err(format!(
        "No saved address could prove the server identity. {}",
        failures.join("; ")
    ))
}

fn endpoint_from_ip(address: IpAddr, port: u16) -> Option<String> {
    if port != 443 || address.is_loopback() || address.is_unspecified() || address.is_multicast() {
        return None;
    }
    match address {
        IpAddr::V4(value) => Some(format!("https://{value}")),
        IpAddr::V6(value) if !value.is_unicast_link_local() => Some(format!("https://[{value}]")),
        IpAddr::V6(_) => None,
    }
}

async fn mdns_candidates(profile: &ServerProfile) -> Result<ServerProfile, String> {
    let expected_identity = profile.identity.clone();
    let mut service = profile.discovery.mdns_service.clone();
    if !service.ends_with('.') {
        service.push('.');
    }
    let discovered = tokio::task::spawn_blocking(move || {
        let daemon = ServiceDaemon::new()
            .map_err(|error| format!("Could not start LAN discovery: {error}"))?;
        let receiver = daemon
            .browse(&service)
            .map_err(|error| format!("Could not browse for garden on this LAN: {error}"))?;
        let deadline = std::time::Instant::now() + Duration::from_secs(4);
        let mut endpoints = Vec::new();
        while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
            match receiver.recv_timeout(remaining) {
                Ok(ServiceEvent::ServiceResolved(info))
                    if info.get_port() == 443
                        && info.get_property_val_str("identity")
                            == Some(expected_identity.as_str()) =>
                {
                    for address in info.get_addresses() {
                        if let Some(endpoint) =
                            endpoint_from_ip(address.to_ip_addr(), info.get_port())
                        {
                            endpoints.push(endpoint);
                        }
                    }
                    if !endpoints.is_empty() {
                        break;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        let _ = daemon.stop_browse(&service);
        let _ = daemon.shutdown();
        Ok::<Vec<String>, String>(endpoints)
    })
    .await
    .map_err(|_| "The LAN discovery worker stopped unexpectedly")??;
    if discovered.is_empty() {
        return Err("The pinned garden server was not found on this local network".into());
    }
    let mut candidate = profile.clone();
    candidate.endpoints = validated_endpoints(discovered)?;
    candidate.last_endpoint = None;
    Ok(candidate)
}

pub async fn connect_profile(profile: &ServerProfile) -> Result<ServerProfile, String> {
    match probe_profile(profile).await {
        Ok(connected) => Ok(connected),
        Err(endpoint_error) => {
            let discovered = mdns_candidates(profile)
                .await
                .map_err(|discovery_error| format!("{endpoint_error} {discovery_error}"))?;
            probe_profile(&discovered).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairing_uri(expires_at: u64) -> String {
        let payload = serde_json::json!({
            "version": 2,
            "endpoints": [
                "https://example.test",
                "https://[2001:db8::1]",
                "https://example.test/"
            ],
            "identity": format!("sha256/{}", STANDARD.encode([7_u8; 32])),
            "discovery": {
                "mdnsService": "_garden._tcp.local",
                "mdnsPort": 443
            },
            "pairingCode": "0123456789abcdef0123456789abcdef",
            "expiresAt": expires_at
        });
        format!(
            "garden://pair/{}",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap())
        )
    }

    #[test]
    fn parses_and_canonicalizes_a_v2_ticket_without_persisting_the_code() {
        let imported =
            parse_pairing_uri(&pairing_uri(2_000), UNIX_EPOCH + Duration::from_secs(1_000))
                .unwrap();
        assert_eq!(imported.profile.endpoints.len(), 2);
        assert_eq!(imported.profile.endpoints[0], "https://example.test");
        assert_eq!(imported.profile.endpoints[1], "https://[2001:db8::1]");
        assert_eq!(imported.pairing_code, "0123456789abcdef0123456789abcdef");
        assert_eq!(imported.pairing_expires_at, 2_000);
        assert!(!serde_json::to_string(&imported.profile)
            .unwrap()
            .contains("0123456789abcdef"));
    }

    #[test]
    fn pending_pairing_is_private_crash_safe_and_expires() {
        let directory = std::env::temp_dir().join(format!(
            "garden-pending-pairing-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("pending-pairing.json");
        let code = "0123456789abcdef0123456789abcdef".to_owned();
        save_pending_pairing(&path, code.clone(), 2_000).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let loaded = load_pending_pairing(&path, UNIX_EPOCH + Duration::from_secs(1_000)).unwrap();
        assert_eq!(loaded.unwrap().pairing_code, code);
        assert!(
            load_pending_pairing(&path, UNIX_EPOCH + Duration::from_secs(2_000))
                .unwrap()
                .is_none()
        );
        assert!(!path.exists());
        fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn old_profiles_default_to_an_unknown_network_preference() {
        let profile: ServerProfile = serde_json::from_value(serde_json::json!({
            "version": 1,
            "identity": format!("sha256/{}", STANDARD.encode([7_u8; 32])),
            "endpoints": ["https://example.test"],
            "discovery": {
                "mdnsService": "_garden._tcp.local",
                "mdnsPort": 443
            }
        }))
        .unwrap();
        assert_eq!(profile.network_preference, NetworkPreference::Unknown);
    }

    #[test]
    fn rejects_expired_tickets_and_unsafe_endpoints() {
        assert!(
            parse_pairing_uri(&pairing_uri(999), UNIX_EPOCH + Duration::from_secs(1_000))
                .unwrap_err()
                .contains("expired")
        );
        assert!(canonical_endpoint("http://example.test").is_err());
        assert!(canonical_endpoint("https://user@example.test").is_err());
        assert!(canonical_endpoint("https://example.test/path").is_err());
        assert!(canonical_endpoint("https://example.test:8443").is_err());
    }

    fn tlv(tag: u8, contents: &[u8]) -> Vec<u8> {
        assert!(contents.len() < 128);
        let mut result = vec![tag, contents.len() as u8];
        result.extend_from_slice(contents);
        result
    }

    #[test]
    fn extracts_the_complete_subject_public_key_info_tlv() {
        let spki = tlv(0x30, &[0x30, 0x00, 0x03, 0x02, 0x00, 0x01]);
        let mut tbs_contents = tlv(0xa0, &[0x02, 0x01, 0x02]);
        for value in [
            tlv(0x02, &[1]),
            tlv(0x30, &[]),
            tlv(0x30, &[]),
            tlv(0x30, &[]),
            tlv(0x30, &[]),
        ] {
            tbs_contents.extend(value);
        }
        tbs_contents.extend(&spki);
        let tbs = tlv(0x30, &tbs_contents);
        let mut certificate_contents = tbs;
        certificate_contents.extend(tlv(0x30, &[]));
        certificate_contents.extend(tlv(0x03, &[0]));
        let certificate = tlv(0x30, &certificate_contents);
        assert_eq!(certificate_spki(&certificate), Some(spki.as_slice()));
    }

    // A second rustls provider feature anywhere in the graph makes the process-wide default
    // ambiguous, and rustls answers that by panicking the first time anything builds a config
    // without naming a provider. Nothing installs a default here, so the ambiguity would only
    // surface on a live connection. Fail the build instead: builder() panics when the features
    // name two providers, and the comparison catches a graph that quietly settled on the other.
    #[test]
    fn every_unnamed_call_site_resolves_the_same_provider_the_pinned_client_uses() {
        let _ = rustls::ClientConfig::builder();
        let ambient = rustls::crypto::CryptoProvider::get_default().unwrap();
        let suites = |provider: &rustls::crypto::CryptoProvider| {
            provider
                .cipher_suites
                .iter()
                .map(|suite| suite.suite())
                .collect::<Vec<_>>()
        };
        assert_eq!(suites(ambient), suites(&default_provider()));
    }

    #[test]
    fn creates_only_safe_port_443_endpoints_from_mdns_addresses() {
        assert_eq!(
            endpoint_from_ip("192.168.1.42".parse().unwrap(), 443).as_deref(),
            Some("https://192.168.1.42")
        );
        assert_eq!(
            endpoint_from_ip("fd00::42".parse().unwrap(), 443).as_deref(),
            Some("https://[fd00::42]")
        );
        assert!(endpoint_from_ip("127.0.0.1".parse().unwrap(), 443).is_none());
        assert!(endpoint_from_ip("192.168.1.42".parse().unwrap(), 8443).is_none());
        assert!(endpoint_from_ip("fe80::42".parse().unwrap(), 443).is_none());
    }

    #[tokio::test]
    async fn probes_a_live_profile_when_explicitly_requested() {
        let Ok(path) = std::env::var("GARDEN_LIVE_MANIFEST") else {
            return;
        };
        let manifest: ConnectionManifest =
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let stale_endpoint = "https://192.0.2.1".to_owned();
        let mut endpoints = manifest.endpoints;
        endpoints.insert(0, stale_endpoint.clone());
        let profile = ServerProfile {
            version: 1,
            identity: manifest.identity,
            endpoints,
            discovery: manifest.discovery,
            last_endpoint: Some(stale_endpoint.clone()),
            network_preference: NetworkPreference::Unknown,
        };
        let connected = probe_profile(&profile).await.unwrap();
        assert_eq!(connected.identity, profile.identity);
        assert_ne!(
            connected.last_endpoint.as_deref(),
            Some(stale_endpoint.as_str())
        );
    }
}
