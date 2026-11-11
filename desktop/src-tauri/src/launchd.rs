//! Running stackd outside a terminal: the user's node, the launchd user agent
//! (`~/Library/LaunchAgents/dev.stack.stackd.plist`) and a one-off detached start.
//!
//! Nothing here runs by itself: the app calls it only when the user asks (the "Start stackd at
//! login" setting, "Start stackd now"). Every side effect goes through an injected `Runner` or an
//! explicit path, so the tests use a temp HOME and never call `launchctl`.

use std::path::{Path, PathBuf};
use std::process::Command;

pub const LABEL: &str = "dev.stack.stackd";

/// Runs an external program; injected so tests never touch launchd.
pub trait Runner {
    fn run(&self, program: &str, args: &[String]) -> Result<String, String>;
}

pub struct RealRunner;

impl Runner for RealRunner {
    fn run(&self, program: &str, args: &[String]) -> Result<String, String> {
        let out = Command::new(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(format!("{program} {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
        }
    }
}

pub fn plist_path(home: &Path) -> PathBuf {
    home.join("Library").join("LaunchAgents").join(format!("{LABEL}.plist"))
}

/// `~/.config/stack` (or `STACKD_CONFIG_DIR`), where stackd keeps its socket and log.
pub fn config_dir(home: &Path) -> PathBuf {
    std::env::var_os("STACKD_CONFIG_DIR").map(PathBuf::from).unwrap_or_else(|| home.join(".config").join("stack"))
}

pub fn log_path(home: &Path) -> PathBuf {
    config_dir(home).join("stackd.log")
}

pub fn is_installed(home: &Path) -> bool {
    plist_path(home).exists()
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Where and how the agent runs.
#[derive(Debug, Clone)]
pub struct Setup {
    pub home: PathBuf,
    pub node: PathBuf,
    pub script: PathBuf,
    /// The login shell's PATH: launchd's own is bare, and stackd needs tmux, git and the agents' CLIs.
    pub path_env: String,
    pub uid: u32,
}

/// RunAtLoad; KeepAlive only after a crash (a clean exit, e.g. losing the socket race, stays down).
pub fn render_plist(s: &Setup) -> String {
    let log = xml(&log_path(&s.home).display().to_string());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{node}</string>
    <string>{script}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>{path}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"#,
        node = xml(&s.node.display().to_string()),
        script = xml(&s.script.display().to_string()),
        path = xml(&s.path_env),
    )
}

fn domain(uid: u32) -> String {
    format!("gui/{uid}")
}

/// Writes the plist and loads it (`launchctl bootstrap`, after a `bootout` of any older copy).
pub fn enable(runner: &dyn Runner, s: &Setup) -> Result<(), String> {
    let plist = plist_path(&s.home);
    std::fs::create_dir_all(plist.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(config_dir(&s.home)).map_err(|e| e.to_string())?;
    std::fs::write(&plist, render_plist(s)).map_err(|e| e.to_string())?;
    let _ = runner.run("launchctl", &["bootout".into(), format!("{}/{LABEL}", domain(s.uid))]);
    runner.run("launchctl", &["bootstrap".into(), domain(s.uid), plist.display().to_string()]).map(|_| ())
}

/// Unloads the agent and removes the plist (the running daemon is stopped by `bootout`).
pub fn disable(runner: &dyn Runner, home: &Path, uid: u32) -> Result<(), String> {
    let _ = runner.run("launchctl", &["bootout".into(), format!("{}/{LABEL}", domain(uid))]);
    match std::fs::remove_file(plist_path(home)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ── the user's node ───────────────────────────────────────────────────────

/// What the login shell reported.
#[derive(Debug, Default, PartialEq)]
pub struct ShellProbe {
    pub node: Option<PathBuf>,
    pub path: Option<String>,
}

/// Parses the output of `$SHELL -lic 'echo __N__$(command -v node); echo __P__$PATH'`; rc files may print noise before.
pub fn parse_probe(out: &str) -> ShellProbe {
    let mut p = ShellProbe::default();
    for line in out.lines() {
        if let Some(v) = line.strip_prefix("__N__") {
            if v.starts_with('/') {
                p.node = Some(PathBuf::from(v.trim()));
            }
        } else if let Some(v) = line.strip_prefix("__P__") {
            if !v.trim().is_empty() {
                p.path = Some(v.trim().to_string());
            }
        }
    }
    p
}

pub fn probe_login_shell(runner: &dyn Runner) -> ShellProbe {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let cmd = "echo __N__$(command -v node); echo __P__$PATH";
    runner.run(&shell, &["-lic".into(), cmd.into()]).map(|o| parse_probe(&o)).unwrap_or_default()
}

fn version_key(name: &str) -> Vec<u64> {
    name.trim_start_matches('v').split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

/// The node to run stackd with, first match wins: `STACK_NODE`, the login shell's `node`,
/// the newest `~/.nvm/versions/node/*`, Homebrew (`/opt/homebrew`, `/usr/local`).
pub fn resolve_node(
    home: &Path,
    env_node: Option<PathBuf>,
    probe: &ShellProbe,
    exists: &dyn Fn(&Path) -> bool,
    list: &dyn Fn(&Path) -> Vec<String>,
) -> Option<PathBuf> {
    if let Some(n) = env_node.filter(|n| exists(n)) {
        return Some(n);
    }
    if let Some(n) = probe.node.as_ref().filter(|n| exists(n)) {
        return Some(n.clone());
    }
    let nvm = home.join(".nvm").join("versions").join("node");
    let mut versions = list(&nvm);
    versions.sort_by_key(|v| version_key(v));
    for v in versions.iter().rev() {
        let n = nvm.join(v).join("bin").join("node");
        if exists(&n) {
            return Some(n);
        }
    }
    ["/opt/homebrew/bin/node", "/usr/local/bin/node"].iter().map(PathBuf::from).find(|n| exists(n))
}

/// Resolves for real (login shell, filesystem).
pub fn find_node(home: &Path, runner: &dyn Runner) -> Result<(PathBuf, ShellProbe), String> {
    let probe = probe_login_shell(runner);
    let list = |d: &Path| -> Vec<String> {
        std::fs::read_dir(d).map(|r| r.filter_map(|e| e.ok()?.file_name().into_string().ok()).collect()).unwrap_or_default()
    };
    let node = resolve_node(home, std::env::var_os("STACK_NODE").map(PathBuf::from), &probe, &|p| p.is_file(), &list)
        .ok_or("Node.js was not found (looked at STACK_NODE, your login shell, ~/.nvm and Homebrew). Install Node 20+ and try again.")?;
    Ok((node, probe))
}

/// `stackd.js` next to the app's resources (`Contents/Resources/stackd/stackd.js`), or `STACKD_SCRIPT`.
pub fn find_script(resource_dir: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = std::env::var_os("STACKD_SCRIPT").map(PathBuf::from).filter(|p| p.is_file()) {
        return Ok(p);
    }
    resource_dir
        .map(|d| d.join("stackd").join("stackd.js"))
        .filter(|p| p.is_file())
        .ok_or_else(|| "stackd.js is not bundled in this build (run `npm run bundle` in desktop/, or set STACKD_SCRIPT).".to_string())
}

pub fn home_dir() -> Result<PathBuf, String> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| "HOME is not set".to_string())
}

pub fn current_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

pub fn default_path(probe: &ShellProbe) -> String {
    probe.path.clone().unwrap_or_else(|| "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into())
}

/// Builds the `Setup` for the real machine.
pub fn real_setup(resource_dir: Option<&Path>) -> Result<Setup, String> {
    let home = home_dir()?;
    let (node, probe) = find_node(&home, &RealRunner)?;
    let script = find_script(resource_dir)?;
    Ok(Setup { home, node, script, path_env: default_path(&probe), uid: current_uid() })
}

/// "Start stackd now": a detached `node stackd.js serve`, logging to stackd.log; outlives the app.
pub fn start_now(s: &Setup) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    std::fs::create_dir_all(config_dir(&s.home)).map_err(|e| e.to_string())?;
    let log = std::fs::OpenOptions::new().create(true).append(true).open(log_path(&s.home)).map_err(|e| e.to_string())?;
    let err = log.try_clone().map_err(|e| e.to_string())?;
    Command::new(&s.node)
        .arg(&s.script)
        .arg("serve")
        .env("PATH", &s.path_env)
        .stdin(std::process::Stdio::null())
        .stdout(log)
        .stderr(err)
        .process_group(0)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("could not start stackd: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Fake {
        calls: RefCell<Vec<(String, Vec<String>)>>,
        fail_bootstrap: bool,
    }

    impl Runner for Fake {
        fn run(&self, program: &str, args: &[String]) -> Result<String, String> {
            self.calls.borrow_mut().push((program.into(), args.to_vec()));
            if self.fail_bootstrap && args[0] == "bootstrap" {
                return Err("boom".into());
            }
            Ok(String::new())
        }
    }

    fn temp_home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stack-launchd-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn setup(home: &Path) -> Setup {
        Setup { home: home.into(), node: "/opt/homebrew/bin/node".into(), script: "/Applications/Stack.app/Contents/Resources/stackd/stackd.js".into(), path_env: "/a:/b&c".into(), uid: 501 }
    }

    #[test]
    fn plist_has_label_args_run_at_load_crash_keepalive_and_log() {
        let home = PathBuf::from("/Users/x");
        let p = render_plist(&setup(&home));
        assert!(p.contains("<string>dev.stack.stackd</string>"));
        assert!(p.contains("<string>/opt/homebrew/bin/node</string>"));
        assert!(p.contains("<string>serve</string>"));
        assert!(p.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(p.contains("<key>Crashed</key>"));
        assert!(p.contains("<string>/Users/x/.config/stack/stackd.log</string>") || std::env::var_os("STACKD_CONFIG_DIR").is_some());
        assert!(p.contains("/a:/b&amp;c"), "escaped");
    }

    #[test]
    fn enable_writes_the_plist_under_the_given_home_and_bootstraps() {
        let home = temp_home("enable");
        let fake = Fake::default();
        enable(&fake, &setup(&home)).unwrap();
        let plist = plist_path(&home);
        assert!(plist.starts_with(&home) && plist.is_file());
        assert!(is_installed(&home));
        let calls = fake.calls.borrow();
        assert_eq!(calls[0].1, ["bootout", "gui/501/dev.stack.stackd"]);
        assert_eq!(calls[1].1, ["bootstrap".to_string(), "gui/501".into(), plist.display().to_string()]);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn enable_reports_a_failed_bootstrap() {
        let home = temp_home("fail");
        let fake = Fake { fail_bootstrap: true, ..Default::default() };
        assert_eq!(enable(&fake, &setup(&home)).unwrap_err(), "boom");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn disable_boots_out_and_removes_the_plist_and_is_idempotent() {
        let home = temp_home("disable");
        let fake = Fake::default();
        enable(&fake, &setup(&home)).unwrap();
        disable(&fake, &home, 501).unwrap();
        assert!(!is_installed(&home));
        disable(&fake, &home, 501).unwrap();
        assert_eq!(fake.calls.borrow().last().unwrap().1[0], "bootout");
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn probe_ignores_rc_noise() {
        let out = "Welcome!\n__N__/Users/x/.nvm/versions/node/v22.1.0/bin/node\n__P__/a:/b\n";
        assert_eq!(parse_probe(out), ShellProbe { node: Some("/Users/x/.nvm/versions/node/v22.1.0/bin/node".into()), path: Some("/a:/b".into()) });
        assert_eq!(parse_probe("__N__\n__P__\n"), ShellProbe::default());
        assert_eq!(parse_probe("__N__node not found\n").node, None);
    }

    #[test]
    fn node_resolution_order() {
        let home = PathBuf::from("/h");
        let none = ShellProbe::default();
        let has = |ok: &'static [&'static str]| move |p: &Path| ok.iter().any(|o| Path::new(o) == p);
        let list = |_: &Path| vec!["v18.0.0".to_string(), "v22.10.0".into(), "v9.9.9".into()];
        // env wins
        let shell = ShellProbe { node: Some("/sh/node".into()), path: None };
        assert_eq!(resolve_node(&home, Some("/env/node".into()), &shell, &has(&["/env/node", "/sh/node"]), &list), Some("/env/node".into()));
        // then the login shell
        assert_eq!(resolve_node(&home, None, &shell, &has(&["/sh/node"]), &list), Some("/sh/node".into()));
        // then the newest nvm version (numeric, not lexical)
        let nvm = has(&["/h/.nvm/versions/node/v22.10.0/bin/node", "/h/.nvm/versions/node/v9.9.9/bin/node", "/opt/homebrew/bin/node"]);
        assert_eq!(resolve_node(&home, None, &none, &nvm, &list), Some("/h/.nvm/versions/node/v22.10.0/bin/node".into()));
        // then Homebrew
        assert_eq!(resolve_node(&home, None, &none, &has(&["/usr/local/bin/node"]), &|_| vec![]), Some("/usr/local/bin/node".into()));
        assert_eq!(resolve_node(&home, None, &none, &has(&[]), &|_| vec![]), None);
    }
}
