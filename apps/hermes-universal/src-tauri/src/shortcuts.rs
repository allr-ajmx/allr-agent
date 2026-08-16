//! OS-level hotkeys — claimed by RUST, not by a webview (MJXHRM-437).
//!
//! # Why the claim moved
//!
//! `lib/keybinds/global-shortcut.ts` used to call the global-shortcut plugin's JS
//! API directly. The plugin's registry is per PROCESS while the handler channel
//! that answers a chord belongs to the WINDOW that registered it, so every full
//! app window asked for the same accelerators at boot, one was granted and the
//! rest were refused with "already registered" — and closing THAT window natively
//! left the chord claimed from the whole machine, answering into a channel that
//! had died with the window (MJXHRM-384). The app carried a whole native event
//! (`hermes://app-window-closed`) whose only job was to tell the survivors to
//! take the claim back.
//!
//! Background mode turns that from a bug into the normal case. The surviving
//! window is `main`, hidden (`window::hide_this_window` refuses from anything
//! else), and "no window is visible" is exactly the state the chord exists to be
//! useful in. Three things follow that a webview claim cannot give:
//!
//!  * **Ownership outlives every window.** Nothing to reclaim, nothing to race.
//!  * **Nothing throttles it.** WKWebView and WebView2 both throttle occluded
//!    content, and a hidden window is the strongest form of occluded. The claim
//!    now lives where no scheduler can put it to sleep.
//!  * **A cold summon is possible at all.** With zero windows there is no webview
//!    to hold anything; the cold-summon path builds one instead.
//!
//! # What did NOT move
//!
//! The frontend still decides WHAT is wanted — `desiredAccelerators()` over
//! `$bindings` — so rebinding and the first-run disclosure are untouched. Only
//! the party that talks to the OS changed. [`global_shortcuts_sync`] is a
//! REGISTRAR: it takes the whole desired set and reconciles, so a sync from a
//! second window that wants the same chords is a no-op rather than a churn of
//! release-and-reclaim.
//!
//! And the ACTION still runs in a webview. `toggleHud` needs the handoff
//! install, the draft flush and session resolution, none of which belong in Rust
//! — so delivery picks one window and emits into it. That is the honest limit
//! of this change: the claim is immune to throttling, the response is not. If the
//! hidden host ever answers late enough to feel it, the next step is a native
//! summon (Rust builds `sat-hud` itself and tells the frontend afterwards).

use std::collections::BTreeMap;

/// Rust's delivery of a chord that fired, emitted at ONE window.
///
/// Targeted, not broadcast, and the frontend must `listen` with its own label as
/// the target — Tauri filters an `emit_to` against the target the listener
/// registered, and the JS default (`{ kind: 'Any' }`) matches NOTHING an
/// `emit_to` sends (`AppManager::emit_to` → `filter_target`). Broadcasting
/// instead is not the fix: two full app windows would both run `toggleHud`, which
/// summons the HUD and dismisses it in the same keypress.
#[cfg(desktop)]
pub const GLOBAL_SHORTCUT_EVENT: &str = "hermes://global-shortcut";

/// The action the tray's *Open HUD* row stands for.
///
/// The one action id Rust names. It is the id in `src/lib/keybinds/actions.ts`,
/// and `global-shortcut.test.ts` reads this constant out of this file and asserts
/// the registry still has it — a native menu row that fired an action nothing
/// handles would be a dead click with no error anywhere.
#[cfg(desktop)]
pub const HUD_ACTION_ID: &str = "view.toggleHud";

/// One accelerator the frontend wants held, and what it stands for.
///
/// `combo` is carried because an accelerator is the OS's spelling and unfit to
/// show: the first-run disclosure names the chord the user would type.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutClaim {
    pub accelerator: String,
    pub action_id: String,
    pub combo: String,
}

