//! The half of `read_window_below` that belongs to no windowing system in
//! particular (MJXHRM-392).
//!
//! # Two orderings, one question
//!
//! Every platform that will answer "what is underneath me" answers it as an
//! ordered list of windows, and the ordering is the whole of the difference:
//!
//! | platform | list | order |
//! |---|---|---|
//! | Hyprland | `j/clients` over its IPC socket | focus recency (`focusHistoryID`) |
//! | X11 | `_NET_CLIENT_LIST_STACKING` on the root window | stacking, bottom-to-top |
//! | macOS | `CGWindowListCopyWindowInfo` | stacking, front-to-back |
//! | Windows | `EnumWindows` | stacking, front-to-back |
//!
//! Three of those four are a genuine z-order, so they share the picker in this
//! module: find ourselves in the stack, then take the first window *behind* us
//! that we actually overlap. Hyprland's list is not a z-order at all — it is
//! recency — so it keeps its own picker in [`super::below::pick_window_below`],
//! and this module deliberately does not touch it.
//!
//! # What this never widens
//!
//! This is screen-context perception: it reads what is on the user's screen.
//! Every enumerator here is narrowed to the same thing Hyprland already gave —
//! *the window directly beneath ours* — before it reaches the tool. The platform
//! APIs are broader than that (macOS and Windows will both hand over every
//! window on the desktop), so the narrowing is the enumerator's job and is
//! documented where each one does it. Metadata only: application, title, bounds.
//! Never pixels.

use serde::Serialize;

use super::below::{Bounds, Frontmost, WindowBelowAnswer, WindowInfo};
use super::Support;

/// One window, as some OS enumerator described it.
///
/// `pid` is how we recognise our own windows and is never serialized — the wire
/// shape `tools/read_window_tool.py` reads has no such key, and neither does the
/// Electron desktop's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StackedWindow {
    pub app: String,
    pub bounds: Bounds,
    /// Opaque per-platform handle (X11 window id, `kCGWindowNumber`, `HWND`).
    /// Only ever reported, never dereferenced.
    pub id: u64,
    pub pid: i32,
    pub title: String,
}

/// Which mechanism answered — and therefore what the platform may honestly
/// claim for `readWindowBelow`.
///
/// This is the *only* definition. [`super::capabilities_for_linux`] and
/// [`super::capabilities_for_other_desktop`] read [`Self::support`] rather than
/// stating a level of their own, and the `read_window_below` command dispatches
/// on the same value, so the report cannot outlive the code that backs it. The
/// bug this shape exists to prevent has already happened once next door: the
/// descriptor claimed `multiMonitorPlacement: Supported` for macOS and Windows
/// while nothing in the codebase positioned a window at all (MJXHRM-417).
///
/// Every variant is constructed on exactly one platform, so on any one build the
/// other three look dead. They are compiled everywhere deliberately: the
/// descriptor mapping that reads them is unit-tested on Linux, which is the only
/// platform this repo's CI runs, and a `cfg`-gated enum would take that coverage
/// away from precisely the platforms nobody can check by hand.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowBelowSource {
    /// Hyprland's IPC socket, `j/clients`. The only thing that sees native
    /// Wayland windows.
    HyprlandIpc,
    /// `_NET_CLIENT_LIST_STACKING` on the X11 root window.
    X11Stacking,
    /// `CGWindowListCopyWindowInfo`, with the Screen Recording permission
    /// already granted, so other applications' titles come through.
    MacWindowList,
    /// The same call without that permission. Application names, bounds and
    /// stacking order are public on macOS; titles are not.
    MacWindowListUntitled,
    /// `EnumWindows` plus `GetWindowRect` / `QueryFullProcessImageNameW`.
    Win32EnumWindows,
    /// Nothing here can answer. On Linux that means a Wayland session that is
    /// not Hyprland; there is no fallback, and saying so is the point.
    Nothing,
}

impl WindowBelowSource {
    /// The capability level this mechanism deserves.
    pub fn support(self) -> Support {
        match self {
            Self::HyprlandIpc
            | Self::X11Stacking
            | Self::MacWindowList
            | Self::Win32EnumWindows => Support::Supported,
            // A reading with no titles is a real reading — the model still
            // learns which application the user is in, and where. It is not the
            // full answer, and `Degraded` is exactly that claim.
            Self::MacWindowListUntitled => Support::Degraded,
            Self::Nothing => Support::Unsupported,
        }
    }

