//! Window modes (Full / Half / Float): geometry is pure and tested; the commands only apply it.
//!
//! Float on macOS: always-on-top, on every Space and over full-screen apps. It is *not* a true
//! non-activating NSPanel: tauri-nspanel is a git-only dependency and swapping the window's class
//! by hand is fragile, so we set the window level and collection behaviour on the existing NSWindow
//! (floating level, canJoinAllSpaces + fullScreenAuxiliary) and keep Tauri's `always_on_top` +
//! `visible_on_all_workspaces`. Clicking it still activates the app.

use serde::{Deserialize, Serialize};
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewWindow};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub const FLOAT_DEFAULT: (f64, f64) = (470.0, 830.0);
pub const FLOAT_MIN: (f64, f64) = (360.0, 420.0);
const MARGIN: f64 = 16.0;

/// The left or right half of `work` (the screen's visible frame).
pub fn half_frame(work: Rect, right: bool) -> Rect {
    let w = (work.w / 2.0).floor();
    Rect { x: if right { work.x + work.w - w } else { work.x }, y: work.y, w, h: work.h }
}

/// `frame` shrunk to fit `work` (not below `min`) and moved so it is fully inside it.
pub fn clamp_frame(work: Rect, frame: Rect, min: (f64, f64)) -> Rect {
    let w = frame.w.max(min.0).min(work.w);
    let h = frame.h.max(min.1).min(work.h);
    let x = frame.x.max(work.x).min(work.x + work.w - w);
    let y = frame.y.max(work.y).min(work.y + work.h - h);
    Rect { x, y, w, h }
}

/// First placement of the Float window: top-right corner of the work area.
pub fn default_float(work: Rect) -> Rect {
    let w = FLOAT_DEFAULT.0.min(work.w);
    let h = FLOAT_DEFAULT.1.min(work.h - 2.0 * MARGIN).max(FLOAT_MIN.1.min(work.h));
    clamp_frame(work, Rect { x: work.x + work.w - w - MARGIN, y: work.y + MARGIN, w, h }, FLOAT_MIN)
}

fn work_area(win: &WebviewWindow) -> Result<Rect, String> {
    let m = win.current_monitor().map_err(|e| e.to_string())?.or(win.primary_monitor().map_err(|e| e.to_string())?).ok_or("no monitor")?;
    let s = m.scale_factor();
    let a = m.work_area();
    Ok(Rect { x: a.position.x as f64 / s, y: a.position.y as f64 / s, w: a.size.width as f64 / s, h: a.size.height as f64 / s })
}

fn place(win: &WebviewWindow, r: Rect) -> Result<(), String> {
    // Size first: a window can't move to where it would not fit.
    win.set_size(LogicalSize::new(r.w, r.h)).map_err(|e| e.to_string())?;
    win.set_position(LogicalPosition::new(r.x, r.y)).map_err(|e| e.to_string())
}

/// The window's frame in logical units (what the webview stores to restore it later).
#[tauri::command]
pub fn window_frame(app: tauri::AppHandle) -> Result<Rect, String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let s = win.scale_factor().map_err(|e| e.to_string())?;
    let p = win.outer_position().map_err(|e| e.to_string())?;
    let z = win.outer_size().map_err(|e| e.to_string())?;
    Ok(Rect { x: p.x as f64 / s, y: p.y as f64 / s, w: z.width as f64 / s, h: z.height as f64 / s })
}

/// Apply a mode. `frame` is the remembered frame for Full/Float (ignored for Half, which snaps).
#[tauri::command]
pub fn set_window_mode(app: tauri::AppHandle, mode: String, side: String, frame: Option<Rect>) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let float = mode == "float";
    if win.is_fullscreen().unwrap_or(false) && mode != "full" {
        win.set_fullscreen(false).map_err(|e| e.to_string())?;
    }
    if win.is_maximized().unwrap_or(false) {
        win.unmaximize().map_err(|e| e.to_string())?;
    }
    win.set_always_on_top(float).map_err(|e| e.to_string())?;
    win.set_visible_on_all_workspaces(float).map_err(|e| e.to_string())?;
    win.set_min_size(if float { Some(LogicalSize::new(FLOAT_MIN.0, FLOAT_MIN.1)) } else { None::<LogicalSize<f64>> }).map_err(|e| e.to_string())?;
    float_level(&win, float);
    let work = work_area(&win)?;
    match mode.as_str() {
        "half" => place(&win, half_frame(work, side == "right")),
        "float" => place(&win, frame.map_or_else(|| default_float(work), |f| clamp_frame(work, f, FLOAT_MIN))),
        "full" => frame.map_or(Ok(()), |f| place(&win, clamp_frame(work, f, (600.0, 400.0)))),
        other => Err(format!("unknown mode {other}")),
    }
}

