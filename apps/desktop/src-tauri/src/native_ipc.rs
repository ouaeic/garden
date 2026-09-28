use tauri::utils::acl::capability::{Capability, CapabilityRemote};
use url::Url;

const TRANSPORT: &str = include_str!("vendor/tauri-ipc-protocol.js.txt");
const SERIALIZER: &str = include_str!("vendor/tauri-process-ipc-message-fn.js.txt");
const CAPABILITIES: [&str; 3] = [
    include_str!("../capabilities/loopback-native.json"),
    include_str!("../capabilities/loopback-notifications.json"),
    include_str!("../capabilities/loopback-notifications-desktop.json"),
];

/// Some WebViews inject initialization scripts into every frame. Keep the invoke key out of
/// child-frame or opaque-document closures, even when the platform reports their main-frame URL.
/// The attributed upstream transport retains binary payloads, channels and protocol fallback.
pub(crate) fn initialization_script(os: &str) -> String {
    let transport = TRANSPORT
        .replace("__TEMPLATE_invoke_key__", "__INVOKE_KEY__")
        .replace("__RAW_process_ipc_message_fn__", SERIALIZER)
        .replace("__TEMPLATE_os_name__", &serde_json::to_string(os).unwrap())
        .replace(
            "__TEMPLATE_fetch_channel_data_command__",
            "\"plugin:__TAURI_CHANNEL__|fetch\"",
        );
    format!(";(function () {{ if (window !== window.top || window.origin === 'null' || window.origin !== window.location.origin) return;\n{transport}\n}})();")
}

pub(crate) fn scoped_capabilities(origin: &str) -> Result<Vec<Capability>, String> {
    let parsed = Url::parse(origin).map_err(|_| "Invalid native main origin")?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("localhost")
        || parsed.port().is_none()
        || parsed.origin().ascii_serialization() != origin
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("Native permissions require the exact bound main origin".into());
    }
    CAPABILITIES
        .iter()
        .map(|raw| {
            let mut capability: Capability =
                serde_json::from_str(raw).map_err(|error| error.to_string())?;
            if capability.local
                || capability.windows != ["main"]
                || capability.permissions.is_empty()
                || capability
                    .remote
                    .as_ref()
                    .is_some_and(|remote| !remote.urls.is_empty())
            {
                return Err(
                    "Native capability templates must grant no ambient remote authority".into(),
                );
            }
            capability.remote = Some(CapabilityRemote {
                urls: vec![format!("{origin}/*")],
            });
            Ok(capability)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use tauri::ipc::{Origin, RuntimeAuthority};
    use tauri::utils::acl::{manifest::Manifest, resolved::Resolved};
    use tauri::utils::platform::Target;

    #[test]
    fn native_ipc_authority_is_scoped_on_every_shipped_platform() {
        for target in [
            Target::MacOS,
            Target::Windows,
            Target::Linux,
            Target::Android,
            Target::Ios,
        ] {
            let acl: BTreeMap<String, Manifest> =
                serde_json::from_str(include_str!("../gen/schemas/acl-manifests.json")).unwrap();
            let mut capabilities = scoped_capabilities("http://localhost:41000").unwrap();
            capabilities
                .push(serde_json::from_str(include_str!("../capabilities/default.json")).unwrap());
            let resolved = Resolved::resolve(
                &acl,
                capabilities
                    .into_iter()
                    .map(|cap| (cap.identifier.clone(), cap))
                    .collect(),
                target,
            )
            .unwrap();
            let authority = RuntimeAuthority::new(acl, resolved);
            let allowed = Origin::Remote {
                url: "http://localhost:41000/".parse().unwrap(),
            };
            for command in [
                "native_capabilities",
                "choose_folder",
                "list_local_folder",
                "read_local_file",
                "open_authorization_browser",
                "open_preview_browser",
                "plugin:notification|notify",
                "plugin:notification|is_permission_granted",
                "plugin:notification|request_permission",
            ] {
                assert!(
                    authority
                        .resolve_access(command, "main", "main", &allowed)
                        .is_some(),
                    "{command} unavailable on {target:?}"
                );
                for value in [
                    "http://localhost:41001/__garden/preview/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
                    "https://outside.test/",
                    "http://localhost:5173/",
                    "http://localhost.evil.test:41000/",
                ] {
                    let denied = Origin::Remote {
                        url: value.parse().unwrap(),
                    };
                    assert!(
                        authority
                            .resolve_access(command, "main", "main", &denied)
                            .is_none(),
                        "{command} reached from {value} on {target:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn native_ipc_templates_have_no_static_remote_grants() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["app"]["security"]["capabilities"],
            serde_json::json!(["default"])
        );
        assert!(!CAPABILITIES.is_empty());
        for raw in CAPABILITIES {
            let capability: Capability = serde_json::from_str(raw).unwrap();
            assert!(!capability.local);
            assert!(capability.remote.unwrap().urls.is_empty());
        }
        for value in [
            "http://localhost:*/",
            "http://localhost:41000/path",
            "https://localhost:41000",
            "http://127.0.0.1:41000",
            "http://localhost:41000?query",
        ] {
            assert!(scoped_capabilities(value).is_err());
        }
    }

    #[test]
    fn native_ipc_protocol_preserves_main_payloads_and_denies_subframes() {
        use std::io::Write;
        use std::process::{Command, Stdio};
        let scripts: BTreeMap<_, _> = ["macos", "windows", "linux", "android", "ios"]
            .into_iter()
            .map(|os| {
                let script = initialization_script(os);
                if let Ok(directory) = std::env::var("GARDEN_NATIVE_IPC_EVIDENCE") {
                    std::fs::write(
                        std::path::Path::new(&directory).join(format!("native-ipc-{os}.js")),
                        &script,
                    )
                    .unwrap();
                }
                (
                    os,
                    script.replace("__INVOKE_KEY__", "\"fixture-native-key\""),
                )
            })
            .collect();
        let test = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test-native-ipc.mjs");
        let mut child = Command::new("node")
            .arg(test)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(&serde_json::to_vec(&scripts).unwrap())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(report["cases"], 25);
        assert_eq!(report["subframeMessages"], 0);
    }
}
