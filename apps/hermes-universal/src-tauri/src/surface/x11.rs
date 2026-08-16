//! `read_window_below` on X11 (MJXHRM-392).
//!
//! # Why X11 can answer at all
//!
//! X11 has no notion of window privacy: any client connected to the display can
//! enumerate every other client's windows, read their titles and ask for their
//! geometry. That is the property Wayland was designed to remove, and it is why
//! this file exists on one side of the Linux split and [`super::below`]'s
//! compositor IPC on the other. Nothing here escalates: an app that can open a
//! window on this display can already do all of it.
//!
//! # Not shelling out
//!
//! The Electron desktop reaches the same data through `get-windows`, which
//! shells out to `xprop`/`xwininfo` and therefore fails on any machine without
//! `x11-utils` installed — a failure mode its own error string has to explain.
//! We talk the protocol directly with `x11rb`, which is already compiled into
//! this binary (`arboard` and `global-hotkey` both depend on it), so there is no
//! new dependency, no subprocess and no packaging requirement.
//!
//! # What is narrowed away
//!
//! `_NET_CLIENT_LIST_STACKING` is every managed window on the display. Before
//! anything reaches the picker this drops: windows that are not viewable,
//! zero-sized windows, and anything the EWMH type hints call a desktop or a
//! dock — a full-screen desktop window would otherwise overlap us and win.
//! Windows on other virtual desktops are handled by the viewability test, which
//! is how X11 expresses "on a workspace you cannot see".

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt, MapState, Window};
use x11rb::rust_connection::RustConnection;

use super::below::Bounds;
use super::window_stack::StackedWindow;

/// The class from a `WM_CLASS` property: two NUL-terminated strings, instance
/// then class.
///
/// The class is what Hyprland calls `class` and what the Electron desktop's
/// `owner.name` ends up holding, so taking the second field is what keeps one
/// application's name spelled the same way across the three Linux paths. Falls
/// back to the instance name, then to nothing — never to a partially-parsed
/// string with an embedded NUL, which would travel all the way to the model.
pub fn wm_class(bytes: &[u8]) -> String {
    let mut parts = bytes
        .split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).into_owned());
    let instance = parts.next();

    parts.next().or(instance).unwrap_or_default()
}

/// A text property as a string. X11 text is bytes with no declared encoding;
/// `_NET_WM_NAME` promises UTF-8 and `WM_NAME` promises nothing, so both are
/// read leniently and NUL-terminated forms are trimmed.
pub fn text_property(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes)
        .trim_end_matches('\0')
        .to_string()
}

/// The atoms this module asks about, interned in one round trip.
struct Atoms {
    client_list_stacking: Atom,
    net_wm_name: Atom,
    net_wm_pid: Atom,
    utf8_string: Atom,
    window_type: Atom,
    type_desktop: Atom,
    type_dock: Atom,
}

impl Atoms {
    fn intern(conn: &RustConnection) -> Result<Self, String> {
        // `only_if_exists: false` throughout. Interning a name that no client
        // has used yet costs one atom and cannot fail; asking `only_if_exists`
        // would hand back atom 0, which is not a valid property to then ask
        // for, so the "does the window manager set this?" question is answered
        // from the property reply instead — see `enumerate`.
        let names: [&[u8]; 7] = [
            b"_NET_CLIENT_LIST_STACKING",
            b"_NET_WM_NAME",
            b"_NET_WM_PID",
            b"UTF8_STRING",
            b"_NET_WM_WINDOW_TYPE",
            b"_NET_WM_WINDOW_TYPE_DESKTOP",
            b"_NET_WM_WINDOW_TYPE_DOCK",
        ];
        let cookies = names
            .iter()
            .map(|name| conn.intern_atom(false, name))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("could not intern X11 atoms: {e}"))?;
        let mut atoms = Vec::with_capacity(names.len());
        for cookie in cookies {
            atoms.push(
                cookie
                    .reply()
                    .map_err(|e| format!("the X server refused to intern an atom: {e}"))?
                    .atom,
            );
        }

        Ok(Self {
            client_list_stacking: atoms[0],
            net_wm_name: atoms[1],
            net_wm_pid: atoms[2],
            utf8_string: atoms[3],
            window_type: atoms[4],
            type_desktop: atoms[5],
            type_dock: atoms[6],
        })
    }
}

/// Every managed window on the display, front-to-back, minus the ones that
/// cannot be underneath anything.
///
/// Refuses rather than half-answering when the window manager does not
/// implement `_NET_CLIENT_LIST_STACKING`: there is no way to order windows
/// without it (`QueryTree` returns override-redirect junk and the WM's own frame
/// windows), and a list in arbitrary order would confidently name the wrong
/// application.
pub fn enumerate() -> Result<Vec<StackedWindow>, String> {
    let (conn, screen) = RustConnection::connect(None)
        .map_err(|e| format!("could not connect to the X display: {e}"))?;
    let root = conn
        .setup()
        .roots
        .get(screen)
        .ok_or_else(|| "the X server reported no screen".to_string())?
        .root;
    let atoms = Atoms::intern(&conn)?;

    let stacking = conn
        .get_property(
            false,
            root,
            atoms.client_list_stacking,
            AtomEnum::WINDOW,
            0,
            u32::MAX,
        )
        .map_err(|e| format!("could not ask the X server for the window stack: {e}"))?
        .reply()
        .map_err(|e| format!("the X server refused the window stack: {e}"))?;
    let Some(bottom_to_top) = stacking.value32() else {
        return Err(
            "this window manager does not publish _NET_CLIENT_LIST_STACKING, so there is no way \
             to tell which window is on top of which"
                .to_string(),
        );
    };

    // EWMH defines _NET_CLIENT_LIST_STACKING as bottom-to-top; every picker in
    // this codebase works front-to-back.
    let mut windows: Vec<Window> = bottom_to_top.collect();
    windows.reverse();

    Ok(windows
        .into_iter()
        .filter_map(|window| describe(&conn, root, &atoms, window))
        .collect())
}