/// What a sync actually achieved, in combos.
#[derive(Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSync {
    /// Combos the OS granted IN THIS PASS — what the first-run disclosure names.
    /// A chord another application owns is not in here, and neither is one this
    /// process was already holding: neither is news.
    pub granted: Vec<String>,
    /// Combos the OS refused. A legitimate outcome — the other app keeps its
    /// chord and the in-app binding still works — so it is reported, not raised.
    pub refused: Vec<String>,
}

// Desktop: the registry, the reconciler and the delivery decision.
#[cfg(desktop)]
mod imp {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use tauri::{Emitter, Manager};
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState as Edge};

    use super::{ShortcutClaim, ShortcutSync, GLOBAL_SHORTCUT_EVENT};

    /// Everything this process holds from the window system, plus the one slot a
    /// cold summon parks its action in.
    #[derive(Default)]
    pub struct ShortcutState {
        /// accelerator → the action id it currently stands for. Exactly what the
        /// OS is holding for us, so [`super::diff_claims`] can leave an unchanged
        /// claim alone instead of churning it.
        claims: Mutex<BTreeMap<String, String>>,
        /// A chord that fired with no window able to take it.
        ///
        /// ONE slot, last writer wins: two chords pressed before the app can
        /// paint means the user meant the second. Read-and-clear, because a
        /// pending action replayed on a later boot would summon a HUD nobody
        /// asked for.
        pending: Mutex<Option<String>>,
    }

    impl ShortcutState {
        pub fn park_pending(&self, action_id: &str) {
            *self.pending.lock().unwrap_or_else(|err| err.into_inner()) =
                Some(action_id.to_string());
        }

        pub fn take_pending(&self) -> Option<String> {
            self.pending
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .take()
        }
    }

    /// The event payload. `actionId` is read by `startGlobalShortcuts`'s listener
    /// and handed to the SAME handler map the in-app chord uses.
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Fired {
        action_id: String,
    }

    /// Reconcile the OS's registrations with `wanted`.
    ///
    /// One lock for the whole pass. Two windows booting at once both call this,
    /// and a read-diff-write with the lock released in between would let the
    /// second overwrite the first's record of what is held — leaving a chord
    /// claimed from the machine that nothing here knows to give back.
    pub fn sync(app: &tauri::AppHandle, wanted: &[ShortcutClaim]) -> ShortcutSync {
        let Some(state) = app.try_state::<ShortcutState>() else {
            return ShortcutSync::default();
        };

        let mut held = state.claims.lock().unwrap_or_else(|err| err.into_inner());
        let (release, take) = super::diff_claims(&held, wanted);

        for accelerator in release {
            if let Err(err) = app.global_shortcut().unregister(accelerator.as_str()) {
                // Already gone, or the window system took it back with the
                // window that had it. Either way it is not ours any more.
                log::warn!("could not release global shortcut {accelerator}: {err}");
            }

            held.remove(&accelerator);
        }

        let mut granted = Vec::new();
        let mut refused = Vec::new();

        for claim in take {
            match register(app, &claim) {
                Ok(()) => {
                    held.insert(claim.accelerator.clone(), claim.action_id.clone());
                    granted.push(claim.combo);
                }
                Err(err) => {
                    // Another application already owns the chord. A legitimate
                    // outcome of a global claim, not a failure of ours.
                    log::warn!("global shortcut unavailable {}: {err}", claim.accelerator);
                    refused.push(claim.combo);
                }
            }
        }

        ShortcutSync { granted, refused }
    }

    fn register(app: &tauri::AppHandle, claim: &ShortcutClaim) -> Result<(), String> {
        let action_id = claim.action_id.clone();

        app.global_shortcut()
            .on_shortcut(claim.accelerator.as_str(), move |app, _shortcut, event| {
                // The backend reports both edges; acting on Released too would
                // run the action twice per press.
                if event.state == Edge::Pressed {
                    fire(app, &action_id);
                }
            })
            .map_err(|err| err.to_string())
    }

    /// Give every claimed chord back.
    ///
    /// Called from the one deliberate way out (`background::quit_app`, tray ▸
    /// Quit) rather than from a window's teardown. That is the change this module
    /// exists for: a window going away must NOT release the claim, because the
    /// whole point is that the chord survives having no windows. The OS releases
    /// a process's hotkeys when the process dies, so this is belt-and-braces —
    /// but the braces are what make "quit, then press the chord, and your window
    /// manager gets it back" true at the moment of the quit rather than whenever
    /// the process actually unwinds.
    pub fn release_all(app: &tauri::AppHandle) {
        let Some(state) = app.try_state::<ShortcutState>() else {
            return;
        };

        let mut held = state.claims.lock().unwrap_or_else(|err| err.into_inner());

        for accelerator in held.keys() {
            let _ = app.global_shortcut().unregister(accelerator.as_str());
        }

        held.clear();
    }

    /// A chord fired (or the tray's *Open HUD* row was clicked). Hand it to a
    /// window.
    ///
    /// Hops to the main thread because reading window visibility and building a
    /// window are both main-thread work, and the hotkey backend's handler may run
    /// on any thread — on macOS it is already the main one, where
    /// `run_on_main_thread` executes the task INLINE rather than deadlocking, so
    /// this is also the shortest path to the summon.
    pub fn fire(app: &tauri::AppHandle, action_id: &str) {
        let app = app.clone();
        let action_id = action_id.to_string();
        let handle = app.clone();

        if let Err(err) = handle.run_on_main_thread(move || deliver(&app, &action_id)) {
            log::warn!("could not schedule a global shortcut: {err}");
        }
    }

    /// Main-thread half of [`fire`].
    fn deliver(app: &tauri::AppHandle, action_id: &str) {
        let windows: Vec<(String, bool)> = app
            .webview_windows()
            .into_iter()
            .map(|(label, window)| {
                // A window whose visibility cannot be read is treated as hidden:
                // that only ever costs it the visible-first preference, while
                // guessing "visible" could send the chord to a window the user
                // cannot see in preference to one they can.
                let visible = window.is_visible().unwrap_or(false);

                (label, visible)
            })
            .collect();

        match super::delivery_target(&windows) {
            // A hidden window is a fine host: the action it runs opens a
            // DIFFERENT window, so the host never needs to be seen.
            super::Delivery::Visible(label) | super::Delivery::Hidden(label) => {
                let payload = Fired {
                    action_id: action_id.to_string(),
                };

                if let Err(err) = app.emit_to(label.as_str(), GLOBAL_SHORTCUT_EVENT, payload) {
                    log::warn!("could not deliver a global shortcut to {label}: {err}");
                }
            }
            super::Delivery::None => {
                // Cold summon. Park the action FIRST — the window we are about to
                // build drains the slot as soon as its frontend starts, and a
                // build that raced ahead of the park would find it empty.
                if let Some(state) = app.try_state::<ShortcutState>() {
                    state.park_pending(action_id);
                }

                if let Err(err) = crate::window::build_hidden_main_window(app) {
                    log::warn!("cold summon could not build a window: {err}");
                }
            }
        }
    }
}

