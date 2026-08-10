//! Rust-owned voice session (MJX-96).
//!
//! Rust is the single authority for the voice audio lifecycle — device, RMS
//! level, VAD, turn segmentation, pre-roll, encode *and* transcription — driven
//! by the explicit `VoiceMachine` state machine. React is reduced to "submit
//! transcript → speak → arm" and Rust emits **text, not audio** (the base64 clip
//! never crosses IPC).
//!
//! Module split mirrors the pure/impure boundary, which is also the test seam:
//!   * `vad` / `machine` — pure logic, no deps, unit-tested on every target;
//!   * `codec` — pure DSP/encoders (rubato/hound/flacenc);
//!   * `capture` — the cpal stream + the actor loop that drives the machine;
//!   * `transcribe` — the async POST that turns a turn's PCM into text.
//!
//! Cross-platform: capture runs wherever cpal does (ALSA/CoreAudio/WASAPI, plus
//! AAudio-oboe on Android and CoreAudio on iOS). See `Cargo.toml` for the mobile
//! build requirements (Android NDK/oboe; iOS `AVAudioSession` is stubbed pending
//! MJX-93).
//!
//! Wire contract (mirrors `pty://` / `ws://`): the client picks a `uuid`,
//! subscribes to every `voice://{id}/…` topic BEFORE invoking `voice_open`, then
//! drives the session with `voice_arm` / `voice_suspend` / `voice_force_turn` /
//! `voice_close` and refreshes auth with `voice_update_auth`.

pub mod capture;
pub mod codec;
pub mod machine;
pub mod transcribe;
pub mod vad;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::thread::JoinHandle;

use serde::Deserialize;
use tauri::State;

use capture::{VoiceCmd, VoiceMsg};
use machine::{ArmMode, ClipFormat, VoiceConfig};
use transcribe::TranscribeCtx;

/// Where transcription POSTs go. Hot-swappable (`voice_update_auth`) so a token
/// rotated mid-conversation is used on the next turn without reopening the device.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeTarget {
    pub base_url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
}

/// Optional VAD/turn overrides from JS; anything omitted falls back to the tuned
/// defaults (`VoiceConfig::tuned`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceVadOverrides {
    pub speech_level: Option<f32>,
    pub bargein_speech_level: Option<f32>,
    pub onset_ms: Option<u64>,
    pub bargein_onset_ms: Option<u64>,
    pub silence_ms: Option<u64>,
    pub idle_silence_ms: Option<u64>,
    pub max_turn_ms: Option<u64>,
    pub min_turn_ms: Option<u64>,
    pub preroll_ms: Option<u64>,
}

/// The one live voice session (at most one device open at a time — the single-
/// authority invariant). Cleared on `voice_close` / shutdown.
#[derive(Default)]
pub struct VoiceState(Mutex<Option<VoiceHandle>>);

struct VoiceHandle {
    #[allow(dead_code)]
    id: String,
    tx: std::sync::mpsc::Sender<VoiceMsg>,
    join: JoinHandle<()>,
    /// Shared with the capture thread's transcribe context, so a write here is
    /// seen by the next POST.
    target: Arc<RwLock<TranscribeTarget>>,
}

fn build_config(vad: Option<VoiceVadOverrides>, format: Option<String>) -> VoiceConfig {
    let mut cfg = VoiceConfig::tuned();
    if let Some(v) = vad {
        if let Some(x) = v.speech_level {
            cfg.speech_level = x;
        }
        if let Some(x) = v.bargein_speech_level {
            cfg.bargein_speech_level = x;
        }
        if let Some(x) = v.onset_ms {
            cfg.onset_ms = x;
        }
        if let Some(x) = v.bargein_onset_ms {
            cfg.bargein_onset_ms = x;
        }
        if let Some(x) = v.silence_ms {
            cfg.silence_ms = x;
        }
        if let Some(x) = v.idle_silence_ms {
            cfg.idle_silence_ms = x;
        }
        if let Some(x) = v.max_turn_ms {
            cfg.max_turn_ms = x;
        }
        if let Some(x) = v.min_turn_ms {
            cfg.min_turn_ms = x;
        }
        if let Some(x) = v.preroll_ms {
            cfg.preroll_ms = x;
        }
    }
    cfg.format = match format.as_deref() {
        Some("flac") => ClipFormat::Flac,
        _ => ClipFormat::Wav,
    };
    cfg
}

