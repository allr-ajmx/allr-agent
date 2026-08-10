//! Runtime binding to `libgtk-layer-shell` — the GTK3 wrapper around
//! `wlr-layer-shell` (MJXHRM-213).
//!
//! # Why dlopen instead of linking
//!
//! Linking would make the library a hard build dependency of every Linux build.
//! It is not installed as a `-dev` package on the development machine (there is
//! no `gtk-layer-shell-0` pkg-config entry), so `cargo build` would simply stop
//! working; and the library is useless on X11 and on GNOME-on-Wayland, which are
//! the majority of Linux desktops. Loading it at runtime turns a packaging
//! problem into a capability question, which is the whole point of this module's
//! parent: a machine without it *degrades*, it does not fail to build or fail to
//! start.
//!
//! # Why this is safe to call on a Tauri window
//!
//! `gtk_layer_init_for_window` must run **before the GtkWindow is realized**, and
//! Tauri owns window creation. It works out because tao 0.35.3
//! (`platform_impl/linux/window.rs`) ends `Window::new` with
//! `if attributes.visible { window.show_all() } else { window.hide() }`, and wry
//! 0.55.1 only calls `webview.show_all()` when the webview is visible. A window
//! built with `visible: false` therefore reaches us unrealized, children and all.
//! [`init_for_window`] still checks, because "must not be realized" is a
//! precondition we should enforce rather than assume.
//!
//! Every entry point here touches GDK and must run on the GTK main thread. This
//! module does not enforce that; its callers marshal via `run_on_main_thread`.

use std::ffi::{c_char, c_int, CString};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::{Cast, WidgetExt};

type GtkWindowPtr = *mut gtk::ffi::GtkWindow;

/// `GtkLayerShellLayer`. Values confirmed against the installed library rather
/// than taken from the header, which is not present on this machine.
///
/// The whole C enum is modelled even though a floating surface only ever wants
/// the top two: the numbering is positional, so an unused variant is what keeps
/// the used ones pinned to the right integers.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    Background,
    Bottom,
    Top,
    Overlay,
}

impl Layer {
    pub fn as_raw(self) -> c_int {
        match self {
            Self::Background => 0,
            Self::Bottom => 1,
            Self::Top => 2,
            Self::Overlay => 3,
        }
    }
}

/// `GtkLayerShellEdge`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

impl Edge {
    pub const ALL: [Edge; 4] = [Edge::Left, Edge::Right, Edge::Top, Edge::Bottom];

    pub fn as_raw(self) -> c_int {
        match self {
            Self::Left => 0,
            Self::Right => 1,
            Self::Top => 2,
            Self::Bottom => 3,
        }
    }
}

/// `GtkLayerShellKeyboardMode`. Note the ordering: `EXCLUSIVE` is 1 and
/// `ON_DEMAND` is 2 — *not* the "none < on-demand < exclusive" progression the
/// names suggest. Verified by round-tripping the deprecated
/// `gtk_layer_set_keyboard_interactivity(win, TRUE)`, which the library documents
/// as equivalent to exclusive, and reading `get_keyboard_mode` back as 1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyboardMode {
    None,
    Exclusive,
    OnDemand,
}

impl KeyboardMode {
    pub fn as_raw(self) -> c_int {
        match self {
            Self::None => 0,
            Self::Exclusive => 1,
            Self::OnDemand => 2,
        }
    }
}

/// The resolved symbol table. Held for the process lifetime by [`get`] so the
/// library is never unloaded out from under a live layer surface.
pub struct LayerShell {
    _lib: libloading::Library,
    is_supported: unsafe extern "C" fn() -> c_int,
    protocol_version: unsafe extern "C" fn() -> u32,
    init_for_window: unsafe extern "C" fn(GtkWindowPtr),
    is_layer_window: unsafe extern "C" fn(GtkWindowPtr) -> c_int,
    set_layer: unsafe extern "C" fn(GtkWindowPtr, c_int),
    set_anchor: unsafe extern "C" fn(GtkWindowPtr, c_int, c_int),
    set_margin: unsafe extern "C" fn(GtkWindowPtr, c_int, c_int),
    set_exclusive_zone: unsafe extern "C" fn(GtkWindowPtr, c_int),
    set_keyboard_mode: unsafe extern "C" fn(GtkWindowPtr, c_int),
    set_namespace: unsafe extern "C" fn(GtkWindowPtr, *const c_char),
}

