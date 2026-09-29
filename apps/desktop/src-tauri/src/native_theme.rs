use axum::{extract::Path, http::StatusCode, response::IntoResponse, response::Response};

pub(crate) async fn asset(Path(name): Path<String>) -> Response {
    let (content_type, bytes): (&str, Vec<u8>) = match name.as_str() {
        "lcd.css" => (
            "text/css; charset=utf-8",
            include_str!("../../../web/src/lcd.css")
                .replace("/fonts/", "/__garden/theme/")
                .into_bytes(),
        ),
        "setup.css" => (
            "text/css; charset=utf-8",
            include_bytes!("setup.css").to_vec(),
        ),
        "PixelOperator.ttf" => (
            "font/ttf",
            include_bytes!("../../../web/public/fonts/PixelOperator.ttf").to_vec(),
        ),
        "PixelOperator-Bold.ttf" => (
            "font/ttf",
            include_bytes!("../../../web/public/fonts/PixelOperator-Bold.ttf").to_vec(),
        ),
        "PixelOperatorMono.ttf" => (
            "font/ttf",
            include_bytes!("../../../web/public/fonts/PixelOperatorMono.ttf").to_vec(),
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
            ("lcd.css", "text/css; charset=utf-8"),
            ("setup.css", "text/css; charset=utf-8"),
            ("PixelOperator.ttf", "font/ttf"),
            ("PixelOperator-Bold.ttf", "font/ttf"),
            ("PixelOperatorMono.ttf", "font/ttf"),
        ] {
            let response = asset(Path(name.to_owned())).await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["content-type"], mime);
            let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            assert!(!bytes.is_empty(), "{name} must be shipped offline");
            if name == "lcd.css" {
                let css = std::str::from_utf8(&bytes).unwrap();
                assert!(css.contains("/__garden/theme/PixelOperator.ttf"));
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
