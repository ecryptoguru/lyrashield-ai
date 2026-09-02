use sha2::{Digest, Sha256};
use std::sync::OnceLock;

/// Generate a stable machine ID for this device.
///
/// Preserve the legacy fingerprint on first upgrade, then keep it in the OS
/// keychain so subsequent hostname changes cannot invalidate an activation.
///
/// On macOS: hostname + macOS + IOPlatformUUID (via ioreg).
/// On Windows: hostname + windows + MachineGuid (via registry).
/// On Linux: hostname + linux + /etc/machine-id.
pub fn generate_machine_id() -> Result<String, String> {
    static MACHINE_ID: OnceLock<String> = OnceLock::new();
    if let Some(value) = MACHINE_ID.get() {
        return Ok(value.clone());
    }
    let unavailable =
        || "Machine identity unavailable; unlock the OS keychain and retry".to_string();
    let entry = machine_id_entry().map_err(|_| unavailable())?;
    let value = persisted_machine_id(
        || match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(unavailable()),
        },
        |value| entry.set_password(value).map_err(|_| unavailable()),
        legacy_machine_id,
    )?;
    Ok(MACHINE_ID.get_or_init(|| value).clone())
}

fn machine_id_entry() -> Result<keyring::Entry, keyring::Error> {
    // Unit tests must never create or read an actual user's keychain entry.
    #[cfg(test)]
    return Ok(keyring::Entry::new_with_credential(Box::new(
        keyring::mock::MockCredential::default(),
    )));
    #[cfg(not(test))]
    keyring::Entry::new("com.lyrashield.desktop", "machine-id-v1")
}

fn persisted_machine_id(
    read: impl FnOnce() -> Result<Option<String>, String>,
    write: impl FnOnce(&str) -> Result<(), String>,
    generate: impl FnOnce() -> String,
) -> Result<String, String> {
    if let Some(value) = read()? {
        if !value.strip_prefix("machine-").is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err("Stored machine identity is invalid".into());
        }
        return Ok(value);
    }
    let value = generate();
    write(&value)?;
    Ok(value)
}

fn legacy_machine_id() -> String {
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
        let id1 = generate_machine_id().unwrap();
        let id2 = generate_machine_id().unwrap();
        assert_eq!(id1, id2, "Machine ID must be stable within a session");
        assert!(id1.starts_with("machine-"));
    }

    #[test]
    fn migration_preserves_legacy_activation_and_ignores_later_hostname_changes() {
        let legacy = format!("machine-{}", "a".repeat(64));
        let saved = std::cell::RefCell::new(None);
        let first = persisted_machine_id(
            || Ok(None),
            |id| {
                *saved.borrow_mut() = Some(id.to_string());
                Ok(())
            },
            || legacy.clone(),
        )
        .unwrap();
        assert_eq!(first, legacy);
        let next = persisted_machine_id(
            || Ok(saved.borrow().clone()),
            |_| panic!("must not replace the saved ID"),
            || panic!("hostname must not be used after migration"),
        )
        .unwrap();
        assert_eq!(next, legacy);
    }

    #[test]
    fn keychain_errors_never_replace_an_existing_identity_or_issue_an_unstored_one() {
        assert!(persisted_machine_id(
            || Err("locked".into()),
            |_| panic!("must not write"),
            || panic!("must not regenerate")
        )
        .is_err());
        assert!(persisted_machine_id(
            || Ok(None),
            |_| Err("locked".into()),
            || format!("machine-{}", "a".repeat(64))
        )
        .is_err());
        assert!(persisted_machine_id(
            || Ok(Some("corrupt".into())),
            |_| panic!("must not overwrite"),
            || panic!("must not regenerate")
        )
        .is_err());
    }
}

/// Minimal hex encoding (avoids adding a hex crate dependency just for this).
mod hex {
    pub fn encode(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}
