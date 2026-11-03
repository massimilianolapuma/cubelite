//! Entra ID tokens for Azure Monitor managed Prometheus, from the Azure CLI
//! the user is already logged in with (spec §6). Tokens stay in memory
//! until five minutes before they expire and are never stored.

use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::Value;

use super::PromError;

/// The resource Azure Monitor's query endpoints accept tokens for.
pub const RESOURCE: &str = "https://prometheus.monitor.azure.com";

/// Tokens are refreshed this long before they expire.
const MARGIN: Duration = Duration::from_secs(300);

/// Lifetime assumed when the CLI reports no usable expiry.
const FALLBACK_LIFETIME: Duration = Duration::from_secs(600);

static CACHE: Mutex<Option<(String, SystemTime)>> = Mutex::new(None);

/// Whether `url` is an Azure Monitor query endpoint — the only place an
/// Azure token may be sent.
pub fn is_azure_monitor_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.host_str().is_some_and(|h| {
            h.to_ascii_lowercase()
                .ends_with(".prometheus.monitor.azure.com")
        })
}

/// Token and expiry from `az account get-access-token --output json`
/// (`expires_on` in epoch seconds on current CLIs; older ones only have a
/// local-time `expiresOn`, treated as a short lifetime).
pub fn parse_token(output: &str, now: SystemTime) -> Result<(String, SystemTime), PromError> {
    let v: Value = serde_json::from_str(output)
        .map_err(|e| PromError::Config(format!("Unexpected Azure CLI output: {e}")))?;
    let token = v
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| PromError::Config("The Azure CLI returned no access token".to_string()))?;
    let expires = v
        .get("expires_on")
        .and_then(|e| e.as_u64().or_else(|| e.as_str()?.parse().ok()))
        .map(|secs| UNIX_EPOCH + Duration::from_secs(secs))
        .unwrap_or(now + FALLBACK_LIFETIME);
    Ok((token.to_string(), expires))
}

/// Maps a failed `az` run to what the user should do.
pub fn cli_error(stderr: &str) -> PromError {
    let lower = stderr.to_ascii_lowercase();
    if lower.contains("az login") || lower.contains("please run 'az login'") {
        return PromError::Config(
            "Not logged in to the Azure CLI — run `az login` and try again".to_string(),
        );
    }
    let first = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("unknown error");
    PromError::Config(format!("Azure CLI failed: {first}"))
}

/// A token for Azure Monitor managed Prometheus (cached until it nears expiry).
pub async fn token() -> Result<String, PromError> {
    let now = SystemTime::now();
    if let Ok(cache) = CACHE.lock() {
        if let Some((token, expires)) = cache.as_ref() {
            if now + MARGIN < *expires {
                return Ok(token.clone());
            }
        }
    }
    let output = tokio::process::Command::new("az")
        .args([
            "account",
            "get-access-token",
            "--resource",
            RESOURCE,
            "--output",
            "json",
        ])
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                PromError::Config(
                    "Azure CLI (az) not found — install it or choose another method".to_string(),
                )
            } else {
                PromError::Config(format!("Cannot run the Azure CLI: {e}"))
            }
        })?;
    if !output.status.success() {
        return Err(cli_error(&String::from_utf8_lossy(&output.stderr)));
    }
    let (token, expires) = parse_token(&String::from_utf8_lossy(&output.stdout), now)?;
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((token.clone(), expires));
    }
    Ok(token)
}
