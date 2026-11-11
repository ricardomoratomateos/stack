//! Pieces of the tmux <-> webview bridge that need no window: flow-control
//! bookkeeping, `list-panes` parsing and event payloads.

use std::collections::{HashMap, HashSet};

use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Serialize;
use tokio::sync::Notify;
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
    /// The tmux session the pane was listed from (filled by the caller).
    pub session: String,
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
                session: String::new(),
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

/// Which connection (tmux session) owns which pane, so commands that only
/// name a pane reach the right one. Pane ids are unique per tmux server, and
/// every connection of the app goes to the same server.
#[derive(Debug, Default)]
pub struct PaneOwners {
    by_pane: HashMap<String, String>,
}

impl PaneOwners {
    /// Replace the panes `session` owns with `panes`.
    pub fn set_session(&mut self, session: &str, panes: impl IntoIterator<Item = String>) {
        self.remove_session(session);
        for p in panes {
            self.by_pane.insert(p, session.to_string());
        }
    }

    pub fn remove_session(&mut self, session: &str) {
        self.by_pane.retain(|_, s| s != session);
    }

    pub fn owner(&self, pane: &str) -> Option<&str> {
        self.by_pane.get(pane).map(String::as_str)
    }

    /// Split the visible panes by owner. Every known session in `sessions`
    /// appears (with an empty list when none of its panes is visible), so a
    /// connection that lost its last visible pane learns about it.
    pub fn partition<'a>(
        &self,
        sessions: impl IntoIterator<Item = &'a str>,
        panes: &[String],
    ) -> HashMap<String, Vec<String>> {
        let mut out: HashMap<String, Vec<String>> = sessions.into_iter().map(|s| (s.to_string(), vec![])).collect();
        for p in panes {
            if let Some(s) = self.owner(p) {
                out.entry(s.to_string()).or_default().push(p.clone());
            }
        }
        out
    }
}

/// One output chunk as sent over the output channel: the pane number (`%12` -> 12) as u32
/// little-endian, then the raw bytes. `None` for an id that is not a pane id.
pub fn output_frame(pane: &str, data: &[u8]) -> Option<Vec<u8>> {
    let n: u32 = pane.strip_prefix('%')?.parse().ok()?;
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&n.to_le_bytes());
    out.extend_from_slice(data);
    Some(out)
}

/// Output bytes sent to the webview and not yet acknowledged (`ack_output`, after xterm parsed them).
/// Sending waits while too many are in flight, which backs up into tmux's pipe instead of memory.
#[derive(Default)]
pub struct Gate {
    in_flight: AtomicUsize,
    notify: Notify,
}

impl Gate {
    pub const LIMIT: usize = 128 * 1024;

    pub fn over(&self) -> bool {
        self.in_flight.load(Ordering::Acquire) >= Self::LIMIT
    }

    /// Resolves once fewer than `LIMIT` bytes are in flight.
    pub async fn wait(&self) {
        loop {
            let notified = self.notify.notified();
            if !self.over() {
                return;
            }
            notified.await;
        }
    }

    pub fn sent(&self, n: usize) {
        self.in_flight.fetch_add(n, Ordering::AcqRel);
    }

    pub fn ack(&self, n: usize) {
        let _ = self.in_flight.try_update(Ordering::AcqRel, Ordering::Acquire, |v| Some(v.saturating_sub(n)));
        self.notify.notify_waiters();
    }

    /// A new subscriber: whatever the old one never acknowledged is gone.
    pub fn reset(&self) {
        self.in_flight.store(0, Ordering::Release);
        self.notify.notify_waiters();
    }
}

/// Output waiting to go to the webview: per pane, in arrival order. Sent in one frame per pane once
/// `MAX_BYTES` are waiting or the oldest has waited `MAX_AGE` (fewer, bigger frames to parse and ack).
#[derive(Default)]
pub struct Coalescer {
    bufs: Vec<(String, Vec<u8>)>,
    total: usize,
    since: Option<std::time::Instant>,
}

impl Coalescer {
    pub const MAX_BYTES: usize = 64 * 1024;
    pub const MAX_AGE: std::time::Duration = std::time::Duration::from_millis(16);

    pub fn push(&mut self, pane: &str, data: &[u8], now: std::time::Instant) {
        self.since.get_or_insert(now);
        self.total += data.len();
        match self.bufs.iter_mut().find(|(p, _)| p == pane) {
            Some((_, b)) => b.extend_from_slice(data),
            None => self.bufs.push((pane.to_string(), data.to_vec())),
        }
    }

