use axum::{extract::Path, http::StatusCode, response::IntoResponse, response::Response};

pub(crate) async fn asset(Path(name): Path<String>) -> Response {
    let (content_type, bytes): (&str, Vec<u8>) = match name.as_str() {
        "foundation.css" => (
            "text/css; charset=utf-8",
            include_str!("../../../web/src/styles/foundation.css")
                .replace("/fonts/", "/__garden/theme/")
                .into_bytes(),
        ),
        "setup.css" => (
            "text/css; charset=utf-8",
            include_bytes!("setup.css").to_vec(),
        ),
        "wordmark.svg" => (
            "image/svg+xml",
            include_bytes!("../../../web/public/brand/garden-wordmark.svg").to_vec(),
        ),
        "Fraunces.woff2" => (
            "font/woff2",
            include_bytes!("../../../web/public/fonts/Fraunces.woff2").to_vec(),
        ),
        "Fraunces-Italic.woff2" => (
            "font/woff2",
            include_bytes!("../../../web/public/fonts/Fraunces-Italic.woff2").to_vec(),
        ),
        "Geist.woff2" => (
            "font/woff2",
            include_bytes!("../../../web/public/fonts/Geist.woff2").to_vec(),
        ),
        "GeistMono.woff2" => (
            "font/woff2",
            include_bytes!("../../../web/public/fonts/GeistMono.woff2").to_vec(),
        ),
        _ => return StatusCode::NOT_FOUND.into_response(),
    };
    ([("content-type", content_type)], bytes).into_response()
}

#[cfg(target_os = "macos")]
pub(crate) fn window_inset_script() -> String {
    let css = serde_json::to_string(include_str!("window-inset.css")).unwrap();
    format!(
        "if (window === window.top) {{ document.addEventListener('DOMContentLoaded', () => {{ const style = document.createElement('style'); style.textContent = {css}; document.head.append(style); }}, {{once:true}}); }}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;

    #[tokio::test]
    async fn setup_assets_are_bundled_and_restricted_to_the_catalogue() {
        for (name, mime) in [
            ("foundation.css", "text/css; charset=utf-8"),
            ("setup.css", "text/css; charset=utf-8"),
            ("wordmark.svg", "image/svg+xml"),
            ("Fraunces.woff2", "font/woff2"),
            ("Fraunces-Italic.woff2", "font/woff2"),
            ("Geist.woff2", "font/woff2"),
            ("GeistMono.woff2", "font/woff2"),
        ] {
            let response = asset(Path(name.to_owned())).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], mime);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(!bytes.is_empty(), "{name} must be shipped offline");
            if name == "foundation.css" {
                let css = std::str::from_utf8(&bytes).unwrap();
                assert!(css.contains("/__garden/theme/Geist.woff2"));
                assert!(!css.contains("/fonts/"));
            }
        }
        for name in ["../server-profile.json", "unknown.css"] {
            assert_eq!(
                asset(Path(name.into())).await.status(),
                StatusCode::NOT_FOUND
            );
        }
    }
}
