//! Backend tracing — OpenTelemetry spans exported to a local collector.
//!
//! The frontend has had span tracing since MJXHRM-176, and it stops at the IPC
//! boundary. That boundary is where this app keeps most of its unexplained
//! time: every HTTP request and every WebSocket frame runs in Rust, so a
//! frontend `http.request` span is an opaque box — it knows the call took 400ms
//! and cannot say whether that was DNS, TLS, gateway think-time or
//! deserialization. This is the other half.
//!
//! # Two switches
//!
//! The `tracing` cargo feature decides whether any of this is COMPILED; a
//! default build gets the no-op `imp` below and links no exporter, no
//! subscriber, and no OTel crates at all (`cargo tree` shows zero).
//!
//! `HERMES_TRACE=1` then decides whether it RUNS. So a developer building with
//! `--features tracing` still pays nothing until they ask for a trace, and
//! turning it on never requires a rebuild.
//!
//! The dual-`imp` shape is copied from `updates.rs`, deliberately: same
//! signatures on both sides so nothing above this line changes with the feature.
//!
//! # Why there is no invoke middleware here
//!
//! The obvious way to trace all ~50 commands is to wrap `generate_handler!` via
//! `Builder::invoke_handler`, which does accept a closure. It does not work:
//! `InvokeResolver::respond_async` spawns the future and returns immediately, so
//! a wrapper measures dispatch — microseconds — for the 41 async commands.
//!
//! Tauri's own `tracing` feature does it correctly (it `.instrument()`s the
//! spawned future), so command timing is enabled in Cargo.toml rather than
//! written here. What this module adds is the pieces Tauri cannot know about:
//! the subscriber, the exporter, and the trace context arriving from the
//! webview.

/// Human-readable state, for the startup log line.
#[allow(dead_code)]
pub fn status() -> &'static str {
    if cfg!(feature = "tracing") {
        if imp::enabled() {
            "on"
        } else {
            "compiled, set HERMES_TRACE=1 to enable"
        }
    } else {
        "not compiled (build with --features tracing)"
    }
}

/// Install the subscriber and exporter. Idempotent; safe to call once at boot.
pub fn init() {
    imp::init();
}

/// Flush pending spans. Called on `RunEvent::Exit`.
///
/// Not optional: the batch exporter holds spans in memory and the last batch is
/// usually the interesting one — whatever happened just before the app was
/// closed.
pub fn shutdown() {
    imp::shutdown();
}

#[cfg(feature = "tracing")]
mod imp {
    use std::sync::OnceLock;

    use opentelemetry::{trace::TracerProvider as _, KeyValue};
    use opentelemetry_otlp::WithExportConfig;
    use opentelemetry_sdk::{trace::SdkTracerProvider, Resource};
    use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

    /// Where the collector lives. Overridable because `127.0.0.1` is wrong on a
    /// phone — there it is the device's own loopback, not the dev host, and the
    /// export would fail silently forever. (Android emulator: `10.0.2.2`.)
    const DEFAULT_ENDPOINT: &str = "http://127.0.0.1:4317";

    /// Kept so `shutdown` can flush the same provider `init` created.
    static PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

    pub fn enabled() -> bool {
        std::env::var("HERMES_TRACE").is_ok_and(|v| v != "0" && !v.is_empty())
    }

    fn endpoint() -> String {
        std::env::var("HERMES_TRACE_ENDPOINT").unwrap_or_else(|_| DEFAULT_ENDPOINT.to_string())
    }

    /// Matches the frontend's `hermes.run` label so both halves of one
    /// experiment are findable together in Jaeger.
    fn run_label() -> String {
        std::env::var("HERMES_TRACE_RUN").unwrap_or_else(|_| "local".to_string())
    }

