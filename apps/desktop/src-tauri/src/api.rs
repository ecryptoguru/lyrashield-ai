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

#[derive(Debug, serde::Deserialize)]
struct ApiEnvelope<T> {
    success: bool,
    data: Option<T>,
    error: Option<serde_json::Value>,
}

impl ApiClient {
    pub fn new(api_url: Option<String>) -> Result<Self, String> {
        let base_url = api_url.unwrap_or_else(|| DEFAULT_API_URL.to_string());
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
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
    ) -> Result<VerifyServerResponse, String> {
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
            .map_err(|e| format!("verify request failed: {}", e))?;

        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read verify response: {}", e))?;

        if !status.is_success() {
            return Err(format!("verify failed ({}): {}", status, text));
        }

        let envelope: ApiEnvelope<VerifyServerResponse> = serde_json::from_str(&text)
            .map_err(|e| format!("failed to parse verify response: {}", e))?;
        if !envelope.success {
            return Err(format!("verify envelope success=false: {}", text));
        }
        let data = envelope
            .data
            .ok_or_else(|| format!("verify response missing data: {}", text))?;
        if data.version != 1 {
            return Err(format!(
                "unsupported verify envelope version: {}",
                data.version
            ));
        }
        Ok(data)
    }

    /// `POST /api/licenses/verify` — identity-only (licenseId) check for startup revalidation without full file.
    pub async fn verify_identity(&self, license_id: &str) -> Result<VerifyServerResponse, String> {
        let url = format!("{}/api/licenses/verify", self.base_url);
        let body = serde_json::json!({
            "licenseId": license_id,
        });
        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("verify request failed: {}", e))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| format!("failed to read verify response: {}", e))?;
        if !status.is_success() {
            return Err(format!("verify failed ({}): {}", status, text));
        }
        let envelope: ApiEnvelope<VerifyServerResponse> = serde_json::from_str(&text)
            .map_err(|e| format!("failed to parse verify response: {}", e))?;
        if !envelope.success {
            return Err(format!("verify envelope success=false: {}", text));
        }
        let data = envelope
            .data
            .ok_or_else(|| format!("verify response missing data: {}", text))?;
        if data.version != 1 {
            return Err(format!(
                "unsupported verify envelope version: {}",
                data.version
            ));
        }
        Ok(data)
    }
}