    /// Time left before the oldest waiting byte is due (zero when it is, or when full); `None` when empty.
    pub fn remaining(&self, now: std::time::Instant) -> Option<std::time::Duration> {
        let since = self.since?;
        if self.total >= Self::MAX_BYTES {
            return Some(std::time::Duration::ZERO);
        }
        Some(Self::MAX_AGE.saturating_sub(now.saturating_duration_since(since)))
    }

    pub fn take(&mut self) -> Vec<(String, Vec<u8>)> {
        self.total = 0;
        self.since = None;
        std::mem::take(&mut self.bufs)
    }
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
        assert_eq!(p[0], PaneInfo { id: "%0".into(), session: String::new(), window: "@0".into(), window_index: 0, window_name: "zsh".into(), cols: 80, rows: 24, active: true, command: "zsh".into() });
        assert!(!p[1].active);
        assert_eq!(p[1].command, "vim");
    }

    #[test]
    fn owners_route_panes_to_their_session() {
        let mut o = PaneOwners::default();
        o.set_session("stack-a", ["%1".to_string(), "%2".to_string()]);
        o.set_session("stack-b", ["%3".to_string()]);
        assert_eq!(o.owner("%2"), Some("stack-a"));
        assert_eq!(o.owner("%3"), Some("stack-b"));
        assert_eq!(o.owner("%9"), None);
        // re-listing a session replaces its panes
        o.set_session("stack-a", ["%4".to_string()]);
        assert_eq!(o.owner("%1"), None);
        assert_eq!(o.owner("%4"), Some("stack-a"));
        o.remove_session("stack-b");
        assert_eq!(o.owner("%3"), None);
    }

    #[test]
    fn visible_panes_are_partitioned_per_connection() {
        let mut o = PaneOwners::default();
        o.set_session("a", ["%1".to_string(), "%2".to_string()]);
        o.set_session("b", ["%3".to_string()]);
        let p = o.partition(["a", "b", "c"], &["%1".to_string(), "%3".to_string(), "%99".to_string()]);
        assert_eq!(p["a"], vec!["%1".to_string()]);
        assert_eq!(p["b"], vec!["%3".to_string()]);
        assert!(p["c"].is_empty());
        assert_eq!(p.len(), 3);
    }

    #[test]
    fn gate_counts_in_flight_bytes() {
        let g = Gate::default();
        g.sent(Gate::LIMIT);
        assert!(g.over());
        g.ack(10);
        assert!(!g.over());
        g.ack(usize::MAX);
        g.sent(1);
        g.reset();
        assert!(!g.over());
    }

    #[test]
    fn coalescer_joins_per_pane_and_is_due_after_16ms_or_64k() {
        use std::time::{Duration, Instant};
        let t0 = Instant::now();
        let mut c = Coalescer::default();
        assert!(c.remaining(t0).is_none());
        c.push("%1", b"ab", t0);
        c.push("%2", b"x", t0);
        c.push("%1", b"cd", t0 + Duration::from_millis(5));
        assert_eq!(c.remaining(t0 + Duration::from_millis(5)), Some(Duration::from_millis(11)));
        assert_eq!(c.remaining(t0 + Duration::from_millis(30)), Some(Duration::ZERO));
        assert_eq!(c.take(), vec![("%1".to_string(), b"abcd".to_vec()), ("%2".to_string(), b"x".to_vec())]);
        assert!(c.remaining(t0).is_none());
        c.push("%1", &vec![0; Coalescer::MAX_BYTES], t0);
        assert_eq!(c.remaining(t0), Some(Duration::ZERO));
    }

    #[test]
    fn frame_is_pane_number_then_raw_bytes() {
        assert_eq!(output_frame("%258", b"\x1b[0m\xff").unwrap(), [2, 1, 0, 0, 0x1b, b'[', b'0', b'm', 0xff]);
        assert_eq!(output_frame("%1", b"").unwrap(), [1, 0, 0, 0]);
        assert!(output_frame("1", b"x").is_none() && output_frame("%x", b"x").is_none());
    }

    #[test]
    fn ids_and_capture() {
        assert!(valid_id("%12", '%') && valid_id("@3", '@'));
        assert!(!valid_id("%1;kill-server", '%') && !valid_id("%", '%') && !valid_id("1", '%'));
        assert_eq!(capture_command("%1", -500, None), "capture-pane -p -e -t %1 -S -500");
        assert_eq!(capture_command("%1", -500, Some(-1)), "capture-pane -p -e -t %1 -S -500 -E -1");
    }
}
