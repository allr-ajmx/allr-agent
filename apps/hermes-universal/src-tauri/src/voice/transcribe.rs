//! The async finalize task: turn a captured turn's PCM into a transcript.
//!
//! Runs off the capture thread on the Tauri (tokio) runtime. The CPU-bound
//! resample/encode/base64 goes on a blocking worker so it stalls neither the
//! reactor nor the realtime capture loop; the POST reuses `TransportState`'s
//! shared reqwest client + cookie jar, so auth is identical to the JS
//! `transcribeAudio` path (headers — incl. `X-Hermes-Session-Token` — come from
//! the hot-swappable `TranscribeTarget`, read fresh at POST time). The result is
//! sent back to the machine as `TurnFinished`; this task emits nothing itself, so
//! the machine stays the single event emitter.

use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde::Deserialize;

use crate::voice::capture::VoiceMsg;
use crate::voice::codec;
use crate::voice::machine::{EmptyReason, FinalizeJob, TurnOutcome};
use crate::voice::TranscribeTarget;

/// Everything the finalize task needs, cloned into the capture thread once at
/// `voice_open`.
#[derive(Clone)]
pub struct TranscribeCtx {
    pub client: reqwest::Client,
    pub target: Arc<RwLock<TranscribeTarget>>,
}

#[derive(Deserialize)]
struct TranscribeResp {
    #[serde(default)]
    transcript: Option<String>,
    #[serde(default)]
    provider: Option<String>,
}

/// Spawn the finalize pipeline; the outcome comes back over `reply` as
/// `VoiceMsg::TurnFinished { turn_id, .. }`.
pub fn spawn_finalize(
    ctx: &TranscribeCtx,
    job: FinalizeJob,
    reply: std::sync::mpsc::Sender<VoiceMsg>,
) {
    let ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        let turn_id = job.turn_id;
        let outcome = finalize(&ctx, job).await;
        let _ = reply.send(VoiceMsg::TurnFinished { turn_id, outcome });
    });
}

async fn finalize(ctx: &TranscribeCtx, job: FinalizeJob) -> TurnOutcome {
    // 1. CPU-bound: resample → encode → data URL, on a blocking worker.
    let FinalizeJob {
        pcm,
        src_rate,
        format,
        ..
    } = job;
    let encoded =
        tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
            let mono16k = codec::resample_to_16k(&pcm, src_rate)?;
            let (bytes, mime) = codec::encode(&mono16k, format)?;
            let data_url = codec::to_data_url(&bytes, &mime)?;
            Ok((data_url, mime))
        })
        .await;

    let (data_url, mime) = match encoded {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            return TurnOutcome::Error {
                code: "encode_failed".into(),
                message: e,
            }
        }
        Err(e) => {
            return TurnOutcome::Error {
                code: "encode_panicked".into(),
                message: e.to_string(),
            }
        }
    };

    // 2. POST. Read the target fresh so a token rotated mid-conversation is used.
    let (base_url, headers) = {
        let t = match ctx.target.read() {
            Ok(t) => t,
            Err(_) => {
                return TurnOutcome::Error {
                    code: "target_poisoned".into(),
                    message: "voice transcribe target lock poisoned".into(),
                }
            }
        };
        (t.base_url.clone(), t.headers.clone())
    };

    let url = format!("{}/api/audio/transcribe", base_url.trim_end_matches('/'));
    let mut req = ctx
        .client
        .post(&url)
        .timeout(Duration::from_secs(60))
        .json(&serde_json::json!({ "data_url": data_url, "mime_type": mime }));
    for (k, v) in headers {
        req = req.header(k, v);
    }

    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return TurnOutcome::Error {
                code: "transcribe_send_failed".into(),
                message: e.to_string(),
            }
        }
    };

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Mirror src/lib/api.ts: a 200-char excerpt of the error body.
        let excerpt: String = body.chars().take(200).collect();
        return TurnOutcome::Error {
            code: format!("transcribe_http_{}", status.as_u16()),
            message: excerpt,
        };
    }

    match serde_json::from_str::<TranscribeResp>(&body) {
        // Empty/whitespace transcript → let the machine map it to turnEmpty; a
        // present transcript flows straight through (the machine trims).
        Ok(r) => match r.transcript {
            Some(text) if !text.trim().is_empty() => TurnOutcome::Transcript {
                text,
                provider: r.provider,
            },
            _ => TurnOutcome::Empty(EmptyReason::NoTranscript),
        },
        Err(e) => TurnOutcome::Error {
            code: "transcribe_bad_json".into(),
            message: e.to_string(),
        },
    }
}
