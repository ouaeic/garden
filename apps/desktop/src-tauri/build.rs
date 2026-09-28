use std::process::Command;

fn source_commit() -> String {
    let configured = std::env::var("GARDEN_SOURCE_COMMIT").ok();
    let discovered = Command::new("git")
        .args(["rev-parse", "--verify", "HEAD"])
        .current_dir(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set"))
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok());
    configured
        .or(discovered)
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| {
            matches!(value.len(), 40 | 64)
                && value.chars().all(|character| character.is_ascii_hexdigit())
        })
        .unwrap_or_else(|| "unavailable".into())
}

fn main() {
    println!("cargo:rerun-if-env-changed=GARDEN_SOURCE_COMMIT");
    println!("cargo:rustc-env=GARDEN_SOURCE_COMMIT={}", source_commit());
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "native_capabilities",
            "open_authorization_browser",
            "open_preview_browser",
            "choose_folder",
            "revoke_folder",
            "list_local_folder",
            "read_local_file",
        ]),
    ))
    .expect("failed to build the constrained garden Tauri manifest")
}