// Mobile: neither phone OS lets an app claim a system-wide chord, and the plugin
// crate is not in the mobile dependency set at all. `ShortcutState` still exists
// so the builder's `.manage()` is one line on both targets, and the commands stay
// registered so a stray call is a clear refusal rather than an "unknown command"
// that reads like a broken build (the `window.rs` / `tray.rs` idiom).
#[cfg(mobile)]
mod imp {
    #[derive(Default)]
    pub struct ShortcutState;
}

pub use imp::ShortcutState;

#[cfg(desktop)]
pub use imp::{fire, release_all};

/// Which accelerators to hand back and which to take, to get from `current` to
/// `wanted`.
///
/// Returns `(release, claim)`. **An accelerator whose action is unchanged appears
/// in neither** — that is the entire reason this is a diff rather than a
/// release-all-then-claim-all. Every full app window syncs the same desired set
/// at boot, and a registrar that dropped and retook the chord on each one would
/// leave a window in which the chord is held by nobody, reachable by any other
/// application on the machine, once per window opened.
///
/// First writer wins for a duplicated accelerator, matching
/// `desiredAccelerators()`, so two actions bound to one chord resolve the same
/// way on both sides of the boundary.
#[cfg(desktop)]
pub fn diff_claims(
    current: &BTreeMap<String, String>,
    wanted: &[ShortcutClaim],
) -> (Vec<String>, Vec<ShortcutClaim>) {
    let mut by_accelerator: BTreeMap<&str, &ShortcutClaim> = BTreeMap::new();

    for claim in wanted {
        by_accelerator
            .entry(claim.accelerator.as_str())
            .or_insert(claim);
    }

    let release = current
        .iter()
        .filter(|(accelerator, action)| {
            by_accelerator
                .get(accelerator.as_str())
                .map(|claim| &claim.action_id)
                != Some(*action)
        })
        .map(|(accelerator, _)| accelerator.clone())
        .collect();

    let claim = by_accelerator
        .values()
        .filter(|claim| current.get(&claim.accelerator) != Some(&claim.action_id))
        .map(|claim| (*claim).clone())
        .collect();

    (release, claim)
}

