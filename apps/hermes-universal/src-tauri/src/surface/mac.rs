//! `read_window_below` on macOS (MJXHRM-392).
//!
//! # The permission question, stated rather than answered
//!
//! `CGWindowListCopyWindowInfo` hands back every on-screen window's owning
//! application, process id, bounds, layer and stacking position **with no
//! permission at all**. Since macOS 10.15 exactly one field is gated: the
//! window's *title*, which requires the Screen Recording grant.
//!
//! This build never asks for that grant. It calls
//! `CGPreflightScreenCaptureAccess`, which reports whether the grant already
//! exists and does not prompt, and never calls `CGRequestScreenCaptureAccess`,
//! which does. So on a machine where the user has already allowed Hermes to
//! record the screen for some other reason, titles come through; everywhere
//! else the reading still happens and says, in its own `note`, that titles were
//! withheld and why. That is the same line the Electron desktop draws
//! (`electron/main.ts` reads `getMediaAccessStatus('screen')` and never calls
//! `askForMediaAccess` for it), and moving it — adding
//! `NSScreenCaptureUsageDescription` and prompting on first use — is a product
//! decision, not a code change to make in passing.
//!
//! # What is narrowed away
//!
//! `kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements`
//! already drops the wallpaper and the Dock's backing surfaces. On top of that
//! this only keeps layer 0 — the normal application window layer — so menus,
//! tooltips, the menu bar, and the app's own status items never become "the
//! window below". Fully transparent and zero-sized windows go too: both would
//! win an overlap test while showing the user nothing.

use std::ffi::c_void;
use std::ptr;

use core_foundation::base::TCFType;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFGetTypeID, CFTypeRef};
use core_foundation_sys::dictionary::{
    CFDictionaryGetTypeID, CFDictionaryGetValueIfPresent, CFDictionaryRef,
};
use core_foundation_sys::number::{CFNumberGetTypeID, CFNumberRef};
use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
use core_graphics::access::ScreenCaptureAccess;
use core_graphics::window::{
    copy_window_info, kCGNullWindowID, kCGWindowAlpha, kCGWindowBounds, kCGWindowLayer,
    kCGWindowListExcludeDesktopElements, kCGWindowListOptionOnScreenOnly, kCGWindowName,
    kCGWindowNumber, kCGWindowOwnerName, kCGWindowOwnerPID,
};

use super::below::Bounds;
use super::window_stack::StackedWindow;

/// Whether the Screen Recording grant already exists, and therefore whether
/// other applications' window titles are readable.
///
/// `CGPreflightScreenCaptureAccess` never prompts. Its sibling
/// `CGRequestScreenCaptureAccess` does, and is deliberately not called anywhere
/// in this crate — see the module docs.
pub fn titles_available() -> bool {
    ScreenCaptureAccess.preflight()
}

/// The value at `key`, or `None` when the dictionary has no such key.
///
/// # Safety
///
/// `dict` must be a live `CFDictionaryRef` and `key` a live `CFStringRef`. The
/// returned reference is borrowed from `dict` under the Get Rule and must not
/// outlive it.
unsafe fn entry(dict: CFDictionaryRef, key: CFStringRef) -> Option<CFTypeRef> {
    let mut value: *const c_void = ptr::null();
    if CFDictionaryGetValueIfPresent(dict, key.cast(), &mut value) == 0 || value.is_null() {
        return None;
    }

    Some(value.cast())
}

/// A numeric entry. The type is checked rather than assumed: these dictionaries
/// come from the window server, and a key whose value is not the type the
/// documentation promises must be a missing reading, not a reinterpreted
/// pointer.
///
/// # Safety
///
/// As [`entry`].
unsafe fn number(dict: CFDictionaryRef, key: CFStringRef) -> Option<f64> {
    let value = entry(dict, key)?;
    if CFGetTypeID(value) != CFNumberGetTypeID() {
        return None;
    }

    CFNumber::wrap_under_get_rule(value as CFNumberRef).to_f64()
}