/// macOS: floating window level, on all Spaces, allowed next to full-screen apps. No-op elsewhere.
#[cfg(target_os = "macos")]
fn float_level(win: &WebviewWindow, on: bool) {
    use objc2_app_kit::{NSFloatingWindowLevel, NSNormalWindowLevel, NSWindow, NSWindowCollectionBehavior};
    let Ok(ptr) = win.ns_window() else { return };
    let addr = ptr as usize;
    let _ = win.run_on_main_thread(move || {
        // SAFETY: the pointer is the window's own NSWindow, valid while the window lives; main thread.
        let w: &NSWindow = unsafe { &*(addr as *const NSWindow) };
        if on {
            w.setLevel(NSFloatingWindowLevel);
            w.setCollectionBehavior(NSWindowCollectionBehavior::CanJoinAllSpaces | NSWindowCollectionBehavior::FullScreenAuxiliary);
        } else {
            w.setLevel(NSNormalWindowLevel);
            w.setCollectionBehavior(NSWindowCollectionBehavior::Default);
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn float_level(_win: &WebviewWindow, _on: bool) {}

#[cfg(test)]
mod tests {
    use super::*;

    const WORK: Rect = Rect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };

    #[test]
    fn halves_fill_the_visible_frame() {
        assert_eq!(half_frame(WORK, false), Rect { x: 0.0, y: 25.0, w: 720.0, h: 875.0 });
        assert_eq!(half_frame(WORK, true), Rect { x: 720.0, y: 25.0, w: 720.0, h: 875.0 });
    }

    #[test]
    fn halves_on_a_secondary_screen_keep_its_origin() {
        let w = Rect { x: -1920.0, y: 0.0, w: 1920.0, h: 1055.0 };
        assert_eq!(half_frame(w, true).x, -960.0);
        assert_eq!(half_frame(w, false).x, -1920.0);
    }

    #[test]
    fn odd_widths_do_not_overflow() {
        let w = Rect { x: 0.0, y: 0.0, w: 1001.0, h: 500.0 };
        let r = half_frame(w, true);
        assert_eq!(r.x + r.w, 1001.0);
    }

    #[test]
    fn clamp_pulls_a_frame_back_on_screen() {
        let off = Rect { x: 5000.0, y: -300.0, w: 470.0, h: 830.0 };
        let r = clamp_frame(WORK, off, FLOAT_MIN);
        assert_eq!(r, Rect { x: 970.0, y: 25.0, w: 470.0, h: 830.0 });
    }

    #[test]
    fn clamp_shrinks_to_the_screen_but_not_below_the_minimum() {
        let big = Rect { x: 0.0, y: 0.0, w: 5000.0, h: 5000.0 };
        let r = clamp_frame(WORK, big, FLOAT_MIN);
        assert_eq!((r.w, r.h), (1440.0, 875.0));
        let tiny = Rect { x: 0.0, y: 0.0, w: 10.0, h: 10.0 };
        let r = clamp_frame(WORK, tiny, FLOAT_MIN);
        assert_eq!((r.w, r.h), FLOAT_MIN);
    }

    #[test]
    fn float_starts_top_right_at_its_default_size() {
        let r = default_float(WORK);
        assert_eq!((r.w, r.h), FLOAT_DEFAULT);
        assert_eq!(r.x, 1440.0 - 470.0 - 16.0);
        assert_eq!(r.y, 41.0);
    }

    #[test]
    fn float_default_fits_a_small_screen() {
        let small = Rect { x: 0.0, y: 0.0, w: 1280.0, h: 700.0 };
        let r = default_float(small);
        assert!(r.h <= 700.0 && r.y + r.h <= 700.0);
    }
}
