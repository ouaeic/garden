use russh::{
    client::{self, KeyboardInteractiveAuthResponse},
    keys::{load_secret_key, ssh_key::HashAlg, PrivateKeyWithHashAlg},
    ChannelMsg, Disconnect,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};
use zeroize::{Zeroize, Zeroizing};

const RELEASE_REF: &str = concat!("v", env!("CARGO_PKG_VERSION"));
const SOURCE_COMMIT: &str = env!("GARDEN_SOURCE_COMMIT");
/// The hash of `install.sh` as this build ships it, checked on the server before the script runs.
///
/// `scripts/check-release.mjs` recomputes this hash so the client only executes the bootstrap
/// shipped with its source revision.
const INSTALL_BOOTSTRAP_SHA256: &str =
    "ba8f3e40ff9a6c7a7901a1f8c46de535d632fac696db42552a3d52bbcfed85e6";
const MAX_OUTPUT_BYTES: usize = 4 * 1024 * 1024;
const INSTALLER_PAGE: &str = include_str!("installer.html");

pub fn installer_page(configured: bool, client_url: &str) -> String {
    let notice = if configured {
        r#"<p class="notice">Connecting a different server replaces this app’s saved server address. It does not alter or delete the currently connected server.</p>"#
    } else {
        ""
    };
    INSTALLER_PAGE
        .replace("{{EXISTING_CONNECTION_NOTICE}}", notice)
        .replace("{{CLIENT_URL}}", client_url)
        .replace(
            "{{KEY_PICKER_AVAILABLE}}",
            if cfg!(desktop) { "true" } else { "false" },
        )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostIdentity {
    pub fingerprint: String,
    pub algorithm: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallServerRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub authentication: String,
    pub password: Option<String>,
    pub private_key_path: Option<String>,
    pub private_key_passphrase: Option<String>,
    pub expected_fingerprint: String,
}

impl Drop for InstallServerRequest {
    fn drop(&mut self) {
        if let Some(value) = self.password.as_mut() {
            value.zeroize();
        }
        if let Some(value) = self.private_key_passphrase.as_mut() {
            value.zeroize();
        }
    }
}

pub struct InstallServerResult {
    pub(crate) ticket: String,
}

struct HostKeyVerifier {
    expected: Option<String>,
    observed: Arc<Mutex<Option<SshHostIdentity>>>,
}

impl client::Handler for HostKeyVerifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let server_public_key = server_public_key.public_key();
        let identity = SshHostIdentity {
            fingerprint: server_public_key.fingerprint(HashAlg::Sha256).to_string(),
            algorithm: server_public_key.algorithm().to_string(),
        };
        let accepted = self
            .expected
            .as_ref()
            .map(|expected| expected == &identity.fingerprint)
            .unwrap_or(true);
        if let Ok(mut observed) = self.observed.lock() {
            *observed = Some(identity);
        }
        Ok(accepted)
    }
}

fn validated_server(host: &str, port: u16, username: Option<&str>) -> Result<String, String> {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.is_empty()
        || host.len() > 253
        || port == 0
        || host.contains("://")
        || host.chars().any(|character| {
            !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | ':' | '_'))
        })
    {
        return Err("Enter a hostname or IP address and a valid SSH port".into());
    }
    if let Some(username) = username {
        if username.is_empty()
            || username.len() > 64
            || username.chars().any(|character| {
                !(character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_'))
            })
        {
            return Err("Enter the Linux login name supplied by the server provider".into());
        }
    }
    Ok(host.to_owned())
}

async fn connect(
    host: &str,
    port: u16,
    expected: Option<String>,
    inactivity: Duration,
) -> Result<
    (
        client::Handle<HostKeyVerifier>,
        Arc<Mutex<Option<SshHostIdentity>>>,
    ),
    String,
> {
    let observed = Arc::new(Mutex::new(None));
    let handler = HostKeyVerifier {
        expected,
        observed: observed.clone(),
    };
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(inactivity),
        ..Default::default()
    });
    let handle = tokio::time::timeout(
        Duration::from_secs(20),
        client::connect(config, (host, port), handler),
    )
    .await
    .map_err(|_| "The SSH connection timed out")?
    .map_err(|error| format!("Could not establish SSH: {error}"))?;
    Ok((handle, observed))
}

pub async fn probe(host: String, port: u16) -> Result<SshHostIdentity, String> {
    let host = validated_server(&host, port, None)?;
    let (handle, observed) = connect(&host, port, None, Duration::from_secs(30)).await?;
    let identity = observed
        .lock()
        .map_err(|_| "The SSH host identity check stopped unexpectedly")?
        .clone()
        .ok_or("The server did not present an SSH host identity")?;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "Host identity checked", "en")
        .await;
    Ok(identity)
}

