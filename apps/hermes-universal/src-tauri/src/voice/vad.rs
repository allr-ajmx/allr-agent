//! Voice-activity detection: a pure, clock-free helper that turns a stream of
//! RMS levels into turn-boundary events. It holds no `Instant`; the caller
//! (`VoiceMachine`) feeds a monotonic `now_ms` derived from the *sample clock*
//! (`samples_seen * 1000 / src_rate`), so every timing decision is deterministic
//! and unit-testable with synthetic input and no audio device.
//!
//! The VAD carries no notion of "which state am I in" — the machine calls
//! `observe_armed` while Armed and `observe_recording` while Recording, and
//! resets the relevant timers on transition via `arm` / `begin_recording`. That
//! keeps the single source of truth for state in the machine and this file a
//! pile of comparisons.

/// Emit a normalized RMS level no more often than this (≈16 Hz) so meter events
/// don't flood IPC — cpal fires its callback ~100 Hz. Ported from `audio.rs`'s
/// `LEVEL_EMIT_MS`; here it throttles emission against the sample clock, not a
/// wall clock, so it stays deterministic. The recorded PCM is unaffected.
pub const LEVEL_EMIT_MS: u64 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VadEvent {
    /// Level held `>= speech_level` for `onset_ms` while Armed.
    SpeechStart,
    /// Trailing silence (`< speech_level`) for `silence_ms` while Recording.
    TurnEnd,
    /// No speech onset for `idle_silence_ms` while Armed (fires at most once).
    IdleTimeout,
    /// Recording ran past `max_turn_ms`.
    MaxTurn,
}

/// The subset of `VoiceConfig` the VAD needs. Thresholds change with `ArmMode`
/// (normal vs barge-in), so the machine can swap them via `set_thresholds`.
#[derive(Clone, Copy, Debug)]
pub struct VadConfig {
    pub speech_level: f32,
    pub onset_ms: u64,
    pub silence_ms: u64,
    pub idle_silence_ms: u64,
    pub max_turn_ms: u64,
}

#[derive(Clone, Copy, Debug, Default)]
struct Timers {
    armed_at: u64,
    /// Start of the current contiguous loud run; `None` while silent. A silent
    /// frame clears it, so a lone spike shorter than `onset_ms` never latches.
    onset_run_start: Option<u64>,
    idle_fired: bool,
    recording_at: u64,
    last_loud: u64,
}

pub struct Vad {
    cfg: VadConfig,
    t: Timers,
}

impl Vad {
    pub fn new(cfg: VadConfig) -> Self {
        Self {
            cfg,
            t: Timers::default(),
        }
    }

    /// Swap the level/onset thresholds (Normal ↔ BargeIn) without disturbing the
    /// running timers.
    pub fn set_thresholds(&mut self, speech_level: f32, onset_ms: u64) {
        self.cfg.speech_level = speech_level;
        self.cfg.onset_ms = onset_ms;
    }

    /// Enter Armed at `now_ms`: reset onset tracking and the idle window.
    pub fn arm(&mut self, now_ms: u64) {
        self.t.armed_at = now_ms;
        self.t.onset_run_start = None;
        self.t.idle_fired = false;
    }

    /// Enter Recording at `now_ms`: reset the silence and turn-length timers.
    pub fn begin_recording(&mut self, now_ms: u64) {
        self.t.recording_at = now_ms;
        self.t.last_loud = now_ms;
    }

    /// One frame's worth of level while Armed. Returns `SpeechStart` once the
    /// loud run reaches `onset_ms` (immediately when `onset_ms == 0`), or
    /// `IdleTimeout` once `idle_silence_ms` of no onset elapses.
    pub fn observe_armed(&mut self, rms: f32, now_ms: u64) -> Option<VadEvent> {
        if rms >= self.cfg.speech_level {
            let start = *self.t.onset_run_start.get_or_insert(now_ms);
            if now_ms.saturating_sub(start) >= self.cfg.onset_ms {
                return Some(VadEvent::SpeechStart);
            }
        } else {
            self.t.onset_run_start = None;
            if !self.t.idle_fired
                && now_ms.saturating_sub(self.t.armed_at) >= self.cfg.idle_silence_ms
            {
                self.t.idle_fired = true;
                return Some(VadEvent::IdleTimeout);
            }
        }
        None
    }

