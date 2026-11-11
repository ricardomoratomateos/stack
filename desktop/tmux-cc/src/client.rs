//! Async tmux control-mode client.
//!
//! Spawns `tmux [-L socket] -C new-session|attach-session`, parses the
//! output with [`Parser`], answers [`Client::command`] calls from the reply
//! blocks (tmux answers in order) and forwards everything else as [`Event`]s.
//!
//! `-C` rather than `-CC`: `-CC` calls `tcgetattr` on stdin and refuses to run
//! without a tty; the protocol is the same minus the DCS wrapper.

use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::protocol::{Message, Notification, Parser};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to spawn tmux: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("io error talking to tmux: {0}")]
    Io(#[from] std::io::Error),
    #[error("tmux control connection closed")]
    Closed,
    #[error("command must be a single line")]
    InvalidCommand,
    #[error("tmux: {0}")]
    Command(String),
}

/// How to start the control client.
#[derive(Debug, Clone)]
pub enum Mode {
    /// `new-session` (`-A` makes it attach when the name exists).
    NewSession { name: Option<String>, cwd: Option<String>, size: Option<(u16, u16)>, attach_if_exists: bool },
    /// `attach-session -t <target>`.
    Attach { target: String },
}

#[derive(Debug, Clone)]
pub struct Config {
    pub tmux_bin: String,
    /// `-L <socket>`; `None` is the default server (avoid in tests).
    pub socket: Option<String>,
    pub mode: Mode,
    /// Enable `refresh-client -f pause-after=N` right after connecting.
    pub pause_after: Option<u32>,
}

impl Config {
    pub fn new(socket: Option<&str>, mode: Mode) -> Self {
        Self { tmux_bin: "tmux".into(), socket: socket.map(Into::into), mode, pause_after: None }
    }

    fn args(&self) -> Vec<String> {
        let mut a = Vec::new();
        if let Some(s) = &self.socket {
            a.extend(["-L".to_string(), s.clone()]);
        }
        // -u: UTF-8 even when launched without a UTF-8 locale (apps opened from Finder have none).
        a.push("-u".into());
        a.push("-C".into());
        match &self.mode {
            Mode::Attach { target } => a.extend(["attach-session".into(), "-t".into(), target.clone()]),
            Mode::NewSession { name, cwd, size, attach_if_exists } => {
                a.push("new-session".into());
                if *attach_if_exists {
                    a.push("-A".into());
                }
                if let Some(n) = name {
                    a.extend(["-s".into(), n.clone()]);
                }
                if let Some(c) = cwd {
                    a.extend(["-c".into(), c.clone()]);
                }
                if let Some((x, y)) = size {
                    a.extend(["-x".into(), x.to_string(), "-y".into(), y.to_string()]);
                }
            }
        }
        a
    }
}

/// Something the stream of a connection produces besides command replies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Notification(Notification),
    /// tmux exited (after any `%exit`). `stderr` holds what it printed.
    Closed { code: Option<i32>, stderr: String },
}

/// The answer to a command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub ok: bool,
    pub lines: Vec<Vec<u8>>,
}

impl Reply {
    pub fn text(&self) -> String {
        self.lines.iter().map(|l| String::from_utf8_lossy(l)).collect::<Vec<_>>().join("\n")
    }

    /// The reply text, or [`Error::Command`] for `%error`.
    pub fn into_text(self) -> Result<String, Error> {
        if self.ok {
            Ok(self.text())
        } else {
            Err(Error::Command(self.text()))
        }
    }
}

type Waiters = Arc<StdMutex<VecDeque<oneshot::Sender<Reply>>>>;

struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    waiters: Waiters,
    _child: StdMutex<Child>,
}

/// Events buffered before the reader waits for the consumer (which makes tmux wait on its pipe).
const EVENT_QUEUE: usize = 256;

/// Handle to a control connection; cheap to clone. The tmux client process is
/// killed when the last handle is dropped (the server and its sessions live on).
#[derive(Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

