//! Pure audio codec helpers: sample→f32 conversion, anti-aliased resample to
//! 16 kHz (rubato), and WAV/FLAC encoding (hound/flacenc). All pure Rust — no
//! system codec, no C toolchain — so they compile into the app and run the same
//! on every desktop backend.
//!
//! Rehosted verbatim from `audio.rs` (MJX-96): `audio.rs` now imports these
//! rather than defining its own copies, and `voice/capture.rs` will use them for
//! the persistent-session pipeline. Desktop-gated because the encoders/resampler
//! deps are gated off the mobile NDK build (see `Cargo.toml`).

use std::io::Cursor;

use crate::voice::machine::ClipFormat;

/// Cheap, dependency-free sample→f32 conversion so we don't lean on cpal's
/// sample-conversion trait surface. Covers the formats devices actually capture.
pub trait ToMonoF32: Copy {
    fn to_f32(self) -> f32;
}
impl ToMonoF32 for f32 {
    fn to_f32(self) -> f32 {
        self
    }
}
impl ToMonoF32 for i16 {
    fn to_f32(self) -> f32 {
        self as f32 / 32768.0
    }
}
impl ToMonoF32 for u16 {
    fn to_f32(self) -> f32 {
        (self as f32 - 32768.0) / 32768.0
    }
}
impl ToMonoF32 for i32 {
    fn to_f32(self) -> f32 {
        self as f32 / 2_147_483_648.0
    }
}
impl ToMonoF32 for i8 {
    fn to_f32(self) -> f32 {
        self as f32 / 128.0
    }
}
impl ToMonoF32 for u8 {
    fn to_f32(self) -> f32 {
        (self as f32 - 128.0) / 128.0
    }
}

/// Anti-aliased resample of mono f32 to 16 kHz via rubato. Passthrough when
/// already 16 kHz. 16 kHz mono matches whisper's expected input and keeps the
/// payload small over a remote gateway.
pub fn resample_to_16k(input: &[f32], src_rate: u32) -> Result<Vec<f32>, String> {
    use rubato::{FftFixedIn, Resampler};

    const TARGET: usize = 16_000;
    if input.is_empty() || src_rate as usize == TARGET {
        return Ok(input.to_vec());
    }

    let mut resampler = FftFixedIn::<f32>::new(src_rate as usize, TARGET, 1024, 2, 1)
        .map_err(|e| format!("resampler_init: {e}"))?;
    let mut out: Vec<f32> = Vec::with_capacity(input.len() * TARGET / src_rate as usize + 1024);
    let mut rest = input;

    loop {
        let needed = resampler.input_frames_next();
        if rest.len() >= needed {
            let (chunk, tail) = rest.split_at(needed);
            let res = resampler
                .process(&[chunk], None)
                .map_err(|e| format!("resample: {e}"))?;
            out.extend_from_slice(&res[0]);
            rest = tail;
        } else {
            // Final short chunk: `process_partial` zero-pads internally.
            let res = resampler
                .process_partial(Some(&[rest]), None)
                .map_err(|e| format!("resample_partial: {e}"))?;
            out.extend_from_slice(&res[0]);
            break;
        }
    }
    Ok(out)
}

pub fn f32_to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// Encode mono 16 kHz f32 to an in-memory container the gateway accepts,
/// returning `(bytes, mime_type)`.
pub fn encode(samples: &[f32], format: ClipFormat) -> Result<(Vec<u8>, String), String> {
    match format {
        ClipFormat::Flac => encode_flac(samples),
        ClipFormat::Wav => encode_wav(samples),
    }
}

pub fn encode_wav(samples: &[f32]) -> Result<(Vec<u8>, String), String> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer =
            hound::WavWriter::new(&mut cursor, spec).map_err(|e| format!("wav_init: {e}"))?;
        for &s in samples {
            writer
                .write_sample(f32_to_i16(s))
                .map_err(|e| format!("wav_write: {e}"))?;
        }
        writer
            .finalize()
            .map_err(|e| format!("wav_finalize: {e}"))?;
    }
    Ok((cursor.into_inner(), "audio/wav".into()))
}

pub fn encode_flac(samples: &[f32]) -> Result<(Vec<u8>, String), String> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|(_, e)| format!("flac_config: {e:?}"))?;
    let pcm_i32: Vec<i32> = samples.iter().map(|&s| f32_to_i16(s) as i32).collect();
    let source = flacenc::source::MemSource::from_samples(&pcm_i32, 1, 16, 16_000);
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| format!("flac_encode: {e:?}"))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| format!("flac_write: {e:?}"))?;
    Ok((sink.as_slice().to_vec(), "audio/flac".into()))
}

/// Build the `data:{mime};base64,{...}` URL the gateway's `/api/audio/transcribe`
/// expects (it validates the `data:` prefix, `;base64`, and `,`). Enforces the
/// gateway's 25 MiB decoded-size cap up front so an over-long turn fails locally
/// instead of round-tripping to a 413.
pub const MAX_CLIP_BYTES: usize = 25 * 1024 * 1024;

pub fn to_data_url(bytes: &[u8], mime: &str) -> Result<String, String> {
    if bytes.len() > MAX_CLIP_BYTES {
        return Err("clip_too_large".into());
    }
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_48k_to_16k_thirds_the_length() {
        let n = 48_000usize; // 1 s at 48 kHz
        let input = vec![0.0f32; n];
        let out = resample_to_16k(&input, 48_000).unwrap();
        // ~16000 samples out, within a resampler chunk of slack.
        assert!(
            (out.len() as i64 - 16_000).abs() <= 1_100,
            "got {} samples",
            out.len()
        );
    }

    #[test]
    fn resample_passthrough_at_16k() {
        let input = vec![0.1f32, -0.2, 0.3];
        let out = resample_to_16k(&input, 16_000).unwrap();
        assert_eq!(out, input);
    }

    #[test]
    fn f32_to_i16_clamps_out_of_range() {
        assert_eq!(f32_to_i16(2.0), 32_767);
        assert_eq!(f32_to_i16(-2.0), -32_767);
        assert_eq!(f32_to_i16(0.0), 0);
    }

    #[test]
    fn wav_header_is_riff_wave_mono_16k_16bit() {
        let (bytes, mime) = encode_wav(&[0.0, 0.1, -0.1, 0.2]).unwrap();
        assert_eq!(mime, "audio/wav");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        // fmt chunk: channels @ offset 22 (u16 LE), sample_rate @ 24 (u32 LE),
        // bits_per_sample @ 34 (u16 LE).
        assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 1);
        assert_eq!(
            u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
            16_000
        );
        assert_eq!(u16::from_le_bytes([bytes[34], bytes[35]]), 16);
    }

    #[test]
    fn flac_output_has_flac_magic() {
        let (bytes, mime) = encode_flac(&[0.0, 0.1, -0.1, 0.2, 0.05]).unwrap();
        assert_eq!(mime, "audio/flac");
        assert_eq!(&bytes[0..4], b"fLaC");
    }

    #[test]
    fn data_url_is_well_formed() {
        let url = to_data_url(b"hello", "audio/wav").unwrap();
        assert!(url.starts_with("data:audio/wav;base64,"));
        assert!(url.contains(','));
    }

    #[test]
    fn oversized_clip_is_rejected_before_post() {
        let big = vec![0u8; MAX_CLIP_BYTES + 1];
        assert_eq!(to_data_url(&big, "audio/wav"), Err("clip_too_large".into()));
    }
}