    /// One frame's worth of level while Recording. `MaxTurn` dominates `TurnEnd`
    /// when both are due on the same frame.
    pub fn observe_recording(&mut self, rms: f32, now_ms: u64) -> Option<VadEvent> {
        if rms >= self.cfg.speech_level {
            self.t.last_loud = now_ms;
        }
        if now_ms.saturating_sub(self.t.recording_at) >= self.cfg.max_turn_ms {
            return Some(VadEvent::MaxTurn);
        }
        if now_ms.saturating_sub(self.t.last_loud) >= self.cfg.silence_ms {
            return Some(VadEvent::TurnEnd);
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> VadConfig {
        VadConfig {
            speech_level: 0.075,
            onset_ms: 0,
            silence_ms: 1_250,
            idle_silence_ms: 12_000,
            max_turn_ms: 60_000,
        }
    }

    const LOUD: f32 = 0.5;
    const QUIET: f32 = 0.0;

    #[test]
    fn onset_fires_on_first_loud_frame_when_onset_is_zero() {
        let mut vad = Vad::new(cfg());
        vad.arm(0);
        assert_eq!(vad.observe_armed(LOUD, 10), Some(VadEvent::SpeechStart));
    }

    #[test]
    fn onset_requires_sustained_level_when_onset_ms_set() {
        let mut c = cfg();
        c.onset_ms = 300;
        let mut vad = Vad::new(c);
        vad.arm(0);
        // Loud run begins at t=100 but has not lasted 300 ms yet.
        assert_eq!(vad.observe_armed(LOUD, 100), None);
        assert_eq!(vad.observe_armed(LOUD, 300), None);
        // 100 -> 400 is 300 ms of sustained level.
        assert_eq!(vad.observe_armed(LOUD, 400), Some(VadEvent::SpeechStart));
    }

    #[test]
    fn a_short_spike_does_not_latch_onset() {
        let mut c = cfg();
        c.onset_ms = 300;
        let mut vad = Vad::new(c);
        vad.arm(0);
        assert_eq!(vad.observe_armed(LOUD, 100), None); // spike begins
        assert_eq!(vad.observe_armed(QUIET, 150), None); // spike ends → run reset
                                                         // A later loud frame starts a fresh run; 200 -> 450 needed, not 100 -> 450.
        assert_eq!(vad.observe_armed(LOUD, 200), None);
        assert_eq!(vad.observe_armed(LOUD, 499), None);
        assert_eq!(vad.observe_armed(LOUD, 500), Some(VadEvent::SpeechStart));
    }

    #[test]
    fn idle_timeout_fires_once_after_silence() {
        let mut vad = Vad::new(cfg());
        vad.arm(0);
        assert_eq!(vad.observe_armed(QUIET, 11_999), None);
        assert_eq!(
            vad.observe_armed(QUIET, 12_000),
            Some(VadEvent::IdleTimeout)
        );
        // Does not fire again while still armed.
        assert_eq!(vad.observe_armed(QUIET, 13_000), None);
    }

    #[test]
    fn idle_timeout_does_not_fire_after_onset() {
        let mut vad = Vad::new(cfg());
        vad.arm(0);
        assert_eq!(vad.observe_armed(LOUD, 10), Some(VadEvent::SpeechStart));
        // The machine would now be Recording; observe_armed is not called again,
        // but even if it were, a loud frame never yields IdleTimeout.
        assert_eq!(vad.observe_armed(LOUD, 20_000), Some(VadEvent::SpeechStart));
    }

    #[test]
    fn turn_end_after_trailing_silence() {
        let mut vad = Vad::new(cfg());
        vad.begin_recording(0);
        assert_eq!(vad.observe_recording(LOUD, 500), None); // last_loud = 500
        assert_eq!(vad.observe_recording(QUIET, 1_749), None);
        assert_eq!(vad.observe_recording(QUIET, 1_750), Some(VadEvent::TurnEnd));
    }

    #[test]
    fn a_loud_frame_resets_the_silence_window() {
        let mut vad = Vad::new(cfg());
        vad.begin_recording(0);
        assert_eq!(vad.observe_recording(QUIET, 1_000), None);
        assert_eq!(vad.observe_recording(LOUD, 1_200), None); // resets last_loud
        assert_eq!(vad.observe_recording(QUIET, 2_449), None);
        assert_eq!(vad.observe_recording(QUIET, 2_450), Some(VadEvent::TurnEnd));
    }

    #[test]
    fn max_turn_caps_continuous_speech() {
        let mut vad = Vad::new(cfg());
        vad.begin_recording(0);
        // Continuous speech never trips TurnEnd, but MaxTurn caps it at 60 s.
        assert_eq!(vad.observe_recording(LOUD, 59_999), None);
        assert_eq!(vad.observe_recording(LOUD, 60_000), Some(VadEvent::MaxTurn));
    }
}
