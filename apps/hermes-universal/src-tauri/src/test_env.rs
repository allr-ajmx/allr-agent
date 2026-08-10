//! One process-wide lock for tests that touch the environment.
//!
//! `cargo test` runs every test of a crate as threads inside a single process,
//! so `std::env::set_var` is not just logically visible to the other tests — on
//! glibc it can reallocate `environ` underneath a concurrent `getenv`. Any test
//! that writes an env var, and any test that asserts on one, must therefore
//! serialize against every other such test in the crate, not merely against the
//! ones in its own module.
//!
//! Hold the guard for the whole span in which the variable is modified, and
//! restore the previous value before dropping it.

use std::sync::{Mutex, MutexGuard};

static ENV_LOCK: Mutex<()> = Mutex::new(());

/// Serializes environment access across the crate's tests.
///
/// A test that panics while holding the guard poisons the mutex; that failure is
/// already reported on its own, so the poison is recovered rather than cascaded
/// into unrelated tests.
pub(crate) fn env_lock() -> MutexGuard<'static, ()> {
    ENV_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
