use crate::license::types::{ActivateData, LicenseFile, VerifyServerResponse};

const DEFAULT_API_URL: &str = "https://app.lyrashieldai.com";

/// A simple HTTP response wrapper.
pub struct HttpResponse {
    pub status: reqwest::StatusCode,
    pub body: String,
}

/// HTTP client for the LyraShield license + sync API.
pub struct ApiClient {
    base_url: String,
    client: reqwest::Client,
}

#[derive(Debug)]
pub enum VerifyError {
    Offline(String),
    InvalidResponse(String),
}

impl VerifyError {
    pub fn allows_offline_grace(&self) -> bool {
        matches!(self, Self::Offline(_))
    }
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Offline(message) | Self::InvalidResponse(message) => message,
        };
        formatter.write_str(message)
    }
}

#[derive(Debug, serde::Deserialize)]
struct ApiEnvelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<serde_json::Value>,
}

impl ApiClient {
    pub fn new(api_url: Option<String>) -> Result<Self, String> {
        let base_url = resolve_base_url(api_url)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| format!("failed to build HTTP client: {}", e))?;
        Ok(Self { base_url, client })
    }

    /// Workspace API keys authenticate Cloud Sync. They remain in OS keychain
    /// and are attached only to requests made by the native sync client.
    pub fn new_authenticated(api_url: Option<String>, api_key: &str) -> Result<Self, String> {
        if api_key.trim().is_empty() {
            return Err("Cloud Sync API key is not configured".into());
        }
        let base_url = resolve_base_url(api_url)?;
        let mut headers = reqwest::header::HeaderMap::new();
        let value = reqwest::header::HeaderValue::from_str(&format!("Bearer {}", api_key))
            .map_err(|_| "Cloud Sync API key contains invalid HTTP characters".to_string())?;
        headers.insert(reqwest::header::AUTHORIZATION, value);
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .default_headers(headers)
            .build()
            .map_err(|e| format!("failed to build HTTP client: {}", e))?;
        Ok(Self { base_url, client })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Generic POST request.
    pub async fn post(&self, url: &str, body: &serde_json::Value) -> Result<HttpResponse, String> {
        let resp = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("request failed: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read response: {}", e))?;

        Ok(HttpResponse { status, body: text })
    }

    /// Generic GET request.
    pub async fn get(&self, url: &str) -> Result<HttpResponse, String> {
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| format!("request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read response: {}", e))?;
        Ok(HttpResponse { status, body: text })
    }

    /// Generic PUT request.
    pub async fn put(&self, url: &str, body: &serde_json::Value) -> Result<HttpResponse, String> {
        let resp = self
            .client
            .put(url)
            .json(body)
            .send()
            .await
            .map_err(|e| format!("request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read response: {}", e))?;
        Ok(HttpResponse { status, body: text })
    }

    /// `POST /api/licenses/activate` — activate a license key on this machine.
    pub async fn activate(
        &self,
        license_key: &str,
        machine_id: &str,
    ) -> Result<ActivateData, String> {
        let url = format!("{}/api/licenses/activate", self.base_url);
        let body = serde_json::json!({
            "licenseKey": license_key,
            "machineId": machine_id,
        });

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("activate request failed: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read activate response: {}", e))?;

        if status.as_u16() == 409 {
            return Err(format!("MACHINE_CAP_REACHED: {}", text));
        }

        if !status.is_success() {
            return Err(format!("activate failed ({}): {}", status, text));
        }

        let envelope: ApiEnvelope<ActivateData> = serde_json::from_str(&text)
            .map_err(|e| format!("failed to parse activate response: {}", e))?;
        if !envelope.success {
            return Err(format!("activate failed envelope success=false: {}", text));
        }
        let data = envelope
            .data
            .ok_or_else(|| format!("activate response missing data: {}", text))?;
        if data.version != 1 {
            return Err(format!(
                "unsupported activate envelope version: {}",
                data.version
            ));
        }
        Ok(data)
    }

    /// `POST /api/licenses/verify` — server-side revocation check (identified).
    pub async fn verify(
        &self,
        license_file: &LicenseFile,
        license_id: &str,
    ) -> Result<VerifyServerResponse, VerifyError> {
        let url = format!("{}/api/licenses/verify", self.base_url);
        let body = serde_json::json!({
            "licenseFile": license_file,
            "licenseId": license_id,
        });

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|_| VerifyError::Offline("verify request unavailable".into()))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|_| VerifyError::Offline("verify response unavailable".into()))?;

        if !status.is_success() {
            return if status.is_server_error() {
                Err(VerifyError::Offline(format!(
                    "verify service unavailable ({})",
                    status
                )))
            } else {
                Err(VerifyError::InvalidResponse(format!(
                    "verify rejected ({})",
                    status
                )))
            };
        }

        let envelope: ApiEnvelope<VerifyServerResponse> = serde_json::from_str(&text)
            .map_err(|_| VerifyError::InvalidResponse("invalid verify response".into()))?;
        if !envelope.success {
            return Err(VerifyError::InvalidResponse(
                "verify response reported failure".into(),
            ));
        }
        let data = envelope
            .data
            .ok_or_else(|| VerifyError::InvalidResponse("verify response missing data".into()))?;
        if data.version != 1 {
            return Err(VerifyError::InvalidResponse(format!(
                "unsupported verify envelope version: {}",
                data.version
            )));
        }
        Ok(data)
    }
}

fn resolve_base_url(api_url: Option<String>) -> Result<String, String> {
    let Some(api_url) = api_url else {
        return Ok(DEFAULT_API_URL.to_string());
    };
    if !cfg!(debug_assertions) {
        return Err("custom API endpoints are disabled in release builds".into());
    }
    let parsed = reqwest::Url::parse(&api_url).map_err(|_| "invalid API endpoint".to_string())?;
    let is_loopback = parsed.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !is_loopback || !matches!(parsed.scheme(), "http" | "https") {
        return Err("custom API endpoints must use loopback in development".into());
    }
    Ok(api_url.trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_api_endpoint_is_limited_to_development_loopback() {
        assert_eq!(
            resolve_base_url(None).unwrap(),
            "https://app.lyrashieldai.com"
        );
        assert!(resolve_base_url(Some("https://attacker.example".into())).is_err());
        if cfg!(debug_assertions) {
            assert_eq!(
                resolve_base_url(Some("http://127.0.0.1:1234/".into())).unwrap(),
                "http://127.0.0.1:1234"
            );
        }
    }
}