    pub fn init() {
        if !enabled() {
            return;
        }

        // `EnvFilter` rather than a fixed level: Tauri's per-command spans are
        // emitted at DEBUG under `ipc::request::*`, and whether that detail
        // earns its noise is a judgement to make from a real trace, not in
        // advance. `HERMES_TRACE_FILTER=info,hermes_universal_lib=debug` tunes
        // it without a rebuild.
        let filter = EnvFilter::try_from_env("HERMES_TRACE_FILTER")
            .unwrap_or_else(|_| EnvFilter::new("info,hermes_universal_lib=debug,tauri=debug"));

        // MUST be built inside a tokio runtime context.
        //
        // `run()` is a plain fn — Tauri owns the runtime and creates it lazily,
        // so at this point there is no reactor. The tonic channel and the batch
        // processor's background task both need one, and without this the app
        // panics at STARTUP inside hyper-util with "no reactor running" — an
        // error message that points nowhere near telemetry. `block_on` enters
        // the same runtime the rest of the app uses, so the exporter's task
        // lives and dies with it.
        let built = tauri::async_runtime::block_on(async {
            let exporter = opentelemetry_otlp::SpanExporter::builder()
                .with_tonic()
                .with_endpoint(endpoint())
                .build()?;

            Ok::<_, opentelemetry_otlp::ExporterBuildError>(
                SdkTracerProvider::builder()
                    .with_batch_exporter(exporter)
                    .with_resource(
                        Resource::builder()
                            // Same service name as the frontend on purpose: one
                            // service, one waterfall. `hermes.run` is what
                            // separates experiments, not the service name.
                            .with_service_name("hermes-universal")
                            .with_attributes([
                                KeyValue::new("hermes.run", run_label()),
                                KeyValue::new("telemetry.sdk.language", "rust"),
                            ])
                            .build(),
                    )
                    .build(),
            )
        });

        let provider = match built {
            Ok(provider) => provider,
            Err(err) => {
                // A missing collector is the normal case, not an error worth
                // failing boot over. Say so once and carry on untraced.
                eprintln!("[hermes/trace] exporter unavailable ({err}); tracing disabled");
                return;
            }
        };

        let tracer = provider.tracer("hermes.backend");

        // `LogTracer` bridges the existing `log::` calls into the same pipeline.
        // Desktop installs no logger at all today, so those calls currently go
        // nowhere — this is the first time they are visible off Android.
        let _ = tracing_log::LogTracer::init();

        let registry = tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer().with_target(true))
            .with(tracing_opentelemetry::layer().with_tracer(tracer));

        if registry.try_init().is_err() {
            // Something already installed a global subscriber. Nothing to undo,
            // and no reason to take the app down over telemetry.
            eprintln!("[hermes/trace] a global subscriber already exists; skipping");
            return;
        }

        let _ = PROVIDER.set(provider);
        eprintln!("[hermes/trace] exporting to {} as run \"{}\"", endpoint(), run_label());
    }

    pub fn shutdown() {
        let Some(provider) = PROVIDER.get() else {
            return;
        };

        // Inside a runtime for the same reason `init` is: the final export is a
        // network round trip, and `RunEvent::Exit` fires on a plain callback
        // with no reactor. Without this the flush silently does nothing and the
        // last batch — the one covering whatever the user just did — is lost.
        tauri::async_runtime::block_on(async {
            if let Err(err) = provider.force_flush() {
                eprintln!("[hermes/trace] flush on exit failed: {err}");
            }

            if let Err(err) = provider.shutdown() {
                eprintln!("[hermes/trace] shutdown failed: {err}");
            }
        });
    }
}

/// Live smoke test against a real collector.
///
/// `#[ignore]` because it needs the Jaeger stack in ~/Documents/dev-instances
/// running, which CI does not have — but it stays in the tree because it is the
/// only thing that proves the exporter actually reaches a collector rather than
/// merely constructing without error. Run it after touching anything in `imp`:
///
///   HERMES_TRACE=1 HERMES_TRACE_RUN=smoke \
///     cargo test --features tracing -- --ignored --nocapture export_reaches_collector
///
/// Then look for service `hermes-universal`, operation `telemetry.smoke`, at
/// http://localhost:8200.
#[cfg(all(test, feature = "tracing"))]
mod live_export_tests {
    #[test]
    #[ignore = "needs a local OTLP collector on 127.0.0.1:4317"]
    fn export_reaches_collector() {
        assert!(
            super::imp::enabled(),
            "set HERMES_TRACE=1 — this test asserts the real path, not the disabled one"
        );

        super::init();

        tracing::info_span!("telemetry.smoke", check = "rust-exporter").in_scope(|| {
            tracing::info!("hello from the rust backend");
        });

        // The batch processor flushes on shutdown; without this the span is
        // still sitting in memory when the test binary exits.
        super::shutdown();
    }
}

#[cfg(not(feature = "tracing"))]
mod imp {
    /// Same signatures as the real implementation, so everything above this
    /// point is identical in both configurations — the invariant `updates.rs`
    /// documents for `generate_handler!` and that applies just as much here.
    pub fn enabled() -> bool {
        false
    }

    pub fn init() {}

    pub fn shutdown() {}
}
