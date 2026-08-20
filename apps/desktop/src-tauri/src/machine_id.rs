use sha2::{Digest, Sha256};

/// Generate a stable machine ID for this device.
///
/// The ID is a SHA-256 hash of the hostname + platform + a hardware-derived
/// identifier. It is stored in the OS keychain for stability across reinstalls.
///
/// On macOS: hostname + macOS + IOPlatformUUID (via ioreg).
/// On Windows: hostname + windows + MachineGuid (via registry).
/// On Linux: hostname + linux + /etc/machine-id.
pub fn generate_machine_id() -> String {
    let hostname = hostname().unwrap_or_else(|| "unknown".into());
    let platform = std::env::consts::OS;
    let hw_id = hardware_id().unwrap_or_else(|| "no-hw-id".into());

    let mut hasher = Sha256::new();
    hasher.update(hostname.as_bytes());
    hasher.update(platform.as_bytes());
    hasher.update(hw_id.as_bytes());
    let hash = hasher.finalize();
    format!("machine-{}", hex::encode(&hash))
}

fn hostname() -> Option<String> {
    std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .ok()
        .or_else(|| {
            std::process::Command::new("hostname")
                .output()
                .ok()
                .and_then(|o| String::from_utf8(o.stdout).ok())
                .map(|s| s.trim().to_string())
        })
}

#[cfg(target_os = "macos")]
fn hardware_id() -> Option<String> {
    std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.lines()
                .find(|l| l.contains("IOPlatformUUID"))
                .and_then(|l| l.split('=').nth(1))
                .map(|v| v.trim().trim_matches('"').to_string())
        })
}

#[cfg(target_os = "windows")]
fn hardware_id() -> Option<String> {
    std::process::Command::new("reg")
        .args([
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.lines()
                .find(|l| l.contains("MachineGuid"))
                .and_then(|l| l.split("REG_SZ").nth(1))
                .map(|v| v.trim().to_string())
        })
}

#[cfg(target_os = "linux")]
fn hardware_id() -> Option<String> {
    std::fs::read_to_string("/etc/machine-id")
        .ok()
        .map(|s| s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_machine_id_is_stable() {
        let id1 = generate_machine_id();
        let id2 = generate_machine_id();
        assert_eq!(id1, id2, "Machine ID must be stable within a session");
        assert!(id1.starts_with("machine-"));
    }
}

/// Minimal hex encoding (avoids adding a hex crate dependency just for this).
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}
