//! `read_window_below` on Windows (MJXHRM-392).
//!
//! # Why this needs no permission
//!
//! `EnumWindows` walks every top-level window on the desktop and
//! `GetWindowTextW` reads its title, both without any grant — the desktop is a
//! shared namespace on Windows the way the X display is on X11. The only thing
//! that needs a handle is the *owning executable's name*, and
//! `PROCESS_QUERY_LIMITED_INFORMATION` is the access right that exists for
//! exactly this: it is granted across integrity levels and can do nothing but
//! answer questions. A window whose process refuses even that is reported with
//! its title and bounds and an empty application name, not dropped.
//!
//! # What is narrowed away
//!
//! `EnumWindows` returns far more than the user would call a window: every
//! message-only helper, every hidden shell surface, and — since Windows 8 —
//! every suspended UWP application, which stays "visible" while being cloaked
//! by the desktop window manager. Before anything reaches the picker this drops
//! the invisible, the minimised, the DWM-cloaked, tool windows
//! (`WS_EX_TOOLWINDOW`, which is how a floating palette says it is not a
//! document) and empty rectangles.
//!
//! Owned windows are deliberately **kept**: a modal dialog is genuinely the
//! thing the user is looking at, and dropping it — as an alt-tab-style filter
//! would — would report the parent window the dialog is covering.

use std::ffi::c_void;
use std::os::windows::ffi::OsStringExt;

use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows_sys::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsIconic, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
};

use super::below::Bounds;
use super::window_stack::StackedWindow;

/// Collects the handles `EnumWindows` hands back, in the z-order it hands them
/// back in.
///
/// # Safety
///
/// `lparam` must be the `*mut Vec<HWND>` passed to `EnumWindows`, and must
/// outlive the enumeration.
unsafe extern "system" fn collect(window: HWND, lparam: LPARAM) -> i32 {
    let handles = &mut *(lparam as *mut Vec<HWND>);
    handles.push(window);

    // Never stop early: the list is the whole point, and a partial one would
    // silently report the wrong window as "below".
    1
}

/// Whether the desktop window manager is hiding this window.
///
/// A suspended UWP app keeps `WS_VISIBLE` and a full-screen rectangle while
/// showing the user nothing, so without this check the answer on a machine with
/// any Store app installed is frequently a window that is not on screen.
///
/// # Safety
///
/// `window` must be a live window handle.
unsafe fn cloaked(window: HWND) -> bool {
    let mut state: u32 = 0;
    let hr = DwmGetWindowAttribute(
        window,
        DWMWA_CLOAKED as u32,
        std::ptr::addr_of_mut!(state).cast::<c_void>(),
        std::mem::size_of::<u32>() as u32,
    );

    // A non-zero HRESULT means the attribute is unavailable (a pre-DWM desktop,
    // or a window that has just died). "Cannot tell" is treated as not cloaked:
    // dropping a window we could not ask about would lose real answers.
    hr == 0 && state != 0
}

/// A window's title, or the empty string.
///
/// # Safety
///
/// `window` must be a live window handle.
unsafe fn title(window: HWND) -> String {
    let length = GetWindowTextLengthW(window);
    if length <= 0 {
        return String::new();
    }

    // GetWindowTextLengthW may over-report; the return of GetWindowTextW is the
    // count actually written, and is what the string is built from.
    let mut buffer = vec![0u16; length as usize + 1];
    let written = GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32);
    if written <= 0 {
        return String::new();
    }
    buffer.truncate(written as usize);

    String::from_utf16_lossy(&buffer)
}

/// The stem of the owning executable's file name — `chrome`, `Code` — which is
/// the closest Windows analogue to the X11 `WM_CLASS` class and the macOS
/// owner name, so one application is spelled the same way in every platform's
/// answer.
fn executable_stem(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }

    // SAFETY: PROCESS_QUERY_LIMITED_INFORMATION grants nothing but the right to
    // ask; the handle is closed on every path below.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return String::new();
        }

        let mut buffer = vec![0u16; 512];
        let mut length = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            buffer.as_mut_ptr(),
            std::ptr::addr_of_mut!(length),
        );
        CloseHandle(handle);

        if ok == 0 {
            return String::new();
        }
        buffer.truncate(length as usize);

        let path = std::ffi::OsString::from_wide(&buffer);

        std::path::Path::new(&path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default()
    }
}

/// Every top-level window that can be underneath us, front-to-back.
///
/// `EnumWindows` is documented to walk the desktop in z-order from the top
/// down, which is already the order every picker in this codebase wants — there
/// is no reversal here, unlike the X11 path.
pub fn enumerate() -> Result<Vec<StackedWindow>, String> {
    let mut handles: Vec<HWND> = Vec::new();

    // SAFETY: `collect` only ever writes through the pointer it is given, and
    // `handles` outlives the call because EnumWindows is synchronous.
    let ok = unsafe {
        EnumWindows(
            Some(collect),
            std::ptr::addr_of_mut!(handles) as isize as LPARAM,
        )
    };
    if ok == 0 {
        return Err(
            "the desktop window manager refused to enumerate windows (EnumWindows failed)"
                .to_string(),
        );
    }

    Ok(handles
        .into_iter()
        // SAFETY: every handle came from EnumWindows moments ago. A window that
        // has died since simply fails one of the calls below and is skipped.
        .filter_map(|window| unsafe { describe(window) })
        .collect())
}

/// One window, or `None` when it is not something that can be underneath us.
///
/// # Safety
///
/// `window` must be a handle `EnumWindows` produced.
unsafe fn describe(window: HWND) -> Option<StackedWindow> {
    if IsWindowVisible(window) == 0 || IsIconic(window) != 0 || cloaked(window) {
        return None;
    }
    if GetWindowLongPtrW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0 {
        return None;
    }

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if GetWindowRect(window, std::ptr::addr_of_mut!(rect)) == 0 {
        return None;
    }
    let bounds = Bounds {
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
    };
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(window, std::ptr::addr_of_mut!(pid));

    Some(StackedWindow {
        app: executable_stem(pid),
        bounds,
        id: window as usize as u64,
        pid: pid as i32,
        title: title(window),
    })
}