/// The SONAME, not the linker name: distributions ship the runtime library
/// without the unversioned `.so` symlink that a `-dev` package provides.
const SONAME: &str = "libgtk-layer-shell.so.0";

/// Absolute locations to try before falling back to the linker search path
/// (MJXHRM-382). A bare SONAME is resolved through `LD_LIBRARY_PATH` and the
/// rest of the search path, so whoever can set the process environment chooses
/// which code we `dlopen`. Naming the standard prefixes first means the ordinary
/// distribution install never consults the search path at all.
///
/// This is a *preference*, not an allowlist: the fallback still exists, because
/// distributions that put the library elsewhere (Nix stores it under
/// `/nix/store`) are the normal case on the compositors this feature targets.
/// The fallback is verified instead — see [`resolved_library_path`].
const PINNED_PATHS: &[&str] = &[
    "/usr/lib/x86_64-linux-gnu/libgtk-layer-shell.so.0",
    "/usr/lib/aarch64-linux-gnu/libgtk-layer-shell.so.0",
    "/usr/lib64/libgtk-layer-shell.so.0",
    "/usr/lib/libgtk-layer-shell.so.0",
    "/usr/local/lib/libgtk-layer-shell.so.0",
];

static LOADED: OnceLock<Option<LayerShell>> = OnceLock::new();

/// The library, or `None` if it is not installed. Loaded once; a failure is
/// cached so a machine without it does not pay for a `dlopen` per call.
pub fn get() -> Option<&'static LayerShell> {
    LOADED.get_or_init(load).as_ref()
}

/// The uid this process runs as, read from `/proc` so no libc binding is needed.
fn self_uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;

    std::fs::metadata("/proc/self").ok().map(|m| m.uid())
}

/// Whether `path` and every directory above it are writable only by their owner,
/// and owned by root or by us.
///
/// This is the check that actually matters for a hijacked search path: planting
/// a library requires a writable directory on it, and a directory anyone can
/// write to is exactly what this refuses. A path we cannot stat is refused too —
/// "could not tell" is not "safe".
fn path_is_trusted(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let Some(uid) = self_uid() else {
        // No /proc to compare against; fall back to the permission bits alone
        // rather than refusing every path on a system without it.
        return trusted_modes_only(path);
    };

    let mut current = Some(path);
    while let Some(component) = current {
        let Ok(meta) = std::fs::metadata(component) else {
            return false;
        };
        if meta.mode() & 0o022 != 0 || (meta.uid() != 0 && meta.uid() != uid) {
            log::warn!(
                "refusing gtk-layer-shell at {}: {} is writable by others or foreign-owned",
                path.display(),
                component.display()
            );

            return false;
        }
        current = component.parent();
    }

    true
}

fn trusted_modes_only(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let mut current = Some(path);
    while let Some(component) = current {
        match std::fs::metadata(component) {
            Ok(meta) if meta.mode() & 0o022 == 0 => current = component.parent(),
            _ => return false,
        }
    }

    true
}

/// Where a library the linker already resolved actually came from, read out of
/// `/proc/self/maps`.
///
/// `dladdr` would answer this too, but it needs a libc binding this crate does
/// not otherwise take, and on the only platform this module compiles for
/// (Linux) the mapping table is authoritative and free.
fn resolved_library_path(soname: &str) -> Option<PathBuf> {
    let maps = std::fs::read_to_string("/proc/self/maps").ok()?;

    maps.lines()
        .filter_map(|line| line.split_once(" /").map(|(_, rest)| format!("/{rest}")))
        .map(PathBuf::from)
        .find(|path| path.file_name().is_some_and(|name| name == soname))
}

