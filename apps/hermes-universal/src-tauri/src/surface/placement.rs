//! Which monitor a floating surface lands on (MJXHRM-417).
//!
//! # The question this module answers
//!
//! A HUD is summoned by an OS-wide chord from inside whatever the user is
//! working in. On a multi-monitor desk that makes "where does it appear" a real
//! question with a right answer — *the screen the user is looking at* — and
//! three different mechanisms for getting there, none of which exist on every
//! platform:
//!
//! | how we learn which screen | where it works |
//! |---|---|
//! | the compositor's focused output, over Hyprland's IPC socket | wlroots + Hyprland |
//! | the pointer's position | X11, macOS, Windows |
//! | nothing — the compositor chooses for us | wlroots without Hyprland IPC |
//!
//! …and two different mechanisms for *acting* on it: `gtk_layer_set_monitor` on
//! a layer surface, and moving the window on everything else.
//!
//! # Why the pointer is not the universal answer
//!
//! On Wayland it is a lie that reports success. tao 0.35.3
//! (`platform_impl/linux/util.rs:18`) answers `cursor_position()` with a
//! hardcoded `Ok((0, 0))` on Wayland, and GDK does the same thing one layer
//! down: `gdk_device_get_position` on a `GdkWaylandDisplay` returns `0,0`,
//! because the protocol does not tell a client where the pointer is unless it is
//! over that client's own surface. Verified on the development machine (two
//! outputs, `HDMI-A-1` at `0,0` and `eDP-1` at `1920,0`): GDK reported the
//! pointer at `0,0` and `gdk_display_get_monitor_at_point` therefore named the
//! *left-hand* monitor while the pointer was on the right-hand one.
//!
//! So a "place it where the cursor is" implementation would silently place the
//! HUD on whichever monitor sits at the layout origin, every time, on the
//! platform this feature primarily targets. [`PlacementSource`] exists so that
//! path is never taken on Wayland, and so the capability descriptor's
//! `multiMonitorPlacement` is *derived from* the mechanism actually used rather
//! than being a constant next to it that can drift.

use super::Support;

/// A monitor's rectangle, in whatever coordinate space the caller is working in
/// — logical on Linux (GDK reports logical geometry), physical on macOS and
/// Windows (Tauri's [`tauri::Monitor`] reports physical). The functions here
/// only ever compare and offset, so they are correct in either space as long as
/// one caller does not mix the two.
#[derive(Clone, Debug, PartialEq)]
pub struct MonitorRect {
    /// Human-readable name, for diagnostics and as a fallback match key. GDK
    /// gives the EDID model (`HP 22es`), *not* the connector (`HDMI-A-1`).
    pub name: Option<String>,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl MonitorRect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
    }
}

/// The output the compositor says the user is on, as read from Hyprland's IPC
/// socket. Deliberately not a `MonitorRect`: it comes from a different source in
/// a different vocabulary, and the whole job of [`monitor_at_origin`] is to
/// reconcile the two.
#[derive(Clone, Debug, PartialEq)]
pub struct FocusedOutput {
    /// The connector name (`eDP-1`). Never matches GDK's monitor name.
    pub connector: String,
    /// The EDID make, e.g. `BOE`.
    pub make: String,
    /// The EDID model, e.g. `0x08DF`. This *does* match GDK's model.
    pub model: String,
    /// Layout position, logical pixels — the key that matches GDK geometry.
    pub x: f64,
    pub y: f64,
}

/// How the target monitor was chosen — and therefore what the platform can
/// honestly claim for `multiMonitorPlacement`. The descriptor reads
/// [`PlacementSource::support`] rather than stating a level of its own, so the
/// report cannot outlive the mechanism.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlacementSource {
    /// The compositor's own focused output, over Hyprland's IPC socket, applied
    /// with `gtk_layer_set_monitor`. The surface goes where the user is.
    FocusedOutput,
    /// The pointer's position, applied by moving the window. Honest on X11,
    /// macOS and Windows; never used on Wayland (see the module docs).
    Pointer,
    /// We cannot ask which output is focused, but a layer surface that names no
    /// output is placed by the compositor — on wlroots, the one with the cursor.
    /// Right most of the time, and not ours to guarantee.
    CompositorChoice,
    /// No way to choose and no way to move: a plain Wayland toplevel. The client
    /// is told neither where the pointer is nor allowed to position itself.
    Nothing,
}

impl PlacementSource {
    /// The capability level this mechanism deserves.
    pub fn support(self) -> Support {
        match self {
            Self::FocusedOutput | Self::Pointer => Support::Supported,
            Self::CompositorChoice => Support::Degraded,
            Self::Nothing => Support::Unsupported,
        }
    }

