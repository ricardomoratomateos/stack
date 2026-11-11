//! Pieces of the tmux <-> webview bridge that need no window: flow-control
//! bookkeeping, `list-panes` parsing and event payloads.

use std::collections::HashSet;

use base64::Engine;
use serde::Serialize;
use tmux_cc::Notification;

/// What the Tauri side should do after a tmux notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Forward pane bytes to the webview.
    Output { pane: String, data: Vec<u8> },
    /// Send `refresh-client -A %pane:continue`.
    Continue(String),
    /// Windows or panes changed; the frontend should re-list.
    LayoutChanged,
    /// The tmux connection ended.
    Exit,
}

/// Tracks which panes the UI shows and which tmux paused.
#[derive(Debug, Default)]
pub struct Flow {
    visible: HashSet<String>,
    paused: HashSet<String>,
}

impl Flow {
    pub fn on_notification(&mut self, n: Notification) -> Vec<Action> {
        match n {
            Notification::Output { pane, data } | Notification::ExtendedOutput { pane, data, .. } => {
                vec![Action::Output { pane, data }]
            }
            Notification::Pause { pane } => {
                if self.visible.contains(&pane) {
                    vec![Action::Continue(pane)]
                } else {
                    self.paused.insert(pane);
                    vec![]
                }
            }
            Notification::Continue { pane } => {
                self.paused.remove(&pane);
                vec![]
            }
            Notification::WindowAdd { .. }
            | Notification::WindowClose { .. }
            | Notification::WindowRenamed { .. }
            | Notification::WindowPaneChanged { .. }
            | Notification::LayoutChange { .. }
            | Notification::SessionWindowChanged { .. } => vec![Action::LayoutChanged],
            Notification::Exit { .. } => vec![Action::Exit],
            _ => vec![],
        }
    }

    /// Replace the visible set; returns panes that were paused and just
    /// became visible (the caller must `continue` them).
    pub fn set_visible(&mut self, panes: impl IntoIterator<Item = String>) -> Vec<String> {
        self.visible = panes.into_iter().collect();
        let mut resume: Vec<String> = self.paused.iter().filter(|p| self.visible.contains(*p)).cloned().collect();
        resume.sort();
        for p in &resume {
            self.paused.remove(p);
        }
        resume
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PaneInfo {
    pub id: String,
    pub window: String,
    pub window_index: u32,
    pub window_name: String,
    pub cols: u16,
    pub rows: u16,
    pub active: bool,
    pub command: String,
}

/// Format string for `list-panes`; fields are tab separated.
pub const LIST_FORMAT: &str =
    "#{pane_id}\t#{window_id}\t#{window_index}\t#{window_name}\t#{pane_width}\t#{pane_height}\t#{pane_active}\t#{pane_current_command}";

pub fn parse_panes(text: &str) -> Vec<PaneInfo> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            if f.len() < 8 {
                return None;
            }
            Some(PaneInfo {
                id: f[0].into(),
                window: f[1].into(),
                window_index: f[2].parse().ok()?,
                window_name: f[3].into(),
                cols: f[4].parse().ok()?,
                rows: f[5].parse().ok()?,
                active: f[6] == "1",
                command: f[7].into(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputPayload {
    pub pane: String,
    /// Base64 of the raw bytes (terminal output is not valid UTF-8 in general).
    pub data: String,
}

pub fn output_payload(pane: &str, data: &[u8]) -> OutputPayload {
    OutputPayload { pane: pane.into(), data: base64::engine::general_purpose::STANDARD.encode(data) }
}

/// Only tmux ids (`%1`, `@2`) may be spliced into commands.
pub fn valid_id(id: &str, sigil: char) -> bool {
    id.strip_prefix(sigil).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// `capture-pane` command for lines `start..=end` (negative = history), with
/// escapes (`-e`) so colours survive.
pub fn capture_command(pane: &str, start: i32, end: Option<i32>) -> String {
    let mut c = format!("capture-pane -p -e -t {pane} -S {start}");
    if let Some(e) = end {
        c.push_str(&format!(" -E {e}"));
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(p: &str) -> Notification {
        Notification::Output { pane: p.into(), data: b"hi".to_vec() }
    }

    #[test]
    fn output_is_forwarded_for_both_kinds() {
        let mut f = Flow::default();
        assert_eq!(f.on_notification(out("%1")), vec![Action::Output { pane: "%1".into(), data: b"hi".to_vec() }]);
        let ext = Notification::ExtendedOutput { pane: "%2".into(), age_ms: 5, data: b"x".to_vec() };
        assert_eq!(f.on_notification(ext), vec![Action::Output { pane: "%2".into(), data: b"x".to_vec() }]);
    }

    #[test]
    fn pause_continues_only_visible_panes() {
        let mut f = Flow::default();
        f.set_visible(["%1".to_string()]);
        assert_eq!(f.on_notification(Notification::Pause { pane: "%1".into() }), vec![Action::Continue("%1".into())]);
        assert!(f.on_notification(Notification::Pause { pane: "%2".into() }).is_empty());
    }

    #[test]
    fn paused_pane_resumes_when_it_becomes_visible() {
        let mut f = Flow::default();
        f.on_notification(Notification::Pause { pane: "%2".into() });
        assert!(f.set_visible(["%1".to_string()]).is_empty());
        assert_eq!(f.set_visible(["%2".to_string()]), vec!["%2".to_string()]);
        // only once
        assert!(f.set_visible(["%2".to_string()]).is_empty());
    }

    #[test]
    fn layout_and_exit_notifications() {
        let mut f = Flow::default();
        assert_eq!(f.on_notification(Notification::WindowAdd { window: "@1".into() }), vec![Action::LayoutChanged]);
        assert_eq!(f.on_notification(Notification::Exit { reason: None }), vec![Action::Exit]);
        assert!(f.on_notification(Notification::SessionsChanged).is_empty());
    }

    #[test]
    fn parses_list_panes() {
        let text = "%0\t@0\t0\tzsh\t80\t24\t1\tzsh\n%1\t@0\t0\tzsh\t80\t24\t0\tvim\nbroken line";
        let p = parse_panes(text);
        assert_eq!(p.len(), 2);
        assert_eq!(p[0], PaneInfo { id: "%0".into(), window: "@0".into(), window_index: 0, window_name: "zsh".into(), cols: 80, rows: 24, active: true, command: "zsh".into() });
        assert!(!p[1].active);
        assert_eq!(p[1].command, "vim");
    }

    #[test]
    fn payload_is_base64() {
        assert_eq!(output_payload("%1", b"\x1b[0m\xff").data, "G1swbf8=");
    }

    #[test]
    fn ids_and_capture() {
        assert!(valid_id("%12", '%') && valid_id("@3", '@'));
        assert!(!valid_id("%1;kill-server", '%') && !valid_id("%", '%') && !valid_id("1", '%'));
        assert_eq!(capture_command("%1", -500, None), "capture-pane -p -e -t %1 -S -500");
        assert_eq!(capture_command("%1", -500, Some(-1)), "capture-pane -p -e -t %1 -S -500 -E -1");
    }
}
