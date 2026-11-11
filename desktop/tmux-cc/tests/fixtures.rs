use tmux_cc::{Message, Notification, Parser};

fn parse(raw: &[u8]) -> Vec<Message> {
    let mut p = Parser::new();
    raw.split(|&b| b == b'\n').filter_map(|l| p.feed(l)).collect()
}

fn notes(msgs: &[Message]) -> Vec<&Notification> {
    msgs.iter().filter_map(|m| if let Message::Notification(n) = m { Some(n) } else { None }).collect()
}

#[test]
fn recorded_session() {
    let msgs = parse(include_bytes!("fixtures/session.raw"));
    let n = notes(&msgs);

    // initial attach block (flags 0, empty) comes first
    let Message::Block(first) = &msgs[0] else { panic!("expected block first") };
    assert_eq!((first.flags, first.ok, first.lines.len()), (0, true, 0));

    assert!(n.contains(&&Notification::WindowAdd { window: "@0".into() }));
    assert!(n.contains(&&Notification::SessionChanged { session: "$0".into(), name: "0".into() }));
    assert!(n.contains(&&Notification::SessionsChanged));
    assert!(n.contains(&&Notification::WindowRenamed { window: "@0".into(), name: "seq".into() }));
    assert!(n.contains(&&Notification::WindowClose { window: "@1".into() }));
    assert!(n.contains(&&Notification::WindowPaneChanged { window: "@1".into(), pane: "%2".into() }));
    assert_eq!(n.last(), Some(&&Notification::Exit { reason: None }));

    // %output before pause-after is on, with escapes undone
    let Notification::Output { pane, data } = n.iter().find(|x| matches!(x, Notification::Output { .. })).unwrap() else { unreachable!() };
    assert_eq!(pane, "%0");
    assert!(data.starts_with(b"\x1b[1m\x1b[7m%"));

    // %extended-output afterwards; collect pane %0 bytes and find the printf result
    let mut p0 = Vec::new();
    for x in &n {
        if let Notification::ExtendedOutput { pane, data, .. } = x {
            if pane == "%0" {
                p0.extend_from_slice(data);
            }
        }
    }
    let text = String::from_utf8_lossy(&p0);
    assert!(text.contains("h\u{e9}llo\0"), "{text:?}");
    assert!(text.contains("1\r\n2\r\n3\r\n"));
    assert!(p0.windows(2).any(|w| w == b"\\x"), "escaped backslash became a backslash");

    // layout change with a split
    assert!(n.iter().any(|x| matches!(x, Notification::LayoutChange { window, layout, visible_layout: Some(_), flags: Some(f) }
        if window == "@1" && layout.starts_with("419a,80x24") && f == "*")));

    // command blocks: list-windows ok, bogus -> %error
    let blocks: Vec<_> = msgs.iter().filter_map(|m| if let Message::Block(b) = m { Some(b) } else { None }).collect();
    let lw = blocks.iter().find(|b| b.lines.len() == 2).expect("list-windows block");
    assert!(lw.ok && lw.flags == 1);
    assert!(String::from_utf8_lossy(&lw.lines[0]).starts_with("0: seq"));
    let err = blocks.iter().find(|b| !b.ok).expect("error block");
    assert_eq!(String::from_utf8_lossy(&err.lines[0]), "parse error: unknown command: bogus");
}

#[test]
fn pause_and_continue() {
    let n: Vec<_> = parse(include_bytes!("fixtures/pause.raw"));
    let n = notes(&n);
    assert_eq!(n[0], &Notification::ExtendedOutput { pane: "%0".into(), age_ms: 3000, data: b"\x1b[2Jhi\r\n".to_vec() });
    assert_eq!(n[1], &Notification::Pause { pane: "%0".into() });
    assert_eq!(n[2], &Notification::Continue { pane: "%0".into() });
    assert_eq!(n[3], &Notification::Exit { reason: Some("server exited".into()) });
}

#[test]
fn block_swallows_percent_lines_and_unknown_notifications() {
    let mut p = Parser::new();
    assert!(p.feed(b"%begin 1 7 1").is_none());
    assert!(p.feed(b"%output %0 not-a-notification").is_none());
    assert!(p.feed(b"%end 1 8 1").is_none()); // other number: still data
    let Some(Message::Block(b)) = p.feed(b"%end 1 7 1") else { panic!() };
    assert_eq!(b.lines.len(), 2);
    assert_eq!(
        p.feed(b"%future-thing a b"),
        Some(Message::Notification(Notification::Other { name: "future-thing".into(), args: "a b".into() }))
    );
    assert!(p.feed(b"plain line").is_none());
}