    /// The line the descriptor carries for a mechanism that is not the full
    /// answer. `Support::Degraded` is documented as "the reason is in `notes`",
    /// and until this ticket the placement entry was a bare `Degraded` with no
    /// note anywhere — a claim with nothing behind it.
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::FocusedOutput | Self::Pointer => None,
            Self::CompositorChoice => Some(
                "Which monitor a floating surface opens on is the compositor's choice here: \
                 Wayland does not tell a client where the pointer is, and only Hyprland's IPC \
                 socket will name the focused output. wlroots compositors use the monitor with \
                 the cursor, which is usually right.",
            ),
            Self::Nothing => Some(
                "A floating surface cannot be placed on a chosen monitor in this session: \
                 Wayland gives a client neither the pointer's position nor the ability to move \
                 its own window, and without layer-shell there is no output to name. It opens \
                 wherever the compositor puts it.",
            ),
        }
    }
}

/// The monitor containing `(x, y)`, if any. Pointer platforms only — see the
/// module docs for why this must never be reached on Wayland.
pub fn monitor_at_point(monitors: &[MonitorRect], x: f64, y: f64) -> Option<usize> {
    monitors.iter().position(|m| m.contains(x, y))
}

/// The monitor the compositor's focused output refers to.
///
/// Matched on the layout origin first, because that is the one key both sides
/// agree on: Hyprland reports layout coordinates and GDK reports logical
/// geometry, and on the development machine they are identical (`0,0` and
/// `1920,0`). The tolerance is for fractionally-scaled outputs, where Tauri's
/// physical origin divided back by the scale factor need not land on an exact
/// integer.
///
/// The EDID model is the fallback, not the primary key: two identical monitors
/// report the same model, and the origin never collides.
pub fn monitor_at_origin(monitors: &[MonitorRect], output: &FocusedOutput) -> Option<usize> {
    const TOLERANCE: f64 = 2.0;

    monitors
        .iter()
        .position(|m| (m.x - output.x).abs() <= TOLERANCE && (m.y - output.y).abs() <= TOLERANCE)
        .or_else(|| {
            monitors.iter().position(|m| {
                m.name.as_deref().is_some_and(|name| {
                    !output.model.is_empty() && name == output.model
                        || !output.connector.is_empty() && name == output.connector
                })
            })
        })
}

