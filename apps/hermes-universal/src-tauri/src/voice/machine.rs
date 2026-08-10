//! The pure `VoiceSession` state machine (MJX-96).
//!
//! `step(input, &mut out)` is a **pure function** of the machine's own fields —
//! no cpal, no tauri, no reqwest, no clock reads. Timing is driven by a sample
//! clock advanced by `Frames` inputs (`samples_seen * 1000 / src_rate`), so every
//! transition is deterministic and testable with synthetic RMS and no device.
//! The impure host (`voice/capture.rs`) owns the cpal stream, calls `step` on the
//! capture thread, and applies the returned `VoiceEffect`s — it is the *single
//! emitter*, so effect order is the wire order the frontend observes.
//!
//! Rust's eight `VoiceStateKind`s are not the same as React's `ConversationStatus`
//! (there is deliberately no `Speaking` here — playback is React's concern). See
//! the MJX-96 plan.

use std::collections::VecDeque;

use serde::Serialize;

use crate::voice::vad::{Vad, VadConfig, VadEvent, LEVEL_EMIT_MS};

// ---------------------------------------------------------------------------
// Wire enums (serialized into `voice://{id}/*` payloads by the capture host).
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceStateKind {
    Opening,
    Idle,
    /// Hands-free wake listening: the device is hot but nothing is captured for a
    /// turn. Batches of raw audio are handed to the host, which resamples them to
    /// 16 kHz int16 and pushes them at the gateway's `wake.feed` — openWakeWord
    /// runs server-side, this end only supplies the microphone it doesn't have.
    /// Detection comes back as a `wake.detected` gateway event, and the frontend
    /// turns that into an `Arm` (see `on_arm`).
    WakeListening,
    Armed,
    Recording,
    Finalizing,
    Closing,
    Closed,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArmMode {
    Normal,
    BargeIn,
}

/// Output container format. Lives here (dependency-free) so `VoiceConfig` can name
/// it on every target; `voice/codec.rs` (desktop) maps it to an encoder.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ClipFormat {
    Wav,
    Flac,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EmptyReason {
    /// Turn forced while Armed with nothing captured.
    NoSpeech,
    /// Captured clip shorter than `min_turn_ms` — never sent to the gateway.
    TooShort,
    /// Gateway returned an empty/whitespace transcript.
    NoTranscript,
}

/// The outcome of the async transcription task, fed back in via
/// `VoiceInput::TurnFinished`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TurnOutcome {
    Transcript {
        text: String,
        provider: Option<String>,
    },
    Empty(EmptyReason),
    Error {
        code: String,
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Effects & inputs.
// ---------------------------------------------------------------------------

/// A finalized turn's audio, handed to the async worker to resample/encode/POST.
#[derive(Clone, Debug, PartialEq)]
pub struct FinalizeJob {
    pub turn_id: u64,
    pub pcm: Vec<f32>,
    pub src_rate: u32,
    pub duration_ms: u64,
    pub format: ClipFormat,
}

/// Payload for a `voice://{id}/{topic}` event. `#[serde(untagged)]` so each
/// variant serializes as its bare inner value; `None` becomes `null` (used for
/// the payload-less `speechStart` / `idleTimeout` topics).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum EmitPayload {
    None,
    State(VoiceStateKind),
    Level(f32),
    Transcript {
        text: String,
        provider: Option<String>,
        #[serde(rename = "durationMs")]
        duration_ms: u64,
    },
    TurnEmpty {
        reason: EmptyReason,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub enum VoiceEffect {
    /// `(topic_suffix, payload)` → `app.emit("voice://{id}/{topic}", payload)`.
    Emit(&'static str, EmitPayload),
    /// Resample + encode + POST this turn off-thread, then reply `TurnFinished`.
    Finalize(FinalizeJob),
    /// One `wake_batch_ms` batch of raw device-rate mono, for the host to resample
    /// to 16 kHz int16 and forward to `wake.feed`. Deliberately NOT an `Emit`: the
    /// payload is audio and needs the host's resampler/encoder before it can cross
    /// IPC, and keeping the conversion out here is what keeps this module pure.
    WakeAudio(Vec<f32>),
    /// The capture loop should drop the cpal stream and exit.
    Shutdown,
}

pub enum VoiceInput<'a> {
    /// One cpal callback's worth of mono frames at the device's native rate, plus
    /// that block's normalized RMS.
    Frames {
        mono: &'a [f32],
        rms: f32,
    },
    Arm(ArmMode),
    /// Enter hands-free wake listening (only meaningful from `Idle`).
    WakeListen,
    Suspend,
    ForceTurn,
    Close,
    TurnFinished {
        turn_id: u64,
        outcome: TurnOutcome,
    },
    StreamError(String),
}

// ---------------------------------------------------------------------------
// Config.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug)]
pub struct VoiceConfig {
    pub speech_level: f32,
    pub bargein_speech_level: f32,
    pub onset_ms: u64,
    pub bargein_onset_ms: u64,
    pub silence_ms: u64,
    pub idle_silence_ms: u64,
    pub max_turn_ms: u64,
    /// Clips shorter than this yield `turnEmpty(TooShort)` and never hit the network.
    pub min_turn_ms: u64,
    pub preroll_ms: u64,
    /// How much audio one `WakeAudio` batch carries. 320 ms is four of the
    /// detector's 80 ms frames — the same batching desktop's `wake-client-capture`
    /// uses, which keeps `wake.feed` at ~3 RPCs/s while adding a detection latency
    /// nobody can hear.
    pub wake_batch_ms: u64,
    pub format: ClipFormat,
}

impl VoiceConfig {
    /// The tuned defaults, matching `use-voice-conversation.ts` (`silenceLevel
    /// 0.075`, `silenceMs 1250`, `idleSilenceMs 12000`) and the JS 60 s turn cap.
    pub fn tuned() -> Self {
        Self {
            speech_level: 0.075,
            bargein_speech_level: 0.16,
            onset_ms: 0,
            bargein_onset_ms: 300,
            silence_ms: 1_250,
            idle_silence_ms: 12_000,
            max_turn_ms: 60_000,
            min_turn_ms: 250,
            preroll_ms: 300,
            wake_batch_ms: 320,
            format: ClipFormat::Wav,
        }
    }

    fn level_for(&self, mode: ArmMode) -> f32 {
        match mode {
            ArmMode::Normal => self.speech_level,
            ArmMode::BargeIn => self.bargein_speech_level,
        }
    }

    fn onset_for(&self, mode: ArmMode) -> u64 {
        match mode {
            ArmMode::Normal => self.onset_ms,
            ArmMode::BargeIn => self.bargein_onset_ms,
        }
    }
}

// ---------------------------------------------------------------------------
// Pre-roll ring.
// ---------------------------------------------------------------------------

/// A short ring of the most recent Armed audio, prepended to a turn on speech
/// onset so the first syllable isn't clipped. Sized to `preroll_ms + onset_ms`
/// worth of samples so barge-in's onset-confirmation delay doesn't eat the roll.
struct PreRoll {
    buf: VecDeque<f32>,
    cap: usize,
}

impl PreRoll {
    fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::with_capacity(cap + 4096),
            cap,
        }
    }

    fn set_cap(&mut self, cap: usize) {
        self.cap = cap;
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
    }

    fn clear(&mut self) {
        self.buf.clear();
    }

    fn push(&mut self, frame: &[f32]) {
        self.buf.extend(frame.iter().copied());
        while self.buf.len() > self.cap {
            self.buf.pop_front();
        }
    }

    fn drain_into(&mut self, dst: &mut Vec<f32>) {
        dst.extend(self.buf.drain(..));
    }
}

fn preroll_cap(src_rate: u32, ms: u64) -> usize {
    (src_rate as u64 * ms / 1_000) as usize
}

// ---------------------------------------------------------------------------
// The machine.
// ---------------------------------------------------------------------------

pub struct VoiceMachine {
    cfg: VoiceConfig,
    src_rate: u32,
    state: VoiceStateKind,
    vad: Vad,
    mode: ArmMode,
    /// An `Arm` requested while Finalizing, applied on reaching Idle so barge-in
    /// during transcription doesn't require a second IPC round trip.
    pending_arm: Option<ArmMode>,
    preroll: PreRoll,
    turn: Vec<f32>,
    /// Accumulates device-rate audio while `WakeListening`, flushed as one
    /// `WakeAudio` effect every `wake_batch_ms`.
    wake_buf: Vec<f32>,
    wake_batch_samples: usize,
    turn_id: u64,
    samples_seen: u64,
    last_level_ms: u64,
    last_duration_ms: u64,
    /// Current mode's speech threshold, mirrored so `on_frames` can classify a
    /// block as voiced without going through the VAD.
    cur_speech_level: f32,
    /// Sample-clock marks for the in-flight turn, used to gate `min_turn_ms` on
    /// *voiced* length rather than total clip length (which always carries the
    /// ~`silence_ms` trailing silence that ended the turn).
    recording_start_samples: u64,
    last_voice_samples: u64,
}

impl VoiceMachine {
    pub fn new(cfg: VoiceConfig, src_rate: u32) -> Self {
        let vad = Vad::new(VadConfig {
            speech_level: cfg.speech_level,
            onset_ms: cfg.onset_ms,
            silence_ms: cfg.silence_ms,
            idle_silence_ms: cfg.idle_silence_ms,
            max_turn_ms: cfg.max_turn_ms,
        });
        let cap = preroll_cap(src_rate, cfg.preroll_ms + cfg.onset_ms);
        let wake_batch_samples = (src_rate as u64 * cfg.wake_batch_ms / 1_000).max(1) as usize;
        Self {
            cfg,
            src_rate,
            state: VoiceStateKind::Opening,
            vad,
            mode: ArmMode::Normal,
            pending_arm: None,
            preroll: PreRoll::new(cap),
            turn: Vec::new(),
            wake_buf: Vec::with_capacity(wake_batch_samples + 4096),
            wake_batch_samples,
            turn_id: 0,
            samples_seen: 0,
            last_level_ms: 0,
            last_duration_ms: 0,
            cur_speech_level: cfg.speech_level,
            recording_start_samples: 0,
            last_voice_samples: 0,
        }
    }

    pub fn kind(&self) -> VoiceStateKind {
        self.state
    }

    /// Called by the capture host once the device stream is playing: leaves the
    /// transient `Opening` state and announces `Idle`.
    pub fn boot(&mut self, out: &mut Vec<VoiceEffect>) {
        if self.state == VoiceStateKind::Opening {
            self.state = VoiceStateKind::Idle;
            out.push(emit_state(VoiceStateKind::Idle));
        }
    }

    pub fn step(&mut self, input: VoiceInput<'_>, out: &mut Vec<VoiceEffect>) {
        match input {
            VoiceInput::Frames { mono, rms } => self.on_frames(mono, rms, out),
            VoiceInput::Arm(mode) => self.on_arm(mode, out),
            VoiceInput::WakeListen => self.on_wake_listen(out),
            VoiceInput::Suspend => self.on_suspend(out),
            VoiceInput::ForceTurn => self.on_force_turn(out),
            VoiceInput::Close => self.on_close(out),
            VoiceInput::TurnFinished { turn_id, outcome } => {
                self.on_turn_finished(turn_id, outcome, out)
            }
            VoiceInput::StreamError(e) => self.on_stream_error(e, out),
        }
    }

    fn now_ms(&self) -> u64 {
        if self.src_rate == 0 {
            0
        } else {
            self.samples_seen * 1_000 / self.src_rate as u64
        }
    }

    fn samples_to_ms(&self, samples: usize) -> u64 {
        if self.src_rate == 0 {
            0
        } else {
            samples as u64 * 1_000 / self.src_rate as u64
        }
    }

    fn on_frames(&mut self, mono: &[f32], rms: f32, out: &mut Vec<VoiceEffect>) {
        self.samples_seen += mono.len() as u64;
        let now = self.now_ms();

        // Throttled level meter, only while the mic is "hot" (Armed/Recording).
        if matches!(
            self.state,
            VoiceStateKind::Armed | VoiceStateKind::Recording
        ) && now.saturating_sub(self.last_level_ms) >= LEVEL_EMIT_MS
        {
            self.last_level_ms = now;
            out.push(VoiceEffect::Emit("level", EmitPayload::Level(rms)));
        }

        match self.state {
            VoiceStateKind::Armed => {
                // Push THIS frame into the ring before asking the VAD, so on onset
                // the ring drains ending exactly at this frame — contiguous with
                // the next Recording frame, no gap and no duplicate.
                self.preroll.push(mono);
                match self.vad.observe_armed(rms, now) {
                    Some(VadEvent::SpeechStart) => {
                        self.turn.clear();
                        self.preroll.drain_into(&mut self.turn);
                        self.state = VoiceStateKind::Recording;
                        self.vad.begin_recording(now);
                        self.recording_start_samples = self.samples_seen;
                        self.last_voice_samples = self.samples_seen;
                        out.push(VoiceEffect::Emit("speechStart", EmitPayload::None));
                        out.push(emit_state(VoiceStateKind::Recording));
                    }
                    Some(VadEvent::IdleTimeout) => {
                        out.push(VoiceEffect::Emit("idleTimeout", EmitPayload::None));
                    }
                    _ => {}
                }
            }
            VoiceStateKind::Recording => {
                self.turn.extend_from_slice(mono);
                if rms >= self.cur_speech_level {
                    self.last_voice_samples = self.samples_seen;
                }
                if let Some(VadEvent::TurnEnd | VadEvent::MaxTurn) =
                    self.vad.observe_recording(rms, now)
                {
                    self.finalize_turn(out);
                }
            }
            VoiceStateKind::WakeListening => {
                // No VAD here: the wake detector is the gateway's, and a local VAD
                // gate would starve it of the quiet frames it needs. Batch and
                // forward, nothing else — in particular there is no idle timeout,
                // because hands-free listening is meant to last indefinitely.
                self.wake_buf.extend_from_slice(mono);
                if self.wake_buf.len() >= self.wake_batch_samples {
                    out.push(VoiceEffect::WakeAudio(std::mem::take(&mut self.wake_buf)));
                }
            }
            // Idle / Opening / Finalizing / Closing / Closed: discard audio.
            _ => {}
        }
    }

    fn finalize_turn(&mut self, out: &mut Vec<VoiceEffect>) {
        let duration_ms = self.samples_to_ms(self.turn.len());
        // Gate on VOICED length (onset → last loud frame), not total clip length:
        // a turn always ends with ~silence_ms of trailing silence, so total length
        // is never short. This rejects a stray blip that tripped onset then went
        // quiet, without paying for a network round trip.
        let voiced_samples = self
            .last_voice_samples
            .saturating_sub(self.recording_start_samples);
        let voiced_ms = self.samples_to_ms(voiced_samples as usize);
        if voiced_ms < self.cfg.min_turn_ms {
            self.turn.clear();
            self.go_idle(out, Some(EmptyReason::TooShort));
            return;
        }
        self.turn_id += 1;
        self.last_duration_ms = duration_ms;
        let job = FinalizeJob {
            turn_id: self.turn_id,
            pcm: std::mem::take(&mut self.turn),
            src_rate: self.src_rate,
            duration_ms,
            format: self.cfg.format,
        };
        self.state = VoiceStateKind::Finalizing;
        out.push(emit_state(VoiceStateKind::Finalizing));
        out.push(VoiceEffect::Finalize(job));
    }

    fn on_arm(&mut self, mode: ArmMode, out: &mut Vec<VoiceEffect>) {
        match self.state {
            VoiceStateKind::Idle => self.do_arm(mode, out),
            // The wake word fired: the frontend saw `wake.detected` and is turning
            // hands-free listening into a real turn. Drop the un-flushed wake batch
            // — it is the wake phrase itself, which the agent must not be asked.
            VoiceStateKind::WakeListening => {
                self.wake_buf.clear();
                self.do_arm(mode, out);
            }
            VoiceStateKind::Armed => {
                // Already listening: adjust thresholds if the mode changed, but do
                // not emit a redundant state transition.
                if mode != self.mode {
                    self.apply_mode(mode);
                }
            }
            // Queue and apply on reaching Idle (barge-in during transcription).
            VoiceStateKind::Finalizing => self.pending_arm = Some(mode),
            _ => {}
        }
    }

    fn do_arm(&mut self, mode: ArmMode, out: &mut Vec<VoiceEffect>) {
        self.apply_mode(mode);
        self.preroll.clear();
        let now = self.now_ms();
        self.vad.arm(now);
        self.state = VoiceStateKind::Armed;
        out.push(emit_state(VoiceStateKind::Armed));
    }

    fn apply_mode(&mut self, mode: ArmMode) {
        self.mode = mode;
        self.cur_speech_level = self.cfg.level_for(mode);
        self.vad
            .set_thresholds(self.cfg.level_for(mode), self.cfg.onset_for(mode));
        self.preroll.set_cap(preroll_cap(
            self.src_rate,
            self.cfg.preroll_ms + self.cfg.onset_for(mode),
        ));
    }

    /// Enter hands-free wake listening. Only from `Idle`: a live turn (Armed /
    /// Recording / Finalizing) outranks the wake listener, and letting wake grab
    /// the device mid-turn is exactly the mic contention this machine exists to
    /// make impossible.
    fn on_wake_listen(&mut self, out: &mut Vec<VoiceEffect>) {
        if self.state != VoiceStateKind::Idle {
            return;
        }
        self.turn.clear();
        self.preroll.clear();
        self.wake_buf.clear();
        self.state = VoiceStateKind::WakeListening;
        out.push(emit_state(VoiceStateKind::WakeListening));
    }

    fn on_suspend(&mut self, out: &mut Vec<VoiceEffect>) {
        if matches!(
            self.state,
            VoiceStateKind::Armed | VoiceStateKind::Recording | VoiceStateKind::WakeListening
        ) {
            self.turn.clear();
            self.preroll.clear();
            self.wake_buf.clear();
            self.state = VoiceStateKind::Idle;
            out.push(emit_state(VoiceStateKind::Idle));
        }
    }

    fn on_force_turn(&mut self, out: &mut Vec<VoiceEffect>) {
        match self.state {
            VoiceStateKind::Recording => self.finalize_turn(out),
            VoiceStateKind::Armed => self.go_idle(out, Some(EmptyReason::NoSpeech)),
            _ => {}
        }
    }

    fn on_close(&mut self, out: &mut Vec<VoiceEffect>) {
        if matches!(self.state, VoiceStateKind::Closed | VoiceStateKind::Closing) {
            return;
        }
        self.turn.clear();
        self.preroll.clear();
        self.wake_buf.clear();
        self.pending_arm = None;
        self.state = VoiceStateKind::Closing;
        out.push(emit_state(VoiceStateKind::Closing));
        self.state = VoiceStateKind::Closed;
        out.push(emit_state(VoiceStateKind::Closed));
        out.push(VoiceEffect::Shutdown);
    }

    fn on_turn_finished(&mut self, turn_id: u64, outcome: TurnOutcome, out: &mut Vec<VoiceEffect>) {
        // Drop a result for a turn that was superseded (a newer turn, or a
        // suspend/close cleared Finalizing). This is the old `id_mismatch` class,
        // now a pure branch.
        if self.state != VoiceStateKind::Finalizing || turn_id != self.turn_id {
            return;
        }
        match outcome {
            TurnOutcome::Transcript { text, provider } => {
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    self.go_idle(out, Some(EmptyReason::NoTranscript));
                } else {
                    out.push(VoiceEffect::Emit(
                        "transcript",
                        EmitPayload::Transcript {
                            text: trimmed.to_string(),
                            provider,
                            duration_ms: self.last_duration_ms,
                        },
                    ));
                    self.go_idle(out, None);
                }
            }
            TurnOutcome::Empty(reason) => self.go_idle(out, Some(reason)),
            TurnOutcome::Error { code, message } => {
                out.push(VoiceEffect::Emit(
                    "error",
                    EmitPayload::Error { code, message },
                ));
                self.go_idle(out, None);
            }
        }
    }

    fn on_stream_error(&mut self, message: String, out: &mut Vec<VoiceEffect>) {
        out.push(VoiceEffect::Emit(
            "error",
            EmitPayload::Error {
                code: "device_lost".into(),
                message,
            },
        ));
        self.turn.clear();
        self.preroll.clear();
        self.wake_buf.clear();
        self.pending_arm = None;
        self.state = VoiceStateKind::Closing;
        out.push(emit_state(VoiceStateKind::Closing));
        self.state = VoiceStateKind::Closed;
        out.push(emit_state(VoiceStateKind::Closed));
        out.push(VoiceEffect::Shutdown);
    }

    /// Transition to Idle after a turn, optionally emitting `turnEmpty` *before*
    /// the `state: Idle` — so the frontend always sees the turn outcome before it
    /// is told to re-arm. Applies any `pending_arm` queued during Finalizing.
    fn go_idle(&mut self, out: &mut Vec<VoiceEffect>, empty: Option<EmptyReason>) {
        if let Some(reason) = empty {
            out.push(VoiceEffect::Emit(
                "turnEmpty",
                EmitPayload::TurnEmpty { reason },
            ));
        }
        self.state = VoiceStateKind::Idle;
        out.push(emit_state(VoiceStateKind::Idle));
        if let Some(mode) = self.pending_arm.take() {
            self.do_arm(mode, out);
        }
    }
}