/// A string entry.
///
/// # Safety
///
/// As [`entry`].
unsafe fn string(dict: CFDictionaryRef, key: CFStringRef) -> Option<String> {
    let value = entry(dict, key)?;
    if CFGetTypeID(value) != CFStringGetTypeID() {
        return None;
    }

    Some(CFString::wrap_under_get_rule(value as CFStringRef).to_string())
}

/// The `kCGWindowBounds` sub-dictionary, as a rectangle.
///
/// Points, with the origin at the top-left of the main display — one space for
/// every window in the list, which is all the overlap test needs. No conversion
/// to backing pixels happens or should: mixing the two spaces is how a HUD on a
/// Retina display ends up "overlapping" a window on the other side of the desk.
///
/// # Safety
///
/// As [`entry`].
unsafe fn bounds(dict: CFDictionaryRef, key: CFStringRef) -> Option<Bounds> {
    let value = entry(dict, key)?;
    if CFGetTypeID(value) != CFDictionaryGetTypeID() {
        return None;
    }
    let rect = value as CFDictionaryRef;
    let field = |name: &str| {
        let key = CFString::new(name);

        number(rect, key.as_concrete_TypeRef())
    };

    Some(Bounds {
        x: field("X")? as i32,
        y: field("Y")? as i32,
        width: field("Width")? as i32,
        height: field("Height")? as i32,
    })
}

/// Every on-screen application window, front-to-back.
///
/// `titles` is [`titles_available`]'s answer, threaded through rather than
/// re-read, so the reading and the capability descriptor cannot disagree about
/// whether titles were available at the moment the list was taken.
pub fn enumerate(titles: bool) -> Result<Vec<StackedWindow>, String> {
    // CGWindowList's on-screen list is documented front-to-back, which is the
    // order every picker in this codebase wants.
    let list = copy_window_info(
        kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
        kCGNullWindowID,
    )
    .ok_or_else(|| {
        "the macOS window server returned no window list; this usually means the process is not \
         running in a GUI session"
            .to_string()
    })?;

    Ok(list
        .get_all_values()
        .into_iter()
        // SAFETY: every element of the array CGWindowListCopyWindowInfo
        // returns is a CFDictionary, and the array owns them for as long as
        // `list` is alive — which is this whole expression.
        .filter_map(|entry| unsafe { describe(entry.cast(), titles) })
        .collect())
}

/// One window, or `None` when it is not something that can be underneath us.
///
/// # Safety
///
/// `dict` must be a live window-info dictionary from
/// `CGWindowListCopyWindowInfo`.
unsafe fn describe(dict: CFDictionaryRef, titles: bool) -> Option<StackedWindow> {
    // Layer 0 is the ordinary application window layer. Anything above it is
    // chrome — menus, tooltips, the menu bar — and anything below is wallpaper.
    if number(dict, kCGWindowLayer)? != 0.0 {
        return None;
    }
    // Absent alpha means opaque; an explicit zero means invisible.
    if number(dict, kCGWindowAlpha).unwrap_or(1.0) <= 0.0 {
        return None;
    }

    let bounds = bounds(dict, kCGWindowBounds)?;
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }

    Some(StackedWindow {
        app: string(dict, kCGWindowOwnerName).unwrap_or_default(),
        bounds,
        id: number(dict, kCGWindowNumber).unwrap_or(0.0) as u64,
        pid: number(dict, kCGWindowOwnerPID).unwrap_or(0.0) as i32,
        // Without the Screen Recording grant `kCGWindowName` is simply absent,
        // and asking for it costs nothing and prompts for nothing. The empty
        // string that results is explained by the answer's `note` rather than
        // being left to look like a window with no title.
        title: if titles {
            string(dict, kCGWindowName).unwrap_or_default()
        } else {
            String::new()
        },
    })
}
