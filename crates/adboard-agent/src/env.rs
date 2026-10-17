//! Settings from the environment.
//!
//! ADBoard reads `ADBOARD_<NAME>`. Legacy compatibility: the pre-rename
//! `PHONECONTROL_<NAME>` is still read when the new name is not set, so an
//! existing run.bat, .env or service unit keeps its password, token and bind
//! address after the update. A one-time warning names the new variable.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

pub const PREFIX: &str = "ADBOARD_";
/// Legacy compatibility only (product was renamed).
const LEGACY_PREFIX: &str = "PHONECONTROL_";

fn warned() -> &'static Mutex<HashSet<String>> {
    static WARNED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    WARNED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// `ADBOARD_<name>`, else the legacy `PHONECONTROL_<name>`.
pub fn var(name: &str) -> Result<String, std::env::VarError> {
    match std::env::var(format!("{PREFIX}{name}")) {
        Ok(value) => Ok(value),
        Err(error) => match std::env::var(format!("{LEGACY_PREFIX}{name}")) {
            Ok(value) => {
                let first = warned().lock().map(|mut set| set.insert(name.to_string())).unwrap_or(false);
                if first {
                    tracing::warn!("{LEGACY_PREFIX}{name} is the old name; use {PREFIX}{name}");
                }
                Ok(value)
            }
            Err(_) => Err(error),
        },
    }
}

/// `1`, `true` or `yes` (any case of the first letter as before).
pub fn truthy(name: &str) -> bool {
    matches!(var(name).as_deref(), Ok("1") | Ok("true") | Ok("TRUE") | Ok("yes") | Ok("YES"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_name_wins_and_legacy_name_still_works() {
        std::env::remove_var("ADBOARD_ENVTEST_A");
        std::env::set_var("PHONECONTROL_ENVTEST_A", "legacy");
        assert_eq!(var("ENVTEST_A").as_deref(), Ok("legacy"));
        std::env::set_var("ADBOARD_ENVTEST_A", "new");
        assert_eq!(var("ENVTEST_A").as_deref(), Ok("new"));
        std::env::remove_var("ADBOARD_ENVTEST_A");
        std::env::remove_var("PHONECONTROL_ENVTEST_A");
        assert!(var("ENVTEST_A").is_err());
        std::env::set_var("ADBOARD_ENVTEST_B", "yes");
        assert!(truthy("ENVTEST_B"));
        std::env::remove_var("ADBOARD_ENVTEST_B");
        assert!(!truthy("ENVTEST_B"));
    }
}