fn emit_state(kind: VoiceStateKind) -> VoiceEffect {
    VoiceEffect::Emit("state", EmitPayload::State(kind))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: u32 = 16_000; // 1 ms = 16 samples

    fn machine() -> VoiceMachine {
        let mut m = VoiceMachine::new(VoiceConfig::tuned(), RATE);
        let mut out = Vec::new();
        m.boot(&mut out);
        assert_eq!(out, vec![emit_state(VoiceStateKind::Idle)]);
        m
    }

    /// `n` mono frames all at `amp`, plus that block's RMS (== |amp| for a
    /// constant block).
    fn block(n: usize, amp: f32) -> (Vec<f32>, f32) {
        (vec![amp; n], amp.abs())
    }

    /// Feed `ms` milliseconds of audio at `amp` in one block and return the effects.
    fn feed(m: &mut VoiceMachine, ms: u64, amp: f32) -> Vec<VoiceEffect> {
        let n = (RATE as u64 * ms / 1_000) as usize;
        let (mono, rms) = block(n, amp);
        let mut out = Vec::new();
        m.step(VoiceInput::Frames { mono: &mono, rms }, &mut out);
        out
    }

    fn states(effects: &[VoiceEffect]) -> Vec<VoiceStateKind> {
        effects
            .iter()
            .filter_map(|e| match e {
                VoiceEffect::Emit("state", EmitPayload::State(k)) => Some(*k),
                _ => None,
            })
            .collect()
    }

    fn topics(effects: &[VoiceEffect]) -> Vec<&'static str> {
        effects
            .iter()
            .filter_map(|e| match e {
                VoiceEffect::Emit(t, _) => Some(*t),
                _ => None,
            })
            .collect()
    }

    const LOUD: f32 = 0.5;
    const QUIET: f32 = 0.0;

    #[test]
    fn arm_then_onset_emits_speech_start_and_recording() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        assert_eq!(states(&out), vec![VoiceStateKind::Armed]);

        let e = feed(&mut m, 20, LOUD);
        assert_eq!(m.kind(), VoiceStateKind::Recording);
        // speechStart precedes the state:Recording emit.
        let idx_speech = topics(&e).iter().position(|t| *t == "speechStart").unwrap();
        let idx_state = topics(&e).iter().position(|t| *t == "state").unwrap();
        assert!(idx_speech < idx_state);
    }

    #[test]
    fn preroll_is_prepended_contiguously_on_onset() {
        // Distinct amplitudes per block so we can see the join. Arm, feed a quiet
        // pre-roll block, then a loud block that triggers onset.
        let mut m = VoiceMachine::new(VoiceConfig::tuned(), RATE);
        let mut out = Vec::new();
        m.boot(&mut out);
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);

        // 100 ms of quiet-but-nonzero pre-roll (below speech_level so no onset).
        let pre_amp = 0.01f32;
        let pre = vec![pre_amp; (RATE / 10) as usize];
        out.clear();
        m.step(
            VoiceInput::Frames {
                mono: &pre,
                rms: pre_amp,
            },
            &mut out,
        );
        assert_eq!(m.kind(), VoiceStateKind::Armed);

        // Loud onset block.
        let loud = vec![LOUD; (RATE / 50) as usize]; // 20 ms
        out.clear();
        m.step(
            VoiceInput::Frames {
                mono: &loud,
                rms: LOUD,
            },
            &mut out,
        );
        assert_eq!(m.kind(), VoiceStateKind::Recording);

        // Drive to end-of-turn (silence) and capture the FinalizeJob.
        let job = drive_to_finalize(&mut m);
        // Pre-roll cap is 300 ms; we only supplied 100 ms of pre-roll + 20 ms loud,
        // so the turn starts with the pre-roll samples (value pre_amp), immediately
        // followed by the loud samples (value LOUD) — contiguous, no gap/dup.
        assert!(job.pcm.len() >= pre.len() + loud.len());
        assert_eq!(job.pcm[0], pre_amp, "turn should begin with pre-roll audio");
        // The boundary: last pre-roll sample then first loud sample, adjacent.
        let boundary = job.pcm.iter().position(|&s| s == LOUD).unwrap();
        assert_eq!(job.pcm[boundary - 1], pre_amp);
        assert_eq!(job.pcm[boundary], LOUD);
    }

    /// Assumes the machine just entered Recording via an onset. Adds enough voiced
    /// audio to clear `min_turn_ms`, then trailing silence to trip TurnEnd, and
    /// returns the resulting FinalizeJob.
    fn drive_to_finalize(m: &mut VoiceMachine) -> FinalizeJob {
        feed(m, 400, LOUD); // voiced content well over min_turn_ms (250)
        let e = feed(m, 1_300, QUIET); // trailing silence trips TurnEnd
        e.into_iter()
            .find_map(|eff| match eff {
                VoiceEffect::Finalize(job) => Some(job),
                _ => None,
            })
            .expect("expected a Finalize effect")
    }

    #[test]
    fn ring_is_cleared_on_rearm() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        // First turn.
        feed(&mut m, 20, LOUD);
        let first = drive_to_finalize(&mut m);
        // Complete the turn so we return to Idle, then re-arm.
        out.clear();
        m.step(
            VoiceInput::TurnFinished {
                turn_id: 1,
                outcome: TurnOutcome::Transcript {
                    text: "hi".into(),
                    provider: None,
                },
            },
            &mut out,
        );
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        // Second turn: a fresh onset must not carry the first turn's tail.
        feed(&mut m, 20, LOUD);
        let second = drive_to_finalize(&mut m);
        // The second job is a distinct turn id and does not contain first.pcm.
        assert_eq!(second.turn_id, 2);
        assert_ne!(first.turn_id, second.turn_id);
    }

    #[test]
    fn short_turn_yields_turn_empty_and_no_finalize() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        // A brief loud blip (onset) then immediate silence → turn < min_turn_ms.
        feed(&mut m, 10, LOUD); // onset → Recording, ~10 ms captured
        let e = feed(&mut m, 1_300, QUIET); // silence → TurnEnd
        assert!(
            !e.iter().any(|eff| matches!(eff, VoiceEffect::Finalize(_))),
            "a sub-min_turn_ms clip must not be finalized over the network"
        );
        assert!(topics(&e).contains(&"turnEmpty"));
        // turnEmpty precedes the state:Idle.
        let i_empty = topics(&e).iter().position(|t| *t == "turnEmpty").unwrap();
        let i_idle = e
            .iter()
            .position(|eff| {
                matches!(
                    eff,
                    VoiceEffect::Emit("state", EmitPayload::State(VoiceStateKind::Idle))
                )
            })
            .unwrap();
        assert!(i_empty < i_idle);
        assert_eq!(m.kind(), VoiceStateKind::Idle);
    }

    #[test]
    fn force_turn_while_armed_with_no_speech_is_empty() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        out.clear();
        m.step(VoiceInput::ForceTurn, &mut out);
        assert!(!out.iter().any(|e| matches!(e, VoiceEffect::Finalize(_))));
        assert_eq!(
            out,
            vec![
                VoiceEffect::Emit(
                    "turnEmpty",
                    EmitPayload::TurnEmpty {
                        reason: EmptyReason::NoSpeech
                    }
                ),
                emit_state(VoiceStateKind::Idle),
            ]
        );
    }

    #[test]
    fn suspend_during_recording_discards_the_turn() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        feed(&mut m, 500, LOUD); // Recording with audio buffered
        assert_eq!(m.kind(), VoiceStateKind::Recording);
        out.clear();
        m.step(VoiceInput::Suspend, &mut out);
        assert_eq!(out, vec![emit_state(VoiceStateKind::Idle)]);
        // A subsequent finalize could not happen — nothing buffered. Re-arm and
        // force a turn: it is empty, proving the previous audio was discarded.
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        out.clear();
        m.step(VoiceInput::ForceTurn, &mut out);
        assert!(topics(&out).contains(&"turnEmpty"));
    }

    #[test]
    fn stale_turn_finished_after_close_is_ignored() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        feed(&mut m, 20, LOUD);
        drive_to_finalize(&mut m); // turn_id == 1, state Finalizing
                                   // Close mid-finalize.
        out.clear();
        m.step(VoiceInput::Close, &mut out);
        assert_eq!(m.kind(), VoiceStateKind::Closed);
        // A late transcription result for turn 1 must produce nothing.
        out.clear();
        m.step(
            VoiceInput::TurnFinished {
                turn_id: 1,
                outcome: TurnOutcome::Transcript {
                    text: "late".into(),
                    provider: None,
                },
            },
            &mut out,
        );
        assert_eq!(out, Vec::new());
    }

    #[test]
    fn transcript_is_emitted_before_idle() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        feed(&mut m, 20, LOUD);
        drive_to_finalize(&mut m);
        out.clear();
        m.step(
            VoiceInput::TurnFinished {
                turn_id: 1,
                outcome: TurnOutcome::Transcript {
                    text: "  hello  ".into(),
                    provider: Some("groq".into()),
                },
            },
            &mut out,
        );
        assert_eq!(
            out,
            vec![
                VoiceEffect::Emit(
                    "transcript",
                    EmitPayload::Transcript {
                        text: "hello".into(),
                        provider: Some("groq".into()),
                        duration_ms: m_last_duration(&out),
                    },
                ),
                emit_state(VoiceStateKind::Idle),
            ]
        );
    }

    // The transcript payload carries the machine's recorded duration; read it back
    // out of the effect we just built so the assertion above is self-consistent.
    fn m_last_duration(out: &[VoiceEffect]) -> u64 {
        out.iter()
            .find_map(|e| match e {
                VoiceEffect::Emit("transcript", EmitPayload::Transcript { duration_ms, .. }) => {
                    Some(*duration_ms)
                }
                _ => None,
            })
            .unwrap_or(0)
    }

    #[test]
    fn empty_transcript_becomes_turn_empty() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        feed(&mut m, 20, LOUD);
        drive_to_finalize(&mut m);
        out.clear();
        m.step(
            VoiceInput::TurnFinished {
                turn_id: 1,
                outcome: TurnOutcome::Transcript {
                    text: "   ".into(),
                    provider: None,
                },
            },
            &mut out,
        );
        assert_eq!(
            out,
            vec![
                VoiceEffect::Emit(
                    "turnEmpty",
                    EmitPayload::TurnEmpty {
                        reason: EmptyReason::NoTranscript
                    }
                ),
                emit_state(VoiceStateKind::Idle),
            ]
        );
    }

    #[test]
    fn arm_during_finalizing_is_queued_and_applied_at_idle() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        feed(&mut m, 20, LOUD);
        drive_to_finalize(&mut m); // Finalizing
                                   // Arm while Finalizing → no immediate state emit.
        out.clear();
        m.step(VoiceInput::Arm(ArmMode::BargeIn), &mut out);
        assert_eq!(out, Vec::new());
        // Transcription completes → Idle then the queued Armed, in that order.
        out.clear();
        m.step(
            VoiceInput::TurnFinished {
                turn_id: 1,
                outcome: TurnOutcome::Transcript {
                    text: "hi".into(),
                    provider: None,
                },
            },
            &mut out,
        );
        assert_eq!(
            states(&out),
            vec![VoiceStateKind::Idle, VoiceStateKind::Armed]
        );
        assert_eq!(m.kind(), VoiceStateKind::Armed);
    }

    #[test]
    fn rearm_while_armed_emits_no_redundant_state() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        out.clear();
        m.step(VoiceInput::Arm(ArmMode::BargeIn), &mut out);
        assert_eq!(out, Vec::new());
        assert_eq!(m.kind(), VoiceStateKind::Armed);
    }

    // --- wake listening ----------------------------------------------------

    fn wake_batches(effects: &[VoiceEffect]) -> Vec<usize> {
        effects
            .iter()
            .filter_map(|e| match e {
                VoiceEffect::WakeAudio(pcm) => Some(pcm.len()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn wake_listen_from_idle_announces_the_state() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::WakeListen, &mut out);
        assert_eq!(states(&out), vec![VoiceStateKind::WakeListening]);
        assert_eq!(m.kind(), VoiceStateKind::WakeListening);
    }

    #[test]
    fn wake_listen_never_steals_the_device_from_a_live_turn() {
        for setup in [ArmMode::Normal, ArmMode::BargeIn] {
            let mut m = machine();
            let mut out = Vec::new();
            m.step(VoiceInput::Arm(setup), &mut out);
            out.clear();
            m.step(VoiceInput::WakeListen, &mut out);
            assert_eq!(out, Vec::new());
            assert_eq!(m.kind(), VoiceStateKind::Armed);
        }

        // Mid-recording it must be just as inert.
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        feed(&mut m, 20, LOUD);
        assert_eq!(m.kind(), VoiceStateKind::Recording);
        out.clear();
        m.step(VoiceInput::WakeListen, &mut out);
        assert_eq!(out, Vec::new());
        assert_eq!(m.kind(), VoiceStateKind::Recording);
    }

    #[test]
    fn wake_listening_batches_audio_every_wake_batch_ms() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::WakeListen, &mut out);

        // A third of a batch: nothing yet.
        let e = feed(&mut m, 100, QUIET);
        assert_eq!(wake_batches(&e), Vec::<usize>::new());

        // Crossing 320 ms flushes exactly one batch of everything buffered.
        let e = feed(&mut m, 100, QUIET);
        assert_eq!(wake_batches(&e), Vec::<usize>::new());
        let e = feed(&mut m, 150, QUIET);
        assert_eq!(wake_batches(&e), vec![(RATE as u64 * 350 / 1_000) as usize]);

        // The buffer restarts empty, so the next batch needs a fresh 320 ms.
        let e = feed(&mut m, 100, QUIET);
        assert_eq!(wake_batches(&e), Vec::<usize>::new());
    }

    #[test]
    fn wake_listening_emits_no_level_or_speech_events() {
        // The gateway owns detection; a local VAD gate here would starve it, and a
        // level meter would paint a listening UI for a mode that has none.
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::WakeListen, &mut out);

        let e = feed(&mut m, 500, LOUD);
        assert_eq!(topics(&e), Vec::<&str>::new());
        assert_eq!(m.kind(), VoiceStateKind::WakeListening);
    }

    #[test]
    fn detection_arms_and_drops_the_wake_phrase_audio() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::WakeListen, &mut out);
        feed(&mut m, 100, LOUD); // buffered, un-flushed: this IS "hey hermes"

        out.clear();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        assert_eq!(states(&out), vec![VoiceStateKind::Armed]);

        // The partial batch must not resurface once we are recording a real turn.
        let e = feed(&mut m, 20, LOUD);
        assert_eq!(wake_batches(&e), Vec::<usize>::new());
        assert_eq!(m.kind(), VoiceStateKind::Recording);
    }

    #[test]
    fn suspend_leaves_wake_listening_for_idle() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::WakeListen, &mut out);
        feed(&mut m, 100, QUIET);

        out.clear();
        m.step(VoiceInput::Suspend, &mut out);
        assert_eq!(states(&out), vec![VoiceStateKind::Idle]);

        // Audio after the suspend is discarded, not appended to the old batch.
        let e = feed(&mut m, 500, QUIET);
        assert_eq!(wake_batches(&e), Vec::<usize>::new());
    }

    #[test]
    fn force_turn_while_wake_listening_is_inert() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::WakeListen, &mut out);
        out.clear();
        m.step(VoiceInput::ForceTurn, &mut out);
        assert_eq!(out, Vec::new());
        assert_eq!(m.kind(), VoiceStateKind::WakeListening);
    }

    #[test]
    fn stream_error_closes_with_device_lost() {
        let mut m = machine();
        let mut out = Vec::new();
        m.step(VoiceInput::Arm(ArmMode::Normal), &mut out);
        out.clear();
        m.step(VoiceInput::StreamError("alsa boom".into()), &mut out);
        assert_eq!(topics(&out), vec!["error", "state", "state"]);
        assert!(matches!(out.last(), Some(VoiceEffect::Shutdown)));
        assert_eq!(m.kind(), VoiceStateKind::Closed);
    }
}
