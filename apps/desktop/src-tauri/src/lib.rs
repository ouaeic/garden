mod connection;
mod native_ipc;
mod native_theme;
mod proxy;
mod ssh_install;

use serde::Serialize;
use std::{
    collections::HashMap,
    fs,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;
use uuid::Uuid;

#[derive(Default)]
struct FolderGrants(Mutex<HashMap<String, PathBuf>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderGrant {
    token: String,
    name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeEntry {
    name: String,
    relative_path: String,
    is_directory: bool,
    size_bytes: u64,
}

/*
 * What this shell can actually do, so the page stops guessing.
 *
 * It reported one boolean, so every other native surface was discovered by trying it and catching
 * the rejection: `notify` learned it was impossible from an exception (`native.ts`), the settings
 * screen had to assume, and a download button was offered on a shell that registered nothing to
 * receive one. Each field below is a build fact this process knows and the page cannot.
 */
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilities {
    browser_authorization: bool,
    folder_picker: bool,
    notifications: bool,
    downloads: bool,
    deep_link_events: bool,
}

#[tauri::command]
fn native_capabilities() -> NativeCapabilities {
    NativeCapabilities {
        browser_authorization: cfg!(mobile),
        folder_picker: cfg!(desktop),
        notifications: true,
        /*
         * Where a download can be received at all. `on_download` below covers the three desktop
         * webviews; wry registers no download support on Android, and iOS has no user-visible
         * Downloads directory to write to (`download_dir()` is `None` there), so on both the honest
         * answer is that the six `<a download>` flows in the product have nowhere to go.
         */
        downloads: cfg!(desktop),
        /*
         * Whether the *page* can subscribe to `garden://` links. It cannot, on any platform:
         * `native.ts` reads `window.__TAURI__.deepLink`, `withGlobalTauri` is false, and no
         * `@tauri-apps/plugin-deep-link` is bundled. Deep links themselves work - `run()` below
         * navigates the window - but that costs a document reload, which is what the JS path
         * existed to avoid. Reported so the client can stop installing a listener that can never
         * fire.
         */
        deep_link_events: false,
    }
}

#[tauri::command]
async fn open_authorization_browser(
    app: tauri::AppHandle,
    client: State<'_, Arc<proxy::ClientState>>,
    url: String,
) -> Result<(), String> {
    let destination = client.authorization_browser_url(&url).await?;
    app.opener()
        .open_url(destination, None::<&str>)
        .map_err(|_| "The system browser could not be opened".into())
}

#[tauri::command]
async fn open_preview_browser(
    app: tauri::AppHandle,
    client: State<'_, Arc<proxy::ClientState>>,
    url: String,
) -> Result<(), String> {
    let destination = client.preview_browser_url(&url).await?;
    app.opener()
        .open_url(destination, None::<&str>)
        .map_err(|_| "The system browser could not be opened".into())
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("Path is outside the granted folder".into());
    }
    Ok(path.to_path_buf())
}

fn grant_root(grants: &State<FolderGrants>, token: &str) -> Result<PathBuf, String> {
    let guard = grants.0.lock().map_err(|_| "Folder grant is unavailable")?;
    guard
        .get(token)
        .cloned()
        .ok_or_else(|| "Folder permission has expired".into())
}

fn checked_path(root: &Path, relative: &str, must_exist: bool) -> Result<PathBuf, String> {
    let relative = relative_path(relative)?;
    let mut candidate = root.to_path_buf();
    for component in relative.components() {
        candidate.push(component);
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("Symbolic links are not followed through a folder grant".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    if must_exist {
        let canonical = candidate
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if !canonical.starts_with(root) {
            return Err("Path is outside the granted folder".into());
        }
        Ok(canonical)
    } else {
        Ok(candidate)
    }
}

#[tauri::command]
#[cfg(desktop)]
fn choose_folder(grants: State<FolderGrants>) -> Result<Option<FolderGrant>, String> {
    let Some(folder) = rfd::FileDialog::new().pick_folder() else {
        return Ok(None);
    };
    let canonical = folder.canonicalize().map_err(|error| error.to_string())?;
    let token = Uuid::new_v4().to_string();
    let name = canonical
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Folder")
        .to_owned();
    grants
        .0
        .lock()
        .map_err(|_| "Folder grant is unavailable")?
        .insert(token.clone(), canonical);
    Ok(Some(FolderGrant { token, name }))
}

#[tauri::command]
#[cfg(mobile)]
fn choose_folder(_grants: State<FolderGrants>) -> Result<Option<FolderGrant>, String> {
    Err("Native folder selection is not available on mobile".into())
}

#[tauri::command]
fn revoke_folder(grants: State<FolderGrants>, token: String) -> Result<(), String> {
    grants
        .0
        .lock()
        .map_err(|_| "Folder grant is unavailable")?
        .remove(&token);
    Ok(())
}

#[tauri::command]
fn list_local_folder(
    grants: State<FolderGrants>,
    token: String,
    relative: String,
) -> Result<Vec<NativeEntry>, String> {
    let root = grant_root(&grants, &token)?;
    let directory = checked_path(&root, &relative, true)?;
    let mut entries = Vec::new();
    for result in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = result.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let metadata = entry.metadata().map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        let relative_path = if relative.is_empty() {
            name.clone()
        } else {
            format!("{relative}/{name}")
        };
        entries.push(NativeEntry {
            name,
            relative_path,
            is_directory: file_type.is_dir(),
            size_bytes: metadata.len(),
        });
    }
    entries.sort_by(|left, right| {
        right
            .is_directory
            .cmp(&left.is_directory)
            .then(left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[tauri::command]
fn read_local_file(
    grants: State<FolderGrants>,
    token: String,
    relative: String,
) -> Result<Vec<u8>, String> {
    let root = grant_root(&grants, &token)?;
    let path = checked_path(&root, &relative, true)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > 100 * 1024 * 1024
    {
        return Err("Only regular files up to 100 MiB may be read".into());
    }
    fs::read(path).map_err(|error| error.to_string())
}

/*
 * Show the owner where the file went.
 *
 * Not a shell: each argument is passed separately, and the path is always the Downloads directory
 * joined with a file name, so it is absolute and cannot be read as an option.
 */
#[cfg(desktop)]
fn reveal_download(path: &Path) {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/open")
        .arg("-R")
        .arg(path)
        .spawn();
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("explorer.exe")
        .arg(format!("/select,{}", path.display()))
        .spawn();
    #[cfg(target_os = "linux")]
    if let Some(parent) = path.parent() {
        let _ = std::process::Command::new("xdg-open").arg(parent).spawn();
    }
}

/*
 * Where a download the webview started should be written.
 *
 * wry pre-fills the destination from the platform Downloads directory, but only where it can find
 * one; this insists on the directory Tauri resolves and on a plain file name, so a `Content-
 * Disposition` from the box can never place the file anywhere but Downloads. `None` declines the
 * download, which is what an unhandled one already did.
 */
fn download_destination(downloads: Option<&Path>, suggested: &Path) -> Option<PathBuf> {
    let directory = downloads?;
    let name = suggested.file_name().filter(|value| {
        let value = Path::new(value);
        value.components().count() == 1 && !value.as_os_str().is_empty()
    })?;
    let mut destination = directory.join(name);
    // WebKit and WebView2 both refuse to overwrite, and so does this: the previewed file the owner
    // saved five minutes ago is not the one they asked for now.
    let stem = destination
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let extension = destination
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let mut counter = 1;
    while destination.exists() {
        destination.set_file_name(format!("{stem} ({counter}){extension}"));
        counter += 1;
    }
    Some(destination)
}

fn deep_link_destination(raw: &str, local_origin: &str) -> Result<Option<Url>, String> {
    let link = Url::parse(raw).map_err(|_| "This is not a garden link")?;
    if !matches!(link.scheme(), "garden")
        || !link.username().is_empty()
        || link.password().is_some()
        || link.query().is_some()
        || link.fragment().is_some()
    {
        return Err("This is not a garden link".into());
    }
    let Some(kind @ ("task" | "workspace")) = link.host_str() else {
        return Ok(None);
    };
    let segments = link
        .path_segments()
        .map(|parts| parts.filter(|part| !part.is_empty()).collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() != 1 || Uuid::parse_str(segments[0]).is_err() {
        return Err("This garden link does not contain a valid destination".into());
    }
    let mut destination =
        Url::parse(local_origin).map_err(|_| "The private client address is invalid")?;
    destination.set_path("/");
    destination.query_pairs_mut().append_pair(kind, segments[0]);
    Ok(Some(destination))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    builder
        .invoke_system(native_ipc::initialization_script(std::env::consts::OS))
        .manage(FolderGrants::default())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let profile_path = app.path().app_data_dir()?.join("server-profile.json");
            let pending_pairing_path = app.path().app_cache_dir()?.join("pending-pairing.json");
            let client = proxy::ClientState::load(profile_path, pending_pairing_path)?;
            app.manage(client.clone());
            let origin = tauri::async_runtime::block_on(proxy::start(client.clone()))?;
            let capabilities =
                native_ipc::scoped_capabilities(&origin).map_err(std::io::Error::other)?;
            app.add_capability(serde_json::to_string(&capabilities)?)?;
            let mut window_config = app
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .ok_or("The garden main window configuration is unavailable")?
                .clone();
            #[cfg(target_os = "macos")]
            {
                window_config.title_bar_style = tauri::TitleBarStyle::Overlay;
                window_config.hidden_title = true;
            }
            window_config.url = tauri::WebviewUrl::External(origin.parse()?);
            /*
             * Receive a download, or the six that exist in the product are cancelled in silence.
             *
             * The product downloads a workspace archive, a privacy export, a conversation, a
             * previewed file, an attachment - and the recovery code, the one artefact an owner
             * cannot regenerate. All six are an `<a download>` click, and wry answers a
             * download-attribute navigation with `WKNavigationActionPolicy::Cancel` when no
             * handler is registered (`wkwebview/navigation.rs`). Nothing appeared, and nothing
             * said why.
             */
            let downloads = app.path().download_dir().ok();
            let saved: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();
            let record = saved.clone();
            let window = tauri::WebviewWindowBuilder::from_config(app, &window_config)?;
            #[cfg(target_os = "macos")]
            let window = window
                .traffic_light_position(tauri::LogicalPosition::new(14.0, 10.0))
                .initialization_script(native_theme::window_inset_script());
            let window = window
                .on_download(move |_webview, event| match event {
                    tauri::webview::DownloadEvent::Requested { url, destination } => {
                        let Some(chosen) = download_destination(downloads.as_deref(), destination)
                        else {
                            eprintln!("garden has nowhere to save downloads on this platform");
                            return false;
                        };
                        if let Ok(mut record) = record.lock() {
                            record.insert(url.to_string(), chosen.clone());
                        }
                        *destination = chosen;
                        true
                    }
                    tauri::webview::DownloadEvent::Finished { url, path, success } => {
                        let saved = saved
                            .lock()
                            .ok()
                            .and_then(|mut record| record.remove(&url.to_string()))
                            // macOS never reports the path back, by API limitation, which is why
                            // the destination is remembered above rather than read from here.
                            .or(path);
                        #[cfg(desktop)]
                        if let (true, Some(path)) = (success, saved.as_deref()) {
                            reveal_download(path);
                        }
                        #[cfg(not(desktop))]
                        let _ = (success, saved);
                        true
                    }
                    _ => true,
                })
                .build()?;

            let import_url = {
                let client = client.clone();
                let window = window.clone();
                let origin = origin.clone();
                move |raw: String| {
                    let client = client.clone();
                    let window = window.clone();
                    let origin = origin.clone();
                    tauri::async_runtime::spawn(async move {
                        let destination = match deep_link_destination(&raw, &origin) {
                            Ok(Some(destination)) => Some(destination),
                            Ok(None) => match client.import_deep_link(&raw).await {
                                Ok(()) => origin.parse().ok(),
                                Err(_) => None,
                            },
                            Err(_) => None,
                        };
                        if let Some(destination) = destination {
                            let _ = window.navigate(destination);
                        }
                        let _ = window.show();
                        let _ = window.set_focus();
                    });
                }
            };

            if let Some(urls) = app.deep_link().get_current()? {
                for url in urls {
                    import_url(url.to_string());
                }
            }
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    import_url(url.to_string());
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_authorization_browser,
            open_preview_browser,
            native_capabilities,
            choose_folder,
            revoke_folder,
            list_local_folder,
            read_local_file
        ])
        .run(tauri::generate_context!())
        .expect("garden native shell failed");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(relative_path("../secret").is_err());
        assert!(relative_path("/etc/passwd").is_err());
        assert!(relative_path("workspace/report.md").is_ok());
    }

    #[test]
    fn maps_valid_task_and_workspace_links_to_the_private_gateway() {
        let task_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        assert_eq!(
            deep_link_destination(
                &format!("garden://task/{task_id}"),
                "http://localhost:49876"
            )
            .unwrap(),
            deep_link_destination(
                &format!("garden://task/{task_id}"),
                "http://localhost:49876"
            )
            .unwrap()
        );
        assert_eq!(
            deep_link_destination(
                &format!("garden://task/{task_id}"),
                "http://localhost:49876"
            )
            .unwrap()
            .unwrap()
            .as_str(),
            format!("http://localhost:49876/?task={task_id}")
        );
        assert_eq!(
            deep_link_destination(
                &format!("garden://workspace/{workspace_id}"),
                "http://localhost:49876"
            )
            .unwrap()
            .unwrap()
            .as_str(),
            format!("http://localhost:49876/?workspace={workspace_id}")
        );
        assert!(
            deep_link_destination("garden://task/not-a-uuid", "http://localhost:49876").is_err()
        );
        assert!(
            deep_link_destination("garden://pair/ticket", "http://localhost:49876")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn a_download_is_written_to_the_downloads_directory_under_a_plain_name() {
        let downloads =
            std::env::temp_dir().join(format!("garden-downloads-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&downloads).unwrap();

        let chosen =
            download_destination(Some(&downloads), Path::new("recovery-code.txt")).unwrap();
        assert_eq!(chosen, downloads.join("recovery-code.txt"));

        // A Content-Disposition from the box cannot place a file outside Downloads.
        assert_eq!(
            download_destination(Some(&downloads), Path::new("../../.ssh/authorized_keys")),
            Some(downloads.join("authorized_keys"))
        );
        assert_eq!(
            download_destination(Some(&downloads), Path::new("..")),
            None
        );
        assert_eq!(download_destination(Some(&downloads), Path::new("")), None);

        // The export saved five minutes ago is not the one being asked for now.
        fs::write(&chosen, b"first").unwrap();
        assert_eq!(
            download_destination(Some(&downloads), Path::new("recovery-code.txt")),
            Some(downloads.join("recovery-code (1).txt"))
        );

        // Nowhere to write is declined rather than guessed at, which is what iOS and Android get.
        assert_eq!(download_destination(None, Path::new("export.zip")), None);
        fs::remove_dir_all(downloads).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_that_leave_a_grant() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("garden-native-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        symlink("/", root.join("outside")).unwrap();
        let result = checked_path(&root, "outside/etc/passwd", true);
        fs::remove_dir_all(&root).unwrap();
        assert!(result.is_err());
    }
}