    /// The stable string the descriptor publishes as `readWindowBelowSource`,
    /// or `None` when there is no mechanism to name.
    ///
    /// `hyprland-ipc` is load-bearing: it is the value the frontend's surface
    /// test already asserts, and changing it would be a wire change.
    pub fn label(self) -> Option<&'static str> {
        match self {
            Self::HyprlandIpc => Some("hyprland-ipc"),
            Self::X11Stacking => Some("x11-stacking"),
            Self::MacWindowList => Some("macos-window-list"),
            Self::MacWindowListUntitled => Some("macos-window-list-untitled"),
            Self::Win32EnumWindows => Some("win32-enum-windows"),
            Self::Nothing => None,
        }
    }

    /// The line a mechanism short of the full answer owes its reader. Carried
    /// both in the descriptor's `notes` and — for a reading that happened but
    /// left something out — in the answer's own `note`, so the model and the
    /// diagnostics see the same sentence.
    pub fn note(self) -> Option<&'static str> {
        match self {
            Self::HyprlandIpc
            | Self::X11Stacking
            | Self::MacWindowList
            | Self::Win32EnumWindows => None,
            Self::MacWindowListUntitled => Some(
                "Window titles are hidden: macOS reveals other applications' titles only with the \
                 Screen Recording permission, which Hermes does not request for this. Application \
                 names, bounds and stacking order still come through.",
            ),
            Self::Nothing => Some(
                "Reading the window underneath needs either an X11 server or a compositor willing \
                 to name other applications' windows. This session has neither: Wayland withholds \
                 window identity from clients on principle, and Hyprland's IPC socket is the only \
                 compositor-specific implementation there is.",
            ),
        }
    }

    /// Whether this mechanism reports titles. macOS is the only platform where
    /// the answer can be no, and the only one that calls this — hence the
    /// allow; the rule itself is checked by the tests below on every build.
    #[allow(dead_code)]
    pub fn titles(self) -> bool {
        self != Self::MacWindowListUntitled
    }
}

/// Which window is underneath us, and which application the user was last in,
/// from a **front-to-back** ordered stack.
///
/// The same rule the Electron desktop applies to `get-windows`' output
/// (`electron/window-below.ts`): walk past our own windows, then take the first
/// other-process window that actually overlaps ours — "underneath" means
/// visually behind, not merely next in a z-order that may be on another
/// monitor entirely. `frontmost` is the first other-process window whether it
/// overlaps or not: the application the user was last working in.
///
/// When we are not in the list at all there is nothing to overlap, so the answer
/// collapses to the frontmost other window — the same fallback the Hyprland
/// picker makes for a layer-shell surface, which is not a client and so never
/// appears in its own compositor's list.
pub fn pick_from_stack(
    ordered: &[StackedWindow],
    self_pid: i32,
) -> (Option<&StackedWindow>, Option<&StackedWindow>) {
    let frontmost = ordered.iter().find(|w| w.pid != self_pid);
    let below = match ordered.iter().position(|w| w.pid == self_pid) {
        Some(index) => {
            let self_bounds = ordered[index].bounds;

            ordered[index + 1..]
                .iter()
                .find(|w| w.pid != self_pid && w.bounds.overlaps(&self_bounds))
        }
        None => frontmost,
    };

    (below, frontmost)
}

/// Build the wire answer from an enumerated stack.
///
/// Pure, and compiled on every platform rather than only the one it runs on:
/// the mapping is where the interesting mistakes live, and a `cfg`-gated one
/// would be checked by no CI job this repo runs.
pub fn answer_from_stack(
    ordered: &[StackedWindow],
    self_pid: i32,
    source: WindowBelowSource,
) -> WindowBelowAnswer {
    let (below, frontmost) = pick_from_stack(ordered, self_pid);

    WindowBelowAnswer::Read {
        frontmost: frontmost.map(|w| Frontmost {
            app: w.app.clone(),
            title: w.title.clone(),
        }),
        platform: std::env::consts::OS.to_string(),
        window: below.map(|w| WindowInfo {
            app: w.app.clone(),
            bounds: w.bounds,
            id: w.id,
            title: w.title.clone(),
        }),
        note: source.note().map(str::to_string),
    }
}