/// Which window answers a chord.
#[cfg(desktop)]
#[derive(Debug, PartialEq)]
pub enum Delivery {
    Visible(String),
    Hidden(String),
    None,
}

/// Prefer a VISIBLE full app window, then any full app window, then nothing.
///
/// **Not a second window resolver.** Which labels count as "the app" is
/// [`crate::window::window_to_reveal`]'s answer and this asks it twice — once
/// over the visible labels, once over all of them. Two functions that could
/// disagree about which window is the app is precisely how the tray would reveal
/// one window while the chord talked to another; `window.rs`'s exclusions (never
/// a satellite, never a tile, `main` before the lowest `instance-`) are therefore
/// stated once and inherited here.
///
/// Visible beats hidden because it is the only preference this adds: with
/// background mode on, `main` is hidden and a pop-out may be on screen, and the
/// window the user is looking at is the one whose HUD they expect.
#[cfg(desktop)]
pub fn delivery_target(windows: &[(String, bool)]) -> Delivery {
    let visible: Vec<String> = windows
        .iter()
        .filter(|(_, visible)| *visible)
        .map(|(label, _)| label.clone())
        .collect();

    if let Some(label) = crate::window::window_to_reveal(&visible) {
        return Delivery::Visible(label.to_string());
    }

    let all: Vec<String> = windows.iter().map(|(label, _)| label.clone()).collect();

    match crate::window::window_to_reveal(&all) {
        Some(label) => Delivery::Hidden(label.to_string()),
        None => Delivery::None,
    }
}

/// Bring the OS's registrations in line with what the frontend wants held.
#[cfg(desktop)]
#[tauri::command]
pub fn global_shortcuts_sync(
    app: tauri::AppHandle,
    claims: Vec<ShortcutClaim>,
) -> Result<ShortcutSync, String> {
    Ok(imp::sync(&app, &claims))
}