fn load() -> Option<LayerShell> {
    let pinned = PINNED_PATHS
        .iter()
        .map(Path::new)
        .find(|path| path.exists() && path_is_trusted(path));

    let lib = match pinned {
        // SAFETY: `dlopen` of a well-known system library at a verified absolute
        // path. gtk-layer-shell runs no initialiser that can observe or alter our
        // state; it only registers with the already-initialised GDK display.
        Some(path) => unsafe { libloading::Library::new(path) }
            .map_err(|e| log::info!("gtk-layer-shell unavailable ({}): {e}", path.display()))
            .ok()?,
        None => {
            // SAFETY: as above, but resolved through the linker search path.
            let lib = unsafe { libloading::Library::new(SONAME) }
                .map_err(|e| log::info!("gtk-layer-shell unavailable ({SONAME}): {e}"))
                .ok()?;

            // Nothing here can un-load what dlopen already ran, so this is an
            // audit-and-refuse, not a prevention: if the search path handed us a
            // library out of a world-writable directory we decline to *use* it,
            // and say where it came from either way.
            match resolved_library_path(SONAME) {
                Some(path) if !path_is_trusted(&path) => return None,
                Some(path) => log::info!("gtk-layer-shell resolved to {}", path.display()),
                None => log::info!("gtk-layer-shell loaded from an unresolvable path ({SONAME})"),
            }

            lib
        }
    };

    // SAFETY: each symbol's signature is transcribed from gtk-layer-shell.h and
    // matches the exported C ABI. A missing symbol makes the whole load fail
    // rather than leaving a half-populated table.
    unsafe {
        macro_rules! sym {
            ($name:literal) => {
                *lib.get($name.as_bytes()).ok()?
            };
        }
        let shell = LayerShell {
            is_supported: sym!("gtk_layer_is_supported\0"),
            protocol_version: sym!("gtk_layer_get_protocol_version\0"),
            init_for_window: sym!("gtk_layer_init_for_window\0"),
            is_layer_window: sym!("gtk_layer_is_layer_window\0"),
            set_layer: sym!("gtk_layer_set_layer\0"),
            set_anchor: sym!("gtk_layer_set_anchor\0"),
            set_margin: sym!("gtk_layer_set_margin\0"),
            set_exclusive_zone: sym!("gtk_layer_set_exclusive_zone\0"),
            set_keyboard_mode: sym!("gtk_layer_set_keyboard_mode\0"),
            set_namespace: sym!("gtk_layer_set_namespace\0"),
            _lib: lib,
        };
        Some(shell)
    }
}

impl LayerShell {
    /// Whether the *compositor* speaks `zwlr_layer_shell_v1`. This is a
    /// behavioural probe, not an "did the call error" probe — which matters,
    /// because the trait this replaces (GTK `set_keep_above`) fails silently on
    /// Wayland and would otherwise look like a success.
    pub fn is_supported(&self) -> bool {
        // SAFETY: no arguments, no state; requires only that GDK is initialised,
        // which it is by the time any Tauri command can run.
        unsafe { (self.is_supported)() != 0 }
    }

    pub fn protocol_version(&self) -> u32 {
        // SAFETY: as above.
        unsafe { (self.protocol_version)() }
    }

    /// Turn `window` into a layer surface. Fails rather than corrupting the
    /// window if it has already been realized — the library's own precondition.
    pub fn init_for_window(&self, window: &gtk::ApplicationWindow) -> Result<(), String> {
        if window.is_realized() {
            return Err(
                "window is already realized; a layer surface must be configured before it is shown"
                    .to_string(),
            );
        }
        let upcast: gtk::Window = window.clone().upcast();
        let stash: gtk::glib::translate::Stash<'_, GtkWindowPtr, _> = upcast.to_glib_none();
        // SAFETY: `stash.0` is a live borrowed GtkWindow* for the duration of this
        // statement, and the window is unrealized as the library requires.
        unsafe { (self.init_for_window)(stash.0) };
        Ok(())
    }

