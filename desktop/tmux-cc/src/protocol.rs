//! Control-mode line protocol.
//!
//! Every line tmux writes is either a notification (`%output %0 ...`) or part
//! of a command reply block:
//!
//! ```text
//! %begin <time> <number> <flags>
//! ...free-form lines...
//! %end|%error <time> <number> <flags>
//! ```
//!
//! Pane data is arbitrary bytes, so everything here works on `&[u8]`.

/// A parsed notification. Ids keep their sigil (`%0`, `@1`, `$2`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notification {
    /// `%output %pane data` (data already unescaped).
    Output { pane: String, data: Vec<u8> },
    /// `%extended-output %pane age : data`, sent once `pause-after` is on.
    ExtendedOutput { pane: String, age_ms: u64, data: Vec<u8> },
    WindowAdd { window: String },
    /// `%window-close` and `%unlinked-window-close`.
    WindowClose { window: String },
    WindowRenamed { window: String, name: String },
    WindowPaneChanged { window: String, pane: String },
    LayoutChange { window: String, layout: String, visible_layout: Option<String>, flags: Option<String> },
    SessionChanged { session: String, name: String },
    SessionRenamed { name: String },
    SessionsChanged,
    SessionWindowChanged { session: String, window: String },
    Pause { pane: String },
    Continue { pane: String },
    Exit { reason: Option<String> },
    /// Any other `%name args` line (forward compatibility).
    Other { name: String, args: String },
}

/// A finished command reply block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub time: u64,
    pub number: u64,
    /// `0` for blocks tmux produces itself (the initial attach), `1` for
    /// replies to commands this client sent.
    pub flags: u32,
    /// `true` for `%end`, `false` for `%error`.
    pub ok: bool,
    pub lines: Vec<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Message {
    Notification(Notification),
    Block(Block),
}

#[derive(Debug)]
struct Open {
    time: u64,
    number: u64,
    flags: u32,
    lines: Vec<Vec<u8>>,
}

/// Line-by-line state machine. Inside a block every line is data until the
/// matching `%end`/`%error`, even if it starts with `%`.
#[derive(Debug, Default)]
pub struct Parser {
    open: Option<Open>,
}

impl Parser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one line (without its trailing `\n`). Returns a message when the
    /// line completes one; lines inside an open block and lines that are not
    /// control-mode output yield `None`.
    pub fn feed(&mut self, line: &[u8]) -> Option<Message> {
        if let Some(open) = self.open.as_mut() {
            if let Some((ok, number)) = block_end(line) {
                if number == open.number {
                    let open = self.open.take()?;
                    return Some(Message::Block(Block {
                        time: open.time,
                        number: open.number,
                        flags: open.flags,
                        ok,
                        lines: open.lines,
                    }));
                }
            }
            open.lines.push(line.to_vec());
            return None;
        }
        if let Some(rest) = line.strip_prefix(b"%begin ") {
            let mut it = std::str::from_utf8(rest).ok()?.split(' ');
            let time = it.next()?.parse().ok()?;
            let number = it.next()?.parse().ok()?;
            let flags = it.next().and_then(|f| f.parse().ok()).unwrap_or(0);
            self.open = Some(Open { time, number, flags, lines: Vec::new() });
            return None;
        }
        parse_notification(line).map(Message::Notification)
    }
}

fn block_end(line: &[u8]) -> Option<(bool, u64)> {
    let (ok, rest) = if let Some(r) = line.strip_prefix(b"%end ") {
        (true, r)
    } else {
        (false, line.strip_prefix(b"%error ")?)
    };
    let number = std::str::from_utf8(rest).ok()?.split(' ').nth(1)?.parse().ok()?;
    Some((ok, number))
}

/// Parse a notification line; `None` if it is not one (no leading `%`).
pub fn parse_notification(line: &[u8]) -> Option<Notification> {
    let line = line.strip_prefix(b"%")?;
    let (name, rest) = match line.iter().position(|&b| b == b' ') {
        Some(i) => (&line[..i], &line[i + 1..]),
        None => (line, &b""[..]),
    };
    let name = std::str::from_utf8(name).ok()?;
    let s = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
    let text = s(rest);
    let word = |i: usize| text.split(' ').nth(i).unwrap_or("").to_string();
    let after = |n: usize| text.splitn(n + 1, ' ').nth(n).unwrap_or("").to_string();
    Some(match name {
        "output" => {
            let sp = rest.iter().position(|&b| b == b' ')?;
            Notification::Output { pane: s(&rest[..sp]), data: unescape(&rest[sp + 1..]) }
        }
        "extended-output" => {
            let mut parts = rest.splitn(3, |&b| b == b' ');
            let pane = s(parts.next()?);
            let age_ms = s(parts.next()?).parse().ok()?;
            let tail = parts.next().unwrap_or(b"");
            let data = tail.strip_prefix(b": ").or_else(|| tail.strip_prefix(b":")).unwrap_or(tail);
            Notification::ExtendedOutput { pane, age_ms, data: unescape(data) }
        }
        "window-add" => Notification::WindowAdd { window: word(0) },
        "window-close" | "unlinked-window-close" => Notification::WindowClose { window: word(0) },
        "window-renamed" => Notification::WindowRenamed { window: word(0), name: after(1) },
        "window-pane-changed" => Notification::WindowPaneChanged { window: word(0), pane: word(1) },
        "layout-change" => {
            let opt = |i: usize| text.split(' ').nth(i).map(str::to_string);
            Notification::LayoutChange { window: word(0), layout: word(1), visible_layout: opt(2), flags: opt(3) }
        }
        "session-changed" => Notification::SessionChanged { session: word(0), name: after(1) },
        "session-renamed" => Notification::SessionRenamed { name: text },
        "sessions-changed" => Notification::SessionsChanged,
        "session-window-changed" => Notification::SessionWindowChanged { session: word(0), window: word(1) },
        "pause" => Notification::Pause { pane: word(0) },
        "continue" => Notification::Continue { pane: word(0) },
        "exit" => Notification::Exit { reason: (!text.is_empty()).then_some(text) },
        _ => Notification::Other { name: name.to_string(), args: text },
    })
}

/// Undo tmux's escaping: bytes below 0x20 and `\` arrive as `\ooo` (octal).
/// Anything that is not a well-formed `\ooo` is kept literally.
pub fn unescape(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\\' && i + 3 < data.len() && data[i + 1..i + 4].iter().all(|d| (b'0'..=b'7').contains(d)) {
            let v = (data[i + 1] - b'0') as u32 * 64 + (data[i + 2] - b'0') as u32 * 8 + (data[i + 3] - b'0') as u32;
            out.push((v & 0xff) as u8);
            i += 4;
        } else {
            out.push(data[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unescape_octal() {
        assert_eq!(unescape(br"a\033[1mb\134\015\012"), b"a\x1b[1mb\\\r\n");
        assert_eq!(unescape(br"\000"), vec![0]);
        assert_eq!(unescape(br"\12"), br"\12");
        assert_eq!(unescape(br"\189"), br"\189");
        assert_eq!(unescape(br"end\033"), b"end\x1b");
    }
}
