//! Opening integration web UIs (Kibana, Grafana) in the default browser.
//!
//! Every link is built in Rust from a base URL that must be http(s), so the
//! webview cannot open other schemes through these commands. Accepted risk:
//! the base comes from the frontend's settings, so a compromised webview
//! could open any http(s) page in the browser; it could already show any
//! page inside the app.

/// `raw` parsed as an http(s) URL; `what` names it in the error ("Kibana").
/// A user or password in it is dropped: credentials live in the keychain
/// and must never reach the browser's history.
pub(super) fn http_base(raw: &str, what: &str) -> Result<url::Url, String> {
    let mut base = url::Url::parse(raw.trim()).map_err(|e| format!("Invalid {what} URL: {e}"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err(format!("{what} URL must start with http:// or https://"));
    }
    // Cannot fail on an http(s) URL, which always has a host.
    let _ = base.set_username("");
    let _ = base.set_password(None);
    Ok(base)
}

/// Opens `target` in the default browser.
pub(super) fn open_in_browser(app: &tauri::AppHandle, target: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|e| format!("Cannot open the browser: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_base_accepts_http_only() {
        assert!(http_base(" https://kb.example ", "Kibana").is_ok());
        assert!(http_base("http://127.0.0.1:5601", "Kibana").is_ok());
        assert_eq!(
            http_base("javascript:alert(1)", "Kibana").unwrap_err(),
            "Kibana URL must start with http:// or https://"
        );
        assert!(http_base("not a url", "Grafana").is_err());
    }

    #[test]
    fn http_base_drops_credentials() {
        let base = http_base("https://elastic:s3cret@kb.example:5601/x", "Kibana").expect("url");
        assert_eq!(base.as_str(), "https://kb.example:5601/x");
    }
}
