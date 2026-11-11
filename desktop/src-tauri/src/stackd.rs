//! Client of stackd's local API: HTTP over a Unix socket (`GET /state`, SSE
//! `GET /events`, `POST /commands/<name>`; see src/daemon/api.ts).
//!
//! Requests are HTTP/1.0 with `Connection: close`: the answer is then neither
//! chunked nor kept alive, so the body is just "read to EOF", and an SSE
//! stream is plain lines. This client never starts stackd.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

/// `$STACKD_CONFIG_DIR/stackd.sock`, else `~/.config/stack/stackd.sock`.
pub fn socket_path() -> PathBuf {
    let dir = std::env::var_os("STACKD_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config").join("stack")))
        .unwrap_or_else(|| PathBuf::from(".config/stack"));
    dir.join("stackd.sock")
}

fn head(method: &str, route: &str, body: Option<&[u8]>) -> Vec<u8> {
    let mut h = format!("{method} {route} HTTP/1.0\r\nHost: stackd\r\nConnection: close\r\n");
    if let Some(b) = body {
        h.push_str(&format!("Content-Type: application/json\r\nContent-Length: {}\r\n", b.len()));
    }
    h.push_str("\r\n");
    let mut out = h.into_bytes();
    if let Some(b) = body {
        out.extend_from_slice(b);
    }
    out
}

fn status_of(line: &str) -> Option<u16> {
    line.split_whitespace().nth(1)?.parse().ok()
}

/// One request; `Ok(result)` of the `{ok: true, result}` answer, `Err` with the daemon's message otherwise.
pub async fn request(sock: &Path, method: &str, route: &str, body: Option<&Value>) -> Result<Value, String> {
    let mut stream = UnixStream::connect(sock).await.map_err(|e| format!("cannot reach stackd at {}: {e}", sock.display()))?;
    let payload = body.map(|b| b.to_string().into_bytes());
    stream.write_all(&head(method, route, payload.as_deref())).await.map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (headers, body) = text.split_once("\r\n\r\n").ok_or("unreadable answer from stackd")?;
    let status = status_of(headers.lines().next().unwrap_or("")).unwrap_or(0);
    let answer: Value = serde_json::from_str(body).map_err(|_| format!("unreadable answer from stackd (HTTP {status})"))?;
    if answer.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(answer.get("error").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("HTTP {status}")))
    }
}

/// Incremental parser of an SSE stream, line by line.
#[derive(Debug, Default)]
pub struct SseParser {
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    /// Feed one line (without its newline); returns `(event, data)` when a blank line completes an event.
    pub fn push(&mut self, line: &str) -> Option<(String, String)> {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            let data = std::mem::take(&mut self.data);
            let event = self.event.take();
            if data.is_empty() {
                return None;
            }
            return Some((event.unwrap_or_else(|| "message".into()), data.join("\n")));
        }
        if line.starts_with(':') {
            return None; // comment / keep-alive
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }
}

