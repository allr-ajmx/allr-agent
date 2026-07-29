//! An RFC 3339 timestamp, without a date dependency.
//!
//! The lockfile records when a backend was started, and desktop writes an ISO
//! string there (`remote-lifecycle.ts:812`). The crate has no date library and
//! pulling one in for a single formatted string — across three mobile ABIs —
//! is not worth it, so the calendar conversion is done here.
//!
//! Uses Howard Hinnant's `civil_from_days`, which is the standard branch-free
//! way to invert the proleptic Gregorian calendar; it is exact for every date
//! we could encounter.

use std::time::{SystemTime, UNIX_EPOCH};

/// `YYYY-MM-DDTHH:MM:SSZ` for the given instant. Times before 1970 clamp to the
/// epoch — the value is a human-readable annotation, not something we compute
/// with, and a clock that far wrong has bigger problems.
pub fn iso8601_utc(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);

    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);

    let (year, month, day) = civil_from_days(days);
    let (hour, minute, second) = (time_of_day / 3600, (time_of_day % 3600) / 60, time_of_day % 60);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

/// Now, formatted.
pub fn now_iso8601() -> String {
    iso8601_utc(SystemTime::now())
}

/// Days since 1970-01-01 → (year, month, day), proleptic Gregorian.
///
/// Hinnant's algorithm: shift the epoch to 0000-03-01 so leap days land at the
/// end of the year, which makes the month arithmetic a single linear formula.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };

    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    fn at(epoch_secs: u64) -> String {
        iso8601_utc(UNIX_EPOCH + Duration::from_secs(epoch_secs))
    }

    #[test]
    fn formats_the_epoch() {
        assert_eq!(at(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn formats_known_instants() {
        // Cross-checked against `date -u -d @<secs> +%Y-%m-%dT%H:%M:%SZ`.
        assert_eq!(at(1_000_000_000), "2001-09-09T01:46:40Z");
        assert_eq!(at(1_700_000_000), "2023-11-14T22:13:20Z");
        assert_eq!(at(1_753_747_200), "2025-07-29T00:00:00Z");
    }

    #[test]
    fn handles_leap_days() {
        // 2000 is a leap year (divisible by 400); 1900 was not. Getting the
        // century rule wrong shifts every later date by a day.
        assert_eq!(at(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(at(951_868_800), "2000-03-01T00:00:00Z");
        // 2024-02-29, an ordinary leap year.
        assert_eq!(at(1_709_164_800), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn handles_year_boundaries() {
        assert_eq!(at(1_735_689_599), "2024-12-31T23:59:59Z");
        assert_eq!(at(1_735_689_600), "2025-01-01T00:00:00Z");
    }

    #[test]
    fn a_pre_epoch_clock_clamps_rather_than_panicking() {
        // A machine with a badly wrong clock must not take the app down over a
        // cosmetic field.
        let before = UNIX_EPOCH - Duration::from_secs(86_400);
        assert_eq!(iso8601_utc(before), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn now_has_the_right_shape_and_is_plausible() {
        let now = now_iso8601();

        assert_eq!(now.len(), 20, "{now}");
        assert!(now.ends_with('Z'), "{now}");
        assert_eq!(&now[4..5], "-");
        assert_eq!(&now[10..11], "T");

        let year: i32 = now[..4].parse().expect("a four-digit year");
        assert!((2024..2100).contains(&year), "{now}");
    }
}