fn append_bounded(target: &mut Vec<u8>, data: &[u8]) {
    if data.len() >= MAX_OUTPUT_BYTES {
        target.clear();
        target.extend_from_slice(&data[data.len() - MAX_OUTPUT_BYTES..]);
        return;
    }
    if target.len() + data.len() > MAX_OUTPUT_BYTES {
        let remove = target.len() + data.len() - MAX_OUTPUT_BYTES;
        target.drain(..remove);
    }
    target.extend_from_slice(data);
}

fn source_ref(channel: &str) -> &'static str {
    if channel == "beta" {
        SOURCE_COMMIT
    } else {
        RELEASE_REF
    }
}

fn install_command(username: &str) -> String {
    let release_ref = source_ref(env!("GARDEN_BUILD_CHANNEL"));
    let install_url =
        format!("https://raw.githubusercontent.com/ouaeic/garden/{release_ref}/install.sh");
    let bootstrap = format!(
        "temporary=$(mktemp); trap 'rm -f \"$temporary\"' EXIT INT TERM; \
         curl -fsSL '{install_url}' -o \"$temporary\"; \
         printf '%s  %s\\n' '{INSTALL_BOOTSTRAP_SHA256}' \"$temporary\" | sha256sum -c - >/dev/null"
    );
    if username == "root" {
        format!(
            "set -eu; if command -v garden >/dev/null 2>&1; then garden pairing-code; else {bootstrap}; env GARDEN_REF='{release_ref}' GARDEN_EXPECTED_COMMIT='{SOURCE_COMMIT}' sh \"$temporary\"; fi"
        )
    } else {
        format!(
            "set -eu; if command -v garden >/dev/null 2>&1; then sudo -n garden pairing-code; else {bootstrap}; sudo -n env GARDEN_REF='{release_ref}' GARDEN_EXPECTED_COMMIT='{SOURCE_COMMIT}' sh \"$temporary\"; fi"
        )
    }
}

fn pairing_ticket(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| {
            line.starts_with("garden://pair/")
                && line.len() <= 32_000
                && line.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "-_:/".contains(character)
                })
        })
        .map(str::to_owned)
}

async fn authenticate_with_password(
    handle: &mut client::Handle<HostKeyVerifier>,
    username: &str,
    password: &str,
) -> Result<bool, String> {
    let direct = handle
        .authenticate_password(username.to_owned(), password.to_owned())
        .await
        .map_err(|error| format!("SSH password authentication failed: {error}"))?;
    if direct.success() {
        return Ok(true);
    }

    let mut response = handle
        .authenticate_keyboard_interactive_start(username.to_owned(), None)
        .await
        .map_err(|error| format!("SSH interactive authentication failed: {error}"))?;
    for _ in 0..8 {
        response = match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                let answers = prompts
                    .iter()
                    .map(|prompt| {
                        if prompt.echo {
                            String::new()
                        } else {
                            password.to_owned()
                        }
                    })
                    .collect();
                handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(|error| format!("SSH interactive authentication failed: {error}"))?
            }
        };
    }
    Err("The SSH server requested too many interactive authentication steps".into())
}

