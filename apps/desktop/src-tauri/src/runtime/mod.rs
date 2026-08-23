pub mod detect;
pub mod spawn;

pub use detect::{get_runtime_status, resolve_engine_bin, RuntimeStatus};
pub use spawn::run_engine_command;
