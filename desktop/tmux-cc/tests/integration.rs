//! Against a real, isolated tmux server (`tmux -L <unique socket>`).
use std::time::Duration;

use tmux_cc::{Client, Config, Event, Mode, Notification};
use tokio::sync::mpsc::UnboundedReceiver;

struct Server(String);

impl Server {
    fn new(tag: &str) -> Self {
        Server(format!("tmuxcc-{tag}-{}", std::process::id()))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = std::process::Command::new("tmux").args(["-L", &self.0, "kill-server"]).output();
        let uid = unsafe_uid();
        let _ = std::fs::remove_file(format!("/tmp/tmux-{uid}/{}", self.0));
    }
}

fn unsafe_uid() -> String {
    let out = std::process::Command::new("id").arg("-u").output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn have_tmux() -> bool {
    std::process::Command::new("tmux").arg("-V").output().is_ok()
}

async fn collect_until(rx: &mut UnboundedReceiver<Event>, pane: &str, needle: &str) -> String {
    let mut acc = Vec::new();
    let res = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(ev) = rx.recv().await {
            if let Event::Notification(Notification::Output { pane: p, data } | Notification::ExtendedOutput { pane: p, data, .. }) = ev {
                if p == pane {
                    acc.extend_from_slice(&data);
                    if String::from_utf8_lossy(&acc).contains(needle) {
                        return;
                    }
                }
            }
        }
    })
    .await;
    let s = String::from_utf8_lossy(&acc).into_owned();
    assert!(res.is_ok(), "timed out waiting for {needle:?}; got {s:?}");
    s
}

#[tokio::test]
async fn command_and_output_roundtrip() {
    if !have_tmux() {
        eprintln!("tmux not installed, skipping");
        return;
    }
    let srv = Server::new("rt");
    let mut cfg = Config::new(
        Some(&srv.0),
        Mode::NewSession { name: Some("t".into()), cwd: Some("/tmp".into()), size: Some((80, 24)), attach_if_exists: false },
    );
    cfg.pause_after = Some(30);
    let (client, mut rx) = Client::connect(cfg).await.unwrap();

    // command reply
    let out = client.run("list-panes -a -F '#{pane_id} #{session_name}'").await.unwrap();
    assert_eq!(out, "%0 t");
    // %error becomes Err through run(), and ok=false through command()
    let bad = client.command("no-such-command").await.unwrap();
    assert!(!bad.ok);
    assert!(client.run("no-such-command").await.is_err());
    // single-line only
    assert!(client.command("a\nb").await.is_err());

    // output from a pane (extended-output, since pause-after is on)
    client.run("send-keys -t %0 'echo marker-$((40+2))' Enter").await.unwrap();
    collect_until(&mut rx, "%0", "marker-42").await;

    // keystrokes through send-keys -H
    client.send_bytes("%0", b"echo hex-$((1+2))\r").await.unwrap();
    collect_until(&mut rx, "%0", "hex-3").await;

    client.resize(100, 30).await.unwrap();
    client.continue_pane("%0").await.unwrap();

    // a second client attaches to the same session
    let (second, _rx2) = Client::connect(Config::new(Some(&srv.0), Mode::Attach { target: "t".into() })).await.unwrap();
    assert_eq!(second.run("display-message -p '#{session_name}'").await.unwrap(), "t");
    second.detach().await.unwrap();

    // killing the server closes the stream
    let _ = client.command("kill-server").await;
    let closed = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(ev) = rx.recv().await {
            if matches!(ev, Event::Closed { .. }) {
                return true;
            }
        }
        false
    })
    .await;
    assert_eq!(closed, Ok(true));
}