/// Open the device and start the session. The client subscribes to the
/// `voice://{id}/…` topics before calling this; a device-open failure is returned
/// synchronously (`no_input_device`, `stream_build`, …) exactly as the old
/// `audio_start_recording` did.
#[tauri::command]
pub async fn voice_open(
    app: tauri::AppHandle,
    transport: State<'_, crate::transport::TransportState>,
    voice: State<'_, VoiceState>,
    id: String,
    target: TranscribeTarget,
    vad: Option<VoiceVadOverrides>,
    format: Option<String>,
) -> Result<(), String> {
    {
        let guard = voice.0.lock().map_err(|_| "voice_state_poisoned")?;
        if guard.is_some() {
            return Err("already_open".into());
        }
    }

    let cfg = build_config(vad, format);
    let target = Arc::new(RwLock::new(target));
    let ctx = TranscribeCtx { client: transport.client().clone(), target: target.clone() };

    let (tx, join) = capture::open_session(app, id.clone(), cfg, ctx)?;

    let mut guard = voice.0.lock().map_err(|_| "voice_state_poisoned")?;
    if guard.is_some() {
        // Lost a race to another open between our check and here — tear this one
        // down rather than leak a second device.
        let _ = tx.send(VoiceMsg::Cmd(VoiceCmd::Close));
        let _ = join.join();
        return Err("already_open".into());
    }
    *guard = Some(VoiceHandle { id, tx, join, target });
    Ok(())
}

fn send_cmd(voice: &State<'_, VoiceState>, cmd: VoiceCmd) -> Result<(), String> {
    let guard = voice.0.lock().map_err(|_| "voice_state_poisoned")?;
    match guard.as_ref() {
        Some(h) => h.tx.send(VoiceMsg::Cmd(cmd)).map_err(|_| "voice_session_gone".into()),
        None => Err("not_open".into()),
    }
}

#[tauri::command]
pub async fn voice_arm(voice: State<'_, VoiceState>, mode: Option<String>) -> Result<(), String> {
    let mode = match mode.as_deref() {
        Some("bargein") => ArmMode::BargeIn,
        _ => ArmMode::Normal,
    };
    send_cmd(&voice, VoiceCmd::Arm(mode))
}

/// Enter hands-free wake listening: the device stays open and batches of 16 kHz
/// int16 arrive as `voice://{id}/wakeFrame` (base64), which the frontend pushes at
/// the gateway's `wake.feed`. Only meaningful from `Idle` — a live turn keeps the
/// device. Detection is the gateway's; it comes back as a `wake.detected` event,
/// and the frontend answers with `voice_arm`.
#[tauri::command]
pub async fn voice_wake_listen(voice: State<'_, VoiceState>) -> Result<(), String> {
    send_cmd(&voice, VoiceCmd::WakeListen)
}

#[tauri::command]
pub async fn voice_suspend(voice: State<'_, VoiceState>) -> Result<(), String> {
    send_cmd(&voice, VoiceCmd::Suspend)
}

#[tauri::command]
pub async fn voice_force_turn(voice: State<'_, VoiceState>) -> Result<(), String> {
    send_cmd(&voice, VoiceCmd::ForceTurn)
}

#[tauri::command]
pub async fn voice_update_auth(
    voice: State<'_, VoiceState>,
    target: TranscribeTarget,
) -> Result<(), String> {
    let guard = voice.0.lock().map_err(|_| "voice_state_poisoned")?;
    match guard.as_ref() {
        Some(h) => {
            let mut t = h.target.write().map_err(|_| "target_poisoned")?;
            *t = target;
            Ok(())
        }
        None => Err("not_open".into()),
    }
}

#[tauri::command]
pub async fn voice_close(voice: State<'_, VoiceState>) -> Result<(), String> {
    // Take the handle out first so a concurrent command sees `not_open`, then ask
    // the machine to close (emits Closing/Closed) and join so the device is
    // released before we return.
    let handle = { voice.0.lock().map_err(|_| "voice_state_poisoned")?.take() };
    if let Some(h) = handle {
        let _ = h.tx.send(VoiceMsg::Cmd(VoiceCmd::Close));
        let _ = h.join.join();
    }
    Ok(())
}