/// Turn an enumerator's result into the wire answer.
///
/// The failure arm is the load-bearing one: an enumerator that could not run
/// must produce an *explained refusal*, never `Ok` with an empty list. An empty
/// list is a true statement about a bare desktop; a refusal is a true statement
/// about a broken one, and the model reads them very differently.
pub fn from_enumeration(
    windows: Result<Vec<StackedWindow>, String>,
    source: WindowBelowSource,
    self_pid: i32,
) -> WindowBelowAnswer {
    match windows {
        Ok(list) => answer_from_stack(&list, self_pid, source),
        Err(e) => WindowBelowAnswer::unavailable(format!("Could not enumerate windows: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(app: &str, pid: i32, x: i32, y: i32, w: i32, h: i32) -> StackedWindow {
        StackedWindow {
            app: app.to_string(),
            bounds: Bounds {
                x,
                y,
                width: w,
                height: h,
            },
            id: pid as u64,
            pid,
            title: format!("{app} window"),
        }
    }

    /// Front-to-back: our HUD, a browser directly behind it, a terminal behind
    /// that one and off to the side.
    fn stack() -> Vec<StackedWindow> {
        vec![
            win("hermes", 555, 100, 100, 560, 260),
            win("firefox", 200, 0, 0, 1920, 1080),
            win("kitty", 100, 3000, 0, 800, 600),
        ]
    }

    #[test]
    fn the_window_below_is_the_first_overlapping_one_behind_us() {
        let list = stack();
        let (below, frontmost) = pick_from_stack(&list, 555);
        assert_eq!(below.map(|w| w.app.as_str()), Some("firefox"));
        assert_eq!(frontmost.map(|w| w.app.as_str()), Some("firefox"));
    }

    /// The difference between this picker and "the next window in the list".
    #[test]
    fn a_window_behind_us_that_we_do_not_overlap_is_skipped() {
        // Drop the browser: the only thing behind us is on another monitor.
        let list = vec![stack()[0].clone(), stack()[2].clone()];
        let (below, frontmost) = pick_from_stack(&list, 555);
        assert_eq!(below, None, "nothing is underneath us");
        assert_eq!(
            frontmost.map(|w| w.app.as_str()),
            Some("kitty"),
            "but the user was last in kitty"
        );
    }

    /// Anything in FRONT of us is not underneath us, however much it overlaps.
    #[test]
    fn a_window_in_front_of_us_is_never_the_answer() {
        let mut list = stack();
        list.insert(0, win("popup", 700, 0, 0, 1920, 1080));
        let (below, frontmost) = pick_from_stack(&list, 555);
        assert_eq!(below.map(|w| w.app.as_str()), Some("firefox"));
        assert_eq!(frontmost.map(|w| w.app.as_str()), Some("popup"));
    }

    /// Every window of ours is skipped, not just the topmost — a HUD and a main
    /// window share a pid.
    #[test]
    fn our_own_windows_are_never_the_answer() {
        let mut list = stack();
        list.insert(1, win("hermes-main", 555, 0, 0, 1920, 1080));
        let (below, frontmost) = pick_from_stack(&list, 555);
        assert_eq!(below.map(|w| w.pid), Some(200));
        assert_eq!(frontmost.map(|w| w.pid), Some(200));
    }

    /// A layer-shell surface is not in its compositor's client list, and a
    /// Windows HUD created before the enumeration is not in that snapshot
    /// either. Both collapse to "the window the user was last in".
    #[test]
    fn a_stack_without_us_in_it_falls_back_to_the_frontmost_window() {
        let list = vec![stack()[2].clone(), stack()[1].clone()];
        let (below, frontmost) = pick_from_stack(&list, 999);
        assert_eq!(below.map(|w| w.app.as_str()), Some("kitty"));
        assert_eq!(frontmost.map(|w| w.app.as_str()), Some("kitty"));
    }

    #[test]
    fn an_empty_stack_answers_nothing_rather_than_panicking() {
        assert_eq!(pick_from_stack(&[], 555), (None, None));
        // A desktop with only our own windows on it.
        let ours = vec![win("hermes", 555, 0, 0, 100, 100)];
        assert_eq!(pick_from_stack(&ours, 555), (None, None));
    }

    #[test]
    fn the_answer_serializes_to_the_shape_the_backend_tool_reads() {
        let answer = answer_from_stack(&stack(), 555, WindowBelowSource::X11Stacking);
        let json = serde_json::to_value(&answer).expect("serializes");
        assert_eq!(json["window"]["app"], "firefox");
        assert_eq!(json["window"]["bounds"]["width"], 1920);
        assert_eq!(json["frontmost"]["title"], "firefox window");
        assert!(json.get("platform").is_some());
        // Absent rather than null, matching the desktop payload.
        assert!(json.get("note").is_none());
        // pid is ours to filter on and nobody else's to see.
        assert!(json["window"].get("pid").is_none());
    }

    /// The reading happened; one field of it is withheld. That must reach the
    /// model as a note on a real answer, not as a refusal and not as silence.
    #[test]
    fn a_macos_reading_without_titles_carries_its_reason() {
        let answer = answer_from_stack(&stack(), 555, WindowBelowSource::MacWindowListUntitled);
        let json = serde_json::to_value(&answer).expect("serializes");
        assert_eq!(json["window"]["app"], "firefox");
        assert!(
            json["note"]
                .as_str()
                .unwrap_or_default()
                .contains("Screen Recording"),
            "{json:?}"
        );
    }

    // -----------------------------------------------------------------------
    // The derived capability
    // -----------------------------------------------------------------------

    #[test]
    fn what_each_mechanism_may_claim() {
        for supported in [
            WindowBelowSource::HyprlandIpc,
            WindowBelowSource::X11Stacking,
            WindowBelowSource::MacWindowList,
            WindowBelowSource::Win32EnumWindows,
        ] {
            assert_eq!(supported.support(), Support::Supported, "{supported:?}");
        }
        assert_eq!(
            WindowBelowSource::MacWindowListUntitled.support(),
            Support::Degraded
        );
        assert_eq!(WindowBelowSource::Nothing.support(), Support::Unsupported);
    }

    /// Every answer short of `Supported` owes the descriptor a reason. An
    /// `Unsupported` with nothing behind it reads to a user as a bug report
    /// with no next step.
    #[test]
    fn every_shortfall_explains_itself() {
        for full in [
            WindowBelowSource::HyprlandIpc,
            WindowBelowSource::X11Stacking,
            WindowBelowSource::MacWindowList,
            WindowBelowSource::Win32EnumWindows,
        ] {
            assert!(full.note().is_none(), "{full:?}");
            assert!(full.titles(), "{full:?}");
        }
        assert!(WindowBelowSource::MacWindowListUntitled
            .note()
            .is_some_and(|n| n.contains("Screen Recording")));
        assert!(!WindowBelowSource::MacWindowListUntitled.titles());
        assert!(WindowBelowSource::Nothing
            .note()
            .is_some_and(|n| n.contains("Wayland")));
    }

    /// An enumerator that could not run must say so. The bug this guards is the
    /// one this whole ticket family keeps finding: a failure that serializes as
    /// an empty reading, which the model reads as "the screen is empty".
    #[test]
    fn a_failed_enumeration_refuses_rather_than_answering_nothing() {
        let answer = from_enumeration(
            Err("no X display".to_string()),
            WindowBelowSource::X11Stacking,
            555,
        );
        match &answer {
            WindowBelowAnswer::Unavailable { error, .. } => {
                assert!(error.contains("no X display"), "{error}")
            }
            other => panic!("expected an explained refusal, got {other:?}"),
        }
        let json = serde_json::to_value(&answer).expect("serializes");
        assert!(json.get("window").is_none());

        // …and an enumerator that ran and found nothing is NOT a refusal.
        let empty = from_enumeration(Ok(vec![]), WindowBelowSource::X11Stacking, 555);
        let json = serde_json::to_value(&empty).expect("serializes");
        assert!(json.get("error").is_none());
        assert!(json["window"].is_null());
    }

    /// A mechanism that answers must name itself, and the one that cannot must
    /// not. `hyprland-ipc` is pinned because the frontend asserts it.
    #[test]
    fn every_mechanism_names_itself_except_the_absent_one() {
        assert_eq!(
            WindowBelowSource::HyprlandIpc.label(),
            Some("hyprland-ipc"),
            "the frontend's surface test asserts this string"
        );
        assert_eq!(WindowBelowSource::Nothing.label(), None);
        for source in [
            WindowBelowSource::X11Stacking,
            WindowBelowSource::MacWindowList,
            WindowBelowSource::MacWindowListUntitled,
            WindowBelowSource::Win32EnumWindows,
        ] {
            let label = source.label().unwrap_or_default();
            assert!(!label.is_empty(), "{source:?} must name its mechanism");
            assert!(
                label
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
                "{label} is not a kebab-case wire value"
            );
        }
    }
}