/// Connects to `GET /events` and calls `on_event` for each SSE event until the stream ends.
pub async fn stream_events(sock: &Path, mut on_event: impl FnMut(String, String)) -> Result<(), String> {
    let stream = UnixStream::connect(sock).await.map_err(|e| e.to_string())?;
    let (r, mut w) = stream.into_split();
    w.write_all(&head("GET", "/events", None)).await.map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(r).lines();
    let status = lines.next_line().await.map_err(|e| e.to_string())?.unwrap_or_default();
    if status_of(&status) != Some(200) {
        return Err(format!("stackd answered {status:?}"));
    }
    while let Some(l) = lines.next_line().await.map_err(|e| e.to_string())? {
        if l.trim().is_empty() {
            break; // end of headers
        }
    }
    let mut parser = SseParser::default();
    while let Some(l) = lines.next_line().await.map_err(|e| e.to_string())? {
        if let Some((event, data)) = parser.push(&l) {
            on_event(event, data);
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq)]
pub enum Update {
    /// stackd became reachable / unreachable.
    Status(bool),
    /// A new snapshot.
    State(Value),
}

/// Follows stackd forever: while the socket answers, forwards its snapshots; otherwise reports "not running" and retries.
pub async fn watch(sock: PathBuf, retry: Duration, sink: impl Fn(Update)) {
    let mut known: Option<bool> = None;
    let mut report = |running: bool, sink: &dyn Fn(Update)| {
        if known != Some(running) {
            known = Some(running);
            sink(Update::Status(running));
        }
    };
    loop {
        if sock.exists() {
            let mut connected = false;
            let _ = stream_events(&sock, |event, data| {
                if event != "state" {
                    return;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&data) {
                    if !connected {
                        connected = true;
                        report(true, &sink);
                    }
                    sink(Update::State(v));
                }
            })
            .await;
        }
        report(false, &sink);
        tokio::time::sleep(retry).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::net::UnixListener;

    fn temp_sock(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stackd-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("stackd.sock")
    }

    /// Reads the request head (and body) and returns it as text.
    async fn read_request(s: &mut UnixStream) -> String {
        let mut buf = vec![0u8; 4096];
        let n = s.read(&mut buf).await.unwrap();
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }

    #[test]
    fn sse_parser_assembles_events() {
        let mut p = SseParser::default();
        assert_eq!(p.push(": keep-alive"), None);
        assert_eq!(p.push(""), None);
        assert_eq!(p.push("event: state"), None);
        assert_eq!(p.push("data: {\"a\":1}"), None);
        assert_eq!(p.push(""), Some(("state".into(), "{\"a\":1}".into())));
        assert_eq!(p.push("data: x"), None);
        assert_eq!(p.push("data: y\r"), None);
        assert_eq!(p.push("\r"), Some(("message".into(), "x\ny".into())));
    }

    #[tokio::test]
    async fn request_unwraps_results_and_errors() {
        let sock = temp_sock("req");
        let listener = UnixListener::bind(&sock).unwrap();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let req = read_request(&mut s).await;
            assert!(req.starts_with("POST /commands/createTask HTTP/1.0"));
            assert!(req.contains("\"branch\":\"x\""));
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"result\":{\"id\":7}}").await.unwrap();
            drop(s);
            let (mut s, _) = listener.accept().await.unwrap();
            read_request(&mut s).await;
            s.write_all(b"HTTP/1.1 409 Conflict\r\n\r\n{\"ok\":false,\"error\":\"no session yet\"}").await.unwrap();
        });
        let ok = request(&sock, "POST", "/commands/createTask", Some(&serde_json::json!({"branch": "x"}))).await.unwrap();
        assert_eq!(ok["id"], 7);
        let bad = request(&sock, "GET", "/state", None).await.unwrap_err();
        assert_eq!(bad, "no session yet");
        server.await.unwrap();
        std::fs::remove_dir_all(sock.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn request_reports_a_missing_socket() {
        let sock = temp_sock("none");
        let e = request(&sock, "GET", "/state", None).await.unwrap_err();
        assert!(e.contains("cannot reach stackd"), "{e}");
        std::fs::remove_dir_all(sock.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn watch_follows_the_stream_and_reports_down() {
        let sock = temp_sock("watch");
        let listener = UnixListener::bind(&sock).unwrap();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let req = read_request(&mut s).await;
            assert!(req.starts_with("GET /events"));
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n").await.unwrap();
            s.write_all(b"event: state\ndata: {\"seq\":1}\n\n: keep-alive\n\nevent: state\ndata: {\"seq\":2}\n\n").await.unwrap();
            // closing the stream = stackd went away
        });
        let seen: Arc<Mutex<Vec<Update>>> = Arc::default();
        let sink_seen = seen.clone();
        let task = tokio::spawn(watch(sock.clone(), Duration::from_millis(20), move |u| sink_seen.lock().unwrap().push(u)));
        tokio::time::sleep(Duration::from_millis(300)).await;
        task.abort();
        let got = seen.lock().unwrap().clone();
        assert_eq!(
            got,
            vec![
                Update::Status(true),
                Update::State(serde_json::json!({"seq": 1})),
                Update::State(serde_json::json!({"seq": 2})),
                Update::Status(false),
            ]
        );
        std::fs::remove_dir_all(sock.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn watch_without_a_socket_says_down_once() {
        let sock = temp_sock("absent");
        let seen: Arc<Mutex<Vec<Update>>> = Arc::default();
        let sink_seen = seen.clone();
        let task = tokio::spawn(watch(sock.clone(), Duration::from_millis(10), move |u| sink_seen.lock().unwrap().push(u)));
        tokio::time::sleep(Duration::from_millis(100)).await;
        task.abort();
        assert_eq!(*seen.lock().unwrap(), vec![Update::Status(false)]);
        std::fs::remove_dir_all(sock.parent().unwrap()).unwrap();
    }

    /// Against a real stackd: `STACKD_CONFIG_DIR=… cargo test live -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn live_stackd() {
        let sock = socket_path();
        let state = request(&sock, "GET", "/state", None).await.unwrap();
        assert!(state["repos"].is_array());
        let mut got = None;
        let _ = tokio::time::timeout(Duration::from_secs(2), stream_events(&sock, |e, d| {
            if got.is_none() {
                got = Some((e, d));
            }
        }))
        .await;
        let (event, data) = got.expect("an SSE event");
        assert_eq!(event, "state");
        assert!(serde_json::from_str::<Value>(&data).unwrap()["repos"].is_array());
        let err = request(&sock, "POST", "/commands/attachTarget", Some(&serde_json::json!({"worktreeId": "nope"}))).await.unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }
}