/// One window, or `None` when it is not a thing that can be underneath us.
///
/// Every failure here is a skip rather than an error: a window can be destroyed
/// between the stacking list arriving and this asking about it, and one dead
/// window must not take the whole reading down.
fn describe(
    conn: &RustConnection,
    root: Window,
    atoms: &Atoms,
    window: Window,
) -> Option<StackedWindow> {
    // Issued together, replied to together: x11rb defers the reply, so this is
    // one round trip per window rather than six.
    let attributes = conn.get_window_attributes(window).ok()?;
    let geometry = conn.get_geometry(window).ok()?;
    let translated = conn.translate_coordinates(window, root, 0, 0).ok()?;
    let pid = conn
        .get_property(false, window, atoms.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
        .ok()?;
    let class = conn
        .get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
        .ok()?;
    let net_name = conn
        .get_property(false, window, atoms.net_wm_name, atoms.utf8_string, 0, 256)
        .ok()?;
    let wm_name = conn
        .get_property(false, window, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 256)
        .ok()?;
    let window_type = conn
        .get_property(false, window, atoms.window_type, AtomEnum::ATOM, 0, 32)
        .ok()?;

    // Not viewable is how X11 says "minimised, or on a workspace you are not
    // looking at". Either way it is not underneath us.
    if attributes.reply().ok()?.map_state != MapState::VIEWABLE {
        return None;
    }

    let geometry = geometry.reply().ok()?;
    if geometry.width == 0 || geometry.height == 0 {
        return None;
    }

    if let Some(types) = window_type.reply().ok().as_ref().and_then(|r| r.value32()) {
        // A desktop window covers the whole screen and a dock is a panel; both
        // would win the overlap test against anything, and neither is what the
        // user was working in.
        if types.into_iter().any(|t| {
            (t == atoms.type_desktop && atoms.type_desktop != 0)
                || (t == atoms.type_dock && atoms.type_dock != 0)
        }) {
            return None;
        }
    }

    // Geometry is relative to the frame the window manager reparented us into,
    // so it has to be translated to the root before two windows can be compared.
    let translated = translated.reply().ok()?;
    let bounds = Bounds {
        x: i32::from(translated.dst_x),
        y: i32::from(translated.dst_y),
        width: i32::from(geometry.width),
        height: i32::from(geometry.height),
    };

    let pid = pid
        .reply()
        .ok()
        .and_then(|reply| reply.value32()?.next())
        .unwrap_or(0);
    let app = class
        .reply()
        .ok()
        .map(|reply| wm_class(&reply.value))
        .unwrap_or_default();
    // _NET_WM_NAME is UTF-8 and current; WM_NAME is the Latin-1 relic some
    // applications still set alone.
    let title = net_name
        .reply()
        .ok()
        .map(|reply| text_property(&reply.value))
        .filter(|name| !name.is_empty())
        .or_else(|| {
            wm_name
                .reply()
                .ok()
                .map(|reply| text_property(&reply.value))
        })
        .unwrap_or_default();

    Some(StackedWindow {
        app,
        bounds,
        id: u64::from(window),
        // X11 window ids are 32-bit and pids from _NET_WM_PID are CARDINALs; a
        // window that does not set the hint reports 0, which never matches a
        // real pid and so is simply never ours.
        pid: pid as i32,
        title,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_class_is_the_second_field_of_wm_class() {
        assert_eq!(wm_class(b"navigator\0Firefox\0"), "Firefox");
        assert_eq!(wm_class(b"kitty\0kitty\0"), "kitty");
    }

    /// A window that set only an instance name still has to be called
    /// something, and a truncated or empty property must not produce a name
    /// with an embedded NUL in it.
    #[test]
    fn a_partial_wm_class_still_yields_a_name() {
        assert_eq!(wm_class(b"navigator\0"), "navigator");
        assert_eq!(wm_class(b"navigator"), "navigator");
        assert_eq!(wm_class(b""), "");
        assert_eq!(wm_class(b"\0\0"), "");
        assert!(!wm_class(b"a\0b\0c\0").contains('\0'));
    }

    #[test]
    fn a_title_survives_its_trailing_nul_and_invalid_utf8() {
        assert_eq!(text_property(b"MJX Hermes\0"), "MJX Hermes");
        assert_eq!(text_property(b"MJX Hermes"), "MJX Hermes");
        assert_eq!(text_property(b""), "");
        // WM_NAME carries whatever bytes the application set; lossy, never a
        // panic and never a dropped reading.
        assert_eq!(text_property(&[0xff, b'a']), "\u{fffd}a");
    }
}