/// Take the chord that fired before any window could answer it, and clear it.
///
/// Drained once per full app window at `startGlobalShortcuts()`. Read-and-clear
/// so the second window to boot finds nothing, and so a cold summon cannot be
/// replayed on the next launch.
#[cfg(desktop)]
#[tauri::command]
pub fn global_shortcut_take_pending(
    state: tauri::State<'_, ShortcutState>,
) -> Result<Option<String>, String> {
    Ok(state.take_pending())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn global_shortcuts_sync(_claims: Vec<ShortcutClaim>) -> Result<ShortcutSync, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn global_shortcut_take_pending() -> Result<Option<String>, String> {
    Err("unsupported_platform".to_string())
}

#[cfg(all(test, desktop))]
mod tests {
    use super::*;

    fn want(accelerator: &str, action_id: &str) -> ShortcutClaim {
        ShortcutClaim {
            accelerator: accelerator.to_string(),
            action_id: action_id.to_string(),
            combo: format!("combo:{accelerator}"),
        }
    }

    fn held(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(a, id)| (a.to_string(), id.to_string()))
            .collect()
    }

    fn windows(pairs: &[(&str, bool)]) -> Vec<(String, bool)> {
        pairs
            .iter()
            .map(|(label, visible)| (label.to_string(), *visible))
            .collect()
    }

    /// Every full app window syncs the same desired set at boot. If an unchanged
    /// claim were released and retaken there would be a window — once per window
    /// opened — in which the chord is held by nobody and any other application on
    /// the machine can take it.
    #[test]
    fn an_unchanged_claim_is_left_alone() {
        let current = held(&[("CommandOrControl+Shift+H", "view.toggleHud")]);
        let wanted = vec![want("CommandOrControl+Shift+H", "view.toggleHud")];

        let (release, claim) = diff_claims(&current, &wanted);

        assert!(release.is_empty(), "released {release:?}");
        assert!(claim.is_empty(), "re-claimed {claim:?}");
    }

    /// A rebind moves ONE chord. Releasing everything would hand back the chord
    /// the user did not touch, and the second action would be unreachable from
    /// outside the app until the next sync happened to retake it.
    #[test]
    fn a_rebind_releases_only_the_old_accelerator() {
        let current = held(&[
            ("CommandOrControl+Shift+H", "view.toggleHud"),
            ("CommandOrControl+Shift+Space", "view.toggleQuickEntry"),
        ]);
        let wanted = vec![
            want("CommandOrControl+Alt+H", "view.toggleHud"),
            want("CommandOrControl+Shift+Space", "view.toggleQuickEntry"),
        ];

        let (release, claim) = diff_claims(&current, &wanted);

        assert_eq!(release, vec!["CommandOrControl+Shift+H".to_string()]);
        assert_eq!(
            claim
                .iter()
                .map(|c| c.accelerator.as_str())
                .collect::<Vec<_>>(),
            vec!["CommandOrControl+Alt+H"]
        );
    }

    /// The same accelerator now standing for a DIFFERENT action is not an
    /// unchanged claim: the OS is holding it against a handler that would fire
    /// the wrong thing, so it has to be released and retaken.
    #[test]
    fn rebinding_an_accelerator_to_another_action_retakes_it() {
        let current = held(&[("CommandOrControl+Shift+H", "view.toggleHud")]);
        let wanted = vec![want("CommandOrControl+Shift+H", "view.toggleQuickEntry")];

        let (release, claim) = diff_claims(&current, &wanted);

        assert_eq!(release, vec!["CommandOrControl+Shift+H".to_string()]);
        assert_eq!(claim.len(), 1);
        assert_eq!(claim[0].action_id, "view.toggleQuickEntry");
    }

    /// Unbinding the action in Settings must give the chord back to the machine,
    /// not merely stop dispatching it.
    #[test]
    fn unbinding_releases_and_claims_nothing() {
        let current = held(&[("CommandOrControl+Shift+H", "view.toggleHud")]);

        let (release, claim) = diff_claims(&current, &[]);

        assert_eq!(release, vec!["CommandOrControl+Shift+H".to_string()]);
        assert!(claim.is_empty());
    }

    /// With background mode on, `main` is hidden and a pop-out may be on screen.
    /// The window the user is looking at is the one whose HUD they expect — and
    /// it is also the one whose webview is NOT being throttled.
    #[test]
    fn a_visible_window_wins_over_a_hidden_one() {
        assert_eq!(
            delivery_target(&windows(&[("main", false), ("instance-2", true)])),
            Delivery::Visible("instance-2".to_string())
        );

        // ...and with nothing visible the hidden one still answers. This is the
        // NORMAL background-mode state, not an edge case.
        assert_eq!(
            delivery_target(&windows(&[("main", false), ("instance-2", false)])),
            Delivery::Hidden("main".to_string())
        );
    }

    /// A satellite does not mount `useKeybinds`, so it has no dispatcher and no
    /// handler map — a chord delivered there lands nowhere and the user sees a
    /// dead keypress. A detached tile is the same. Both are live windows that a
    /// naive "pick any window" would choose.
    #[test]
    fn a_satellite_is_never_a_delivery_target() {
        assert_eq!(
            delivery_target(&windows(&[("sat-hud", true)])),
            Delivery::None
        );
        assert_eq!(
            delivery_target(&windows(&[
                ("sat-quick", true),
                ("tile-session-tile-abc", true)
            ])),
            Delivery::None
        );

        // A satellite on screen must not outrank a hidden window that CAN answer.
        assert_eq!(
            delivery_target(&windows(&[("sat-hud", true), ("main", false)])),
            Delivery::Hidden("main".to_string())
        );
    }

    /// Nothing at all: the cold-summon path, where `deliver` parks the action and
    /// builds `main` hidden.
    #[test]
    fn no_app_window_is_a_cold_summon() {
        assert_eq!(delivery_target(&[]), Delivery::None);
    }

    /// The tray reveals one window and the chord talks to another only if these
    /// two disagree about which window is the app. They cannot: `delivery_target`
    /// IS `window_to_reveal`, asked twice.
    #[test]
    fn delivery_and_reveal_agree_on_which_window_is_the_app() {
        let sets: &[&[&str]] = &[
            &["sat-hud", "tile-x", "instance-10", "instance-2", "main"],
            &["instance-10", "instance-2"],
            &["sat-hud", "tile-x"],
            &["screen"],
            &[],
        ];

        // Visibility is the ONE thing this function adds, so hold it constant and
        // the two must answer identically.
        for uniform in [true, false] {
            for labels in sets {
                let owned: Vec<String> = labels.iter().map(|l| (*l).to_string()).collect();
                let pairs: Vec<(String, bool)> =
                    owned.iter().map(|l| (l.clone(), uniform)).collect();

                let expected = crate::window::window_to_reveal(&owned).map(str::to_string);
                let got = match delivery_target(&pairs) {
                    Delivery::Visible(label) | Delivery::Hidden(label) => Some(label),
                    Delivery::None => None,
                };

                assert_eq!(got, expected, "{labels:?} visible={uniform}");
            }
        }
    }

    /// The pending slot is read-and-clear. A second window booting behind the
    /// first must not summon a second HUD, and a slot that survived would replay
    /// the chord on the next launch.
    #[test]
    fn a_pending_action_is_drained_once() {
        let state = ShortcutState::default();

        assert_eq!(state.take_pending(), None);

        state.park_pending(HUD_ACTION_ID);

        assert_eq!(state.take_pending(), Some(HUD_ACTION_ID.to_string()));
        assert_eq!(state.take_pending(), None);
    }

    /// Two chords pressed before the app can paint: the user meant the second.
    #[test]
    fn the_pending_slot_keeps_the_last_chord() {
        let state = ShortcutState::default();

        state.park_pending("view.toggleQuickEntry");
        state.park_pending(HUD_ACTION_ID);

        assert_eq!(state.take_pending(), Some(HUD_ACTION_ID.to_string()));
    }

    /// Nothing is held before a sync, so the first pass claims everything and
    /// releases nothing — the state a fresh process starts in.
    #[test]
    fn a_fresh_process_claims_without_releasing() {
        let (release, claim) = diff_claims(
            &BTreeMap::new(),
            &[want("CommandOrControl+Shift+H", "view.toggleHud")],
        );

        assert!(release.is_empty());
        assert_eq!(claim.len(), 1);
    }
}