    pub fn is_layer_window(&self, window: &gtk::ApplicationWindow) -> bool {
        let upcast: gtk::Window = window.clone().upcast();
        let stash: gtk::glib::translate::Stash<'_, GtkWindowPtr, _> = upcast.to_glib_none();
        // SAFETY: live borrowed pointer, valid for this call.
        unsafe { (self.is_layer_window)(stash.0) != 0 }
    }

    /// Apply the whole DMS-shaped configuration in one go, so a caller cannot
    /// half-configure a surface. See the module docs on `mod.rs` for why the
    /// surface is anchored to every edge and positioned with margins rather than
    /// being sized and moved.
    pub fn configure(
        &self,
        window: &gtk::ApplicationWindow,
        namespace: &str,
        layer: Layer,
        keyboard: KeyboardMode,
        margins: [i32; 4],
    ) {
        let upcast: gtk::Window = window.clone().upcast();
        let stash: gtk::glib::translate::Stash<'_, GtkWindowPtr, _> = upcast.to_glib_none();
        let ptr = stash.0;
        let ns =
            CString::new(namespace).unwrap_or_else(|_| CString::new("hermes").expect("literal"));

        // SAFETY: `ptr` is a live GtkWindow* already turned into a layer surface
        // by `init_for_window`; `ns` outlives the call. Every enum is converted
        // through `as_raw`, whose values are pinned by the tests below.
        unsafe {
            (self.set_namespace)(ptr, ns.as_ptr());
            (self.set_layer)(ptr, layer.as_raw());
            (self.set_keyboard_mode)(ptr, keyboard.as_raw());
            // Anchoring all four edges makes the surface exactly the size of the
            // output and keeps it that size forever. Dynamic layer-surface
            // resizes misbehave on some compositors.
            for edge in Edge::ALL {
                (self.set_anchor)(ptr, edge.as_raw(), 1);
            }
            for (edge, margin) in Edge::ALL.iter().zip(margins) {
                (self.set_margin)(ptr, edge.as_raw(), margin);
            }
            // -1 means "reserve nothing AND ignore what everyone else reserved",
            // which is what lets the surface cover a status bar.
            (self.set_exclusive_zone)(ptr, -1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The numeric values are the contract with a C library we do not link, so a
    // typo here is a silently mis-placed surface rather than a compile error.
    // Pinned against the installed 0.8.2 by probe, not against the header.
    #[test]
    fn layer_values_match_the_c_enum() {
        assert_eq!(Layer::Background.as_raw(), 0);
        assert_eq!(Layer::Bottom.as_raw(), 1);
        assert_eq!(Layer::Top.as_raw(), 2);
        assert_eq!(Layer::Overlay.as_raw(), 3);
    }

    #[test]
    fn edge_values_match_the_c_enum() {
        assert_eq!(Edge::Left.as_raw(), 0);
        assert_eq!(Edge::Right.as_raw(), 1);
        assert_eq!(Edge::Top.as_raw(), 2);
        assert_eq!(Edge::Bottom.as_raw(), 3);
    }

    /// The one that is genuinely counter-intuitive: exclusive sorts before
    /// on-demand in the C enum.
    #[test]
    fn keyboard_mode_exclusive_is_one_not_two() {
        assert_eq!(KeyboardMode::None.as_raw(), 0);
        assert_eq!(KeyboardMode::Exclusive.as_raw(), 1);
        assert_eq!(KeyboardMode::OnDemand.as_raw(), 2);
    }

    #[test]
    fn every_edge_is_covered_once() {
        let mut raw: Vec<_> = Edge::ALL.iter().map(|e| e.as_raw()).collect();
        raw.sort_unstable();
        assert_eq!(raw, vec![0, 1, 2, 3]);
    }
}