impl Client {
    /// Spawn tmux and return the handle plus its event stream.
    pub async fn connect(config: Config) -> Result<(Client, mpsc::Receiver<Event>), Error> {
        let mut child = Command::new(&config.tmux_bin)
            .args(config.args())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(Error::Spawn)?;
        let stdin = child.stdin.take().ok_or(Error::Closed)?;
        let stdout = child.stdout.take().ok_or(Error::Closed)?;
        let mut stderr = child.stderr.take().ok_or(Error::Closed)?;

        let waiters: Waiters = Arc::new(StdMutex::new(VecDeque::new()));
        let inner = Arc::new(Inner { stdin: Mutex::new(Some(stdin)), waiters: waiters.clone(), _child: StdMutex::new(child) });
        let (tx, rx) = mpsc::channel(EVENT_QUEUE);

        let weak = Arc::downgrade(&inner);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut parser = Parser::new();
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                match parser.feed(&buf) {
                    Some(Message::Notification(n)) => {
                        // if nobody listens any more, keep draining so commands still get their replies
                        let _ = tx.send(Event::Notification(n)).await;
                    }
                    // flags 0: tmux's own block (the attach), not an answer to us.
                    Some(Message::Block(b)) if b.flags != 0 => {
                        let w = waiters.lock().unwrap().pop_front();
                        if let Some(w) = w {
                            let _ = w.send(Reply { ok: b.ok, lines: b.lines });
                        }
                    }
                    _ => {}
                }
            }
            // Dropping the senders fails every pending command with `Closed`.
            waiters.lock().unwrap().clear();
            let mut err = String::new();
            let _ = stderr.read_to_string(&mut err).await;
            let code = match weak.upgrade() {
                Some(inner) => {
                    inner.stdin.lock().await.take();
                    let child = &mut *inner._child.lock().unwrap();
                    child.try_wait().ok().flatten().and_then(|s| s.code())
                }
                None => None,
            };
            let _ = tx.send(Event::Closed { code, stderr: err.trim().to_string() }).await;
        });

        let client = Client { inner };
        if let Some(n) = config.pause_after {
            client.set_pause_after(n).await?.into_text()?;
        }
        Ok((client, rx))
    }

    /// Send one tmux command and wait for its reply block.
    pub async fn command(&self, cmd: &str) -> Result<Reply, Error> {
        if cmd.contains('\n') || cmd.contains('\r') {
            return Err(Error::InvalidCommand);
        }
        let (tx, rx) = oneshot::channel();
        {
            // Queue the waiter and write under one lock so replies, which tmux
            // sends in order, pair up with their commands.
            let mut guard = self.inner.stdin.lock().await;
            let stdin = guard.as_mut().ok_or(Error::Closed)?;
            self.inner.waiters.lock().unwrap().push_back(tx);
            let mut line = cmd.as_bytes().to_vec();
            line.push(b'\n');
            if let Err(e) = stdin.write_all(&line).await {
                self.inner.waiters.lock().unwrap().pop_back();
                return Err(e.into());
            }
            stdin.flush().await?;
        }
        rx.await.map_err(|_| Error::Closed)
    }

    /// Like [`command`](Self::command) but `%error` becomes `Err`.
    pub async fn run(&self, cmd: &str) -> Result<String, Error> {
        self.command(cmd).await?.into_text()
    }

    /// `refresh-client -f pause-after=<secs>`: tmux then pauses a pane whose
    /// output is older than this, sending `%pause` instead of more output.
    pub async fn set_pause_after(&self, secs: u32) -> Result<Reply, Error> {
        self.command(&format!("refresh-client -f pause-after={secs}")).await
    }

    /// Resume a pane after `%pause`.
    pub async fn continue_pane(&self, pane: &str) -> Result<Reply, Error> {
        self.command(&format!("refresh-client -A {}", quote(&format!("{pane}:continue")))).await
    }

    /// `refresh-client -C cols,rows`: the size this client wants.
    pub async fn resize(&self, cols: u16, rows: u16) -> Result<Reply, Error> {
        self.command(&format!("refresh-client -C {cols},{rows}")).await
    }

    /// Send raw bytes to a pane as `send-keys -H` (hex), keystrokes verbatim.
    pub async fn send_bytes(&self, pane: &str, bytes: &[u8]) -> Result<Reply, Error> {
        if bytes.is_empty() {
            return Ok(Reply { ok: true, lines: vec![] });
        }
        let hex: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
        self.command(&format!("send-keys -t {} -H {}", quote(pane), hex.join(" "))).await
    }

    /// Detach cleanly (an empty line ends a control client) and wait briefly
    /// for the connection to wind down.
    pub async fn detach(&self) -> Result<(), Error> {
        let mut guard = self.inner.stdin.lock().await;
        if let Some(mut stdin) = guard.take() {
            stdin.write_all(b"\n").await?;
            stdin.flush().await?;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        Ok(())
    }
}

/// Single-quote for the tmux command parser.
pub fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}