/// Where to put a `width` × `height` window on `monitor`: horizontally centred,
/// `top_margin` down from the top edge — the same placement the layer-shell path
/// gets from its anchors and margins, so the two backends agree on where a HUD
/// sits.
///
/// Clamped to the monitor. A surface wider or taller than the screen is not
/// hypothetical — the HUD is 560×260 logical and a 1024×600 output at 2× scale
/// has less physical room than that arithmetic suggests — and a negative offset
/// would push it off the left edge or above the top, where some of it cannot be
/// clicked and, on Windows, part of it lands on a neighbouring monitor.
pub fn top_centred(monitor: &MonitorRect, width: f64, height: f64, top_margin: f64) -> (f64, f64) {
    let x = monitor.x + ((monitor.width - width) / 2.0).max(0.0);
    let y = monitor.y + top_margin.min((monitor.height - height).max(0.0));

    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The development machine, as both sides describe it: GDK's logical
    /// geometry above, Hyprland's `j/monitors` below.
    fn desk() -> Vec<MonitorRect> {
        vec![
            MonitorRect {
                name: Some("HP 22es".to_string()),
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            MonitorRect {
                name: Some("0x08DF".to_string()),
                x: 1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ]
    }

    fn laptop_focused() -> FocusedOutput {
        FocusedOutput {
            connector: "eDP-1".to_string(),
            make: "BOE".to_string(),
            model: "0x08DF".to_string(),
            x: 1920.0,
            y: 0.0,
        }
    }

    #[test]
    fn a_point_lands_on_the_monitor_that_contains_it() {
        assert_eq!(monitor_at_point(&desk(), 960.0, 540.0), Some(0));
        assert_eq!(monitor_at_point(&desk(), 2880.0, 540.0), Some(1));
        // The shared edge belongs to the monitor that starts there, not to the
        // one that ends there — otherwise both claim it and the first wins.
        assert_eq!(monitor_at_point(&desk(), 1920.0, 0.0), Some(1));
        assert_eq!(monitor_at_point(&desk(), 1919.0, 0.0), Some(0));
    }

    #[test]
    fn a_point_on_no_monitor_chooses_nothing() {
        // A stale pointer reading after an unplug, and the shape a caller must
        // fall back from rather than defaulting to index 0.
        assert!(monitor_at_point(&desk(), 9000.0, 0.0).is_none());
        assert!(monitor_at_point(&desk(), -1.0, 0.0).is_none());
        assert!(monitor_at_point(&[], 0.0, 0.0).is_none());
    }

    #[test]
    fn the_focused_output_is_matched_on_its_layout_origin() {
        assert_eq!(monitor_at_origin(&desk(), &laptop_focused()), Some(1));
        assert_eq!(
            monitor_at_origin(
                &desk(),
                &FocusedOutput {
                    connector: "HDMI-A-1".to_string(),
                    make: "Hewlett Packard".to_string(),
                    model: "HP 22es".to_string(),
                    x: 0.0,
                    y: 0.0,
                }
            ),
            Some(0)
        );
    }

    /// Fractional scaling: Tauri reports a physical origin, and dividing it back
    /// by 1.25 or 1.5 does not always land on the integer the compositor used.
    #[test]
    fn a_fractionally_scaled_origin_still_matches() {
        let monitors = vec![MonitorRect {
            name: Some("scaled".to_string()),
            x: 1919.2,
            y: 0.8,
            width: 1536.0,
            height: 864.0,
        }];
        assert_eq!(monitor_at_origin(&monitors, &laptop_focused()), Some(0));
    }

    /// The origin is the primary key precisely because the model is not unique.
    #[test]
    fn two_identical_monitors_are_told_apart_by_position_not_model() {
        let twins = vec![
            MonitorRect {
                name: Some("0x08DF".to_string()),
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
            MonitorRect {
                name: Some("0x08DF".to_string()),
                x: 1920.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            },
        ];
        assert_eq!(monitor_at_origin(&twins, &laptop_focused()), Some(1));
    }

    /// The fallback exists for a compositor whose layout coordinates are not
    /// GDK's — matched on the EDID model, which is the one string both sides
    /// print. GDK never reports the connector name, but a compositor that does
    /// is not worth refusing.
    #[test]
    fn a_moved_output_falls_back_to_its_model() {
        let monitors = vec![MonitorRect {
            name: Some("0x08DF".to_string()),
            x: 3000.0,
            y: 200.0,
            width: 1920.0,
            height: 1080.0,
        }];
        assert_eq!(monitor_at_origin(&monitors, &laptop_focused()), Some(0));

        let by_connector = vec![MonitorRect {
            name: Some("eDP-1".to_string()),
            x: 3000.0,
            y: 200.0,
            width: 1920.0,
            height: 1080.0,
        }];
        assert_eq!(monitor_at_origin(&by_connector, &laptop_focused()), Some(0));
    }

    /// "Could not match it" must stay distinguishable from "it is the first
    /// one": the caller falls back to letting the compositor decide, which is
    /// better than confidently naming the wrong screen.
    #[test]
    fn an_unmatchable_output_chooses_nothing() {
        let monitors = vec![MonitorRect {
            name: Some("something else".to_string()),
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        }];
        assert!(monitor_at_origin(&monitors, &laptop_focused()).is_none());
        assert!(monitor_at_origin(&[], &laptop_focused()).is_none());
    }

    /// An empty name must never match an empty model — that would make every
    /// unnamed monitor a match for every unidentified output.
    #[test]
    fn empty_identifiers_never_match() {
        let monitors = vec![MonitorRect {
            name: Some(String::new()),
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        }];
        let blank = FocusedOutput {
            connector: String::new(),
            make: String::new(),
            model: String::new(),
            x: 4000.0,
            y: 4000.0,
        };
        assert!(monitor_at_origin(&monitors, &blank).is_none());
    }

    #[test]
    fn a_window_is_centred_on_the_monitor_it_was_placed_on() {
        let (x, y) = top_centred(&desk()[1], 560.0, 260.0, 96.0);
        assert_eq!((x, y), (1920.0 + 680.0, 96.0));
    }

    /// The guard: an offset must never push the surface off its own monitor.
    #[test]
    fn a_surface_larger_than_its_monitor_stays_on_it() {
        let small = MonitorRect {
            name: None,
            x: 1920.0,
            y: 100.0,
            width: 400.0,
            height: 300.0,
        };
        let (x, y) = top_centred(&small, 560.0, 260.0, 96.0);
        assert_eq!(x, 1920.0, "a too-wide surface pins to the left edge");
        assert_eq!(
            y,
            100.0 + 40.0,
            "the margin shrinks rather than overflowing"
        );

        let (_, y) = top_centred(&small, 560.0, 600.0, 96.0);
        assert_eq!(y, 100.0, "a too-tall surface pins to the top edge");
    }

    #[test]
    fn what_each_mechanism_may_claim() {
        assert_eq!(PlacementSource::FocusedOutput.support(), Support::Supported);
        assert_eq!(PlacementSource::Pointer.support(), Support::Supported);
        assert_eq!(
            PlacementSource::CompositorChoice.support(),
            Support::Degraded
        );
        assert_eq!(PlacementSource::Nothing.support(), Support::Unsupported);
    }

    /// Every answer short of "supported" owes the descriptor a reason — the
    /// defect this ticket was filed over was a bare `Degraded` with no note
    /// anywhere in the descriptor.
    #[test]
    fn every_shortfall_explains_itself() {
        assert!(PlacementSource::FocusedOutput.note().is_none());
        assert!(PlacementSource::Pointer.note().is_none());
        for source in [PlacementSource::CompositorChoice, PlacementSource::Nothing] {
            let note = source.note().unwrap_or_default();
            assert!(note.contains("Wayland"), "{source:?} names the reason");
        }
    }
}