pub async fn install(mut request: InstallServerRequest) -> Result<InstallServerResult, String> {
    let host = validated_server(&request.host, request.port, Some(request.username.trim()))?;
    let username = request.username.trim().to_owned();
    if !request.expected_fingerprint.starts_with("SHA256:")
        || request.expected_fingerprint.len() > 128
    {
        return Err("Check and approve the server’s SSH fingerprint first".into());
    }
    let (mut handle, observed) = connect(
        &host,
        request.port,
        Some(request.expected_fingerprint.clone()),
        Duration::from_secs(600),
    )
    .await
    .map_err(|error| {
        if error.to_lowercase().contains("key") {
            "The SSH host identity changed or could not be verified".to_owned()
        } else {
            error
        }
    })?;
    let observed_fingerprint = observed
        .lock()
        .map_err(|_| "The SSH host identity check stopped unexpectedly")?
        .as_ref()
        .map(|identity| identity.fingerprint.clone())
        .ok_or("The server did not present an SSH host identity")?;
    if observed_fingerprint != request.expected_fingerprint {
        return Err("The SSH host identity changed; installation was stopped".into());
    }

    let authenticated = match request.authentication.as_str() {
        "password" => {
            let password = Zeroizing::new(
                request
                    .password
                    .take()
                    .filter(|value| !value.is_empty())
                    .ok_or("Enter the SSH password")?,
            );
            authenticate_with_password(&mut handle, &username, password.as_str()).await?
        }
        "private-key" => {
            let key_path = request
                .private_key_path
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("Choose an SSH private key")?;
            let metadata = std::fs::symlink_metadata(key_path)
                .map_err(|_| "The SSH private key could not be read")?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > 1024 * 1024
            {
                return Err("Choose a regular SSH private-key file up to 1 MiB".into());
            }
            let private_key = load_secret_key(
                Path::new(key_path),
                request.private_key_passphrase.as_deref(),
            )
            .map_err(|_| "The SSH private key or its passphrase is not valid")?;
            let hash = handle
                .best_supported_rsa_hash()
                .await
                .map_err(|error| format!("Could not negotiate the SSH key algorithm: {error}"))?
                .flatten();
            handle
                .authenticate_publickey(
                    username.clone(),
                    PrivateKeyWithHashAlg::new(Arc::new(private_key), hash),
                )
                .await
                .map_err(|error| format!("SSH private-key authentication failed: {error}"))?
                .success()
        }
        _ => return Err("Choose password or private-key SSH authentication".into()),
    };
    if !authenticated {
        return Err("The SSH credentials were not accepted by the server".into());
    }

    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|error| format!("Could not open the SSH installer session: {error}"))?;
    channel
        .exec(true, install_command(&username))
        .await
        .map_err(|error| format!("Could not start the garden installer: {error}"))?;
    let mut output = Vec::new();
    let mut exit_status = None;
    tokio::time::timeout(Duration::from_secs(45 * 60), async {
        while let Some(message) = channel.wait().await {
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    append_bounded(&mut output, &data);
                }
                ChannelMsg::ExitStatus {
                    exit_status: status,
                } => exit_status = Some(status),
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| "The remote installer exceeded 45 minutes and was stopped")?;
    let _ = handle
        .disconnect(Disconnect::ByApplication, "Installation finished", "en")
        .await;

    let text = String::from_utf8_lossy(&output).to_string();
    if exit_status != Some(0) {
        let hint = if text.contains("sudo") {
            " The login must be root or have passwordless sudo."
        } else {
            ""
        };
        return Err(format!(
            "The remote installer did not finish successfully.{hint}\n{}",
            text.chars()
                .rev()
                .take(2_000)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    let ticket = pairing_ticket(&text)
        .ok_or("Installation finished but no connection ticket was returned")?;
    Ok(InstallServerResult { ticket })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn host_key_probe_records_identity_and_install_rejects_a_changed_key() {
        use russh::{client::Handler, keys::ssh_key::public::Ed25519PublicKey};
        let key = russh::keys::ssh_key::PublicKey::new(Ed25519PublicKey([1; 32]).into(), "");
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        let observed = Arc::new(Mutex::new(None));
        let mut verifier = HostKeyVerifier {
            expected: None,
            observed: observed.clone(),
        };
        assert!(verifier
            .check_server_key(&key.clone().into())
            .await
            .unwrap());
        assert_eq!(
            observed.lock().unwrap().as_ref().unwrap().fingerprint,
            fingerprint
        );
        verifier.expected = Some(fingerprint);
        assert!(verifier.check_server_key(&key.into()).await.unwrap());
        let changed = russh::keys::ssh_key::PublicKey::new(Ed25519PublicKey([2; 32]).into(), "");
        assert!(!verifier.check_server_key(&changed.into()).await.unwrap());
    }

    #[test]
    fn validates_targets_and_extracts_only_standalone_tickets() {
        assert!(validated_server("example.com", 22, Some("administrator")).is_ok());
        assert!(validated_server("https://example.com", 22, Some("root")).is_err());
        assert!(validated_server("example.com", 0, Some("root")).is_err());
        assert!(validated_server("example.com", 22, Some("root; reboot")).is_err());
        assert_eq!(
            pairing_ticket("done\ngarden://pair/abc_DEF-123\n"),
            Some("garden://pair/abc_DEF-123".into())
        );
        assert!(pairing_ticket("prefix garden://pair/abc").is_none());
    }

    #[test]
    fn installer_command_is_fixed_and_uses_noninteractive_sudo() {
        assert!(install_command("root").contains("sha256sum -c"));
        assert!(install_command("root").contains(&format!(
            "GARDEN_REF='{}'",
            source_ref(env!("GARDEN_BUILD_CHANNEL"))
        )));
        assert!(source_ref("stable").starts_with('v'));
        assert_eq!(source_ref("beta"), SOURCE_COMMIT);
        assert!(install_command("root").contains("GARDEN_EXPECTED_COMMIT='"));
        assert!(!install_command("root").contains("sudo"));
        assert!(install_command("administrator").contains("sudo -n env"));
        assert!(!install_command("administrator").contains("administrator"));
    }

    #[tokio::test]
    async fn probes_a_live_ssh_identity_when_explicitly_requested() {
        let Ok(target) = std::env::var("GARDEN_LIVE_SSH_TARGET") else {
            return;
        };
        let (host, port) = target
            .rsplit_once(':')
            .and_then(|(host, port)| port.parse::<u16>().ok().map(|port| (host, port)))
            .expect("GARDEN_LIVE_SSH_TARGET must be HOST:PORT");
        let identity = probe(host.to_owned(), port)
            .await
            .expect("live SSH probe failed");
        assert!(identity.fingerprint.starts_with("SHA256:"));
        if let Ok(expected) = std::env::var("GARDEN_LIVE_SSH_FINGERPRINT") {
            assert_eq!(identity.fingerprint, expected);
        }
    }
}
