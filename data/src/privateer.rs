//! Running Privateer: the binary, one command at a time, with an argv array
//! and a JSON argument, never through a shell.
//!
//! ```text
//! privateer --home HOME COMMAND --json '{...}'
//! ```
//!
//! A command answers with one JSON object on stdout, or `{"ok": false,
//! "error": ...}` when it fails. Each run has a time limit and an output
//! limit. The process runs in its own process group so that what it starts
//! (an SSH to a linked machine) is stopped with it, and a stop is only
//! reported once the group is gone.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

use crate::config::{self, Source};

/// A forwarded command waits on SSH and the other machine.
pub const TIMEOUT: Duration = Duration::from_secs(45);
/// More than any answer Privateer gives; anything larger is refused.
pub const MAX_OUTPUT: usize = 16 * 1024 * 1024;
const MAX_STDERR: usize = 8 * 1024;
/// How long a stopped command has to exit before it is killed.
const GRACE: Duration = Duration::from_secs(2);

const WAITING_FIXTURE: &str =
    include_str!("../../fixtures/captain.waiting.json");
const FEED_FIXTURE: &str = include_str!("../../fixtures/captain.feed.json");
const FLEET_FIXTURE: &str = include_str!("../../fixtures/fleet.snapshot.json");
const NEEDS_FIXTURE: &str = include_str!("../../fixtures/runtime.needs.json");
const REPORTS_FIXTURE: &str = include_str!("../../fixtures/report.get.json");
const ROUTES_FIXTURE: &str = include_str!("../../fixtures/routes.show.json");
const USAGE_FIXTURE: &str = include_str!("../../fixtures/usage.records.json");

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum Error {
    #[error("{0}")]
    NotConfigured(String),
    #[error("could not run {bin}: {error}")]
    Spawn { bin: String, error: String },
    #[error("privateer {command} took longer than {seconds}s and was stopped")]
    Timeout { command: String, seconds: u64 },
    #[error("privateer {command} printed more than {limit} bytes")]
    TooLarge { command: String, limit: usize },
    #[error("privateer {command} exited with {status}: {stderr}")]
    Exit {
        command: String,
        status: String,
        stderr: String,
    },
    #[error("privateer {command} printed something that is not a JSON object")]
    Parse { command: String },
    #[error("privateer {command}: {error}")]
    Command { command: String, error: String },
    #[error("the fixtures have no answer for {0}")]
    NoFixture(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Client {
    source: Source,
    bin: PathBuf,
    home: Option<PathBuf>,
    allow_send: bool,
    timeout: Duration,
}

/// What became of a write.
#[derive(Debug, Clone, PartialEq)]
pub enum Sent {
    /// Privateer ran it and answered.
    Sent(Value),
    /// Sending is off: nothing ran. The command that would have.
    Held(Vec<String>),
}

impl Client {
    pub fn new(config: &config::Privateer) -> Self {
        Self {
            source: config.source,
            bin: config.bin.clone(),
            home: config.home.clone(),
            allow_send: config.allow_send,
            timeout: TIMEOUT,
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn source(&self) -> Source {
        self.source
    }

    /// Whether writes really reach Privateer.
    pub fn sends(&self) -> bool {
        self.allow_send && self.source == Source::Cli
    }

    /// Run a command that changes something, such as `captain.reply`. Every
    /// write goes through here: unless sending is on and the source is the
    /// binary, nothing runs and the command is handed back.
    pub async fn send(
        &self,
        command: &str,
        args: Value,
    ) -> Result<Sent, Error> {
        if !self.sends() {
            let home = self.home.clone().unwrap_or_else(|| "HOME".into());
            let mut argv = vec![self.bin.display().to_string()];
            argv.extend(argv_for(&home, command, &args));
            log::info!("sending is off; would run: {argv:?}");
            return Ok(Sent::Held(argv));
        }
        self.run(command, args).await.map(Sent::Sent)
    }

    /// Run one command and return its JSON answer.
    pub async fn run(
        &self,
        command: &str,
        args: Value,
    ) -> Result<Value, Error> {
        match self.source {
            Source::Fixtures => fixture(command, &args),
            Source::Cli => {
                let home = self.home.as_deref().ok_or_else(|| {
                    Error::NotConfigured(
                        "Set [privateer] home in config.toml to a Privateer \
                         home, such as a ship's .privateer folder."
                            .into(),
                    )
                })?;
                run(&self.bin, home, command, &args, self.timeout).await
            }
        }
    }
}

fn fixture(command: &str, args: &Value) -> Result<Value, Error> {
    if command == "report.get" {
        let all: Value =
            serde_json::from_str(REPORTS_FIXTURE).map_err(|_| {
                Error::Parse {
                    command: command.to_owned(),
                }
            })?;
        let id = args["id"].as_str().unwrap_or_default();
        return all["reports"]
            .get(id)
            .cloned()
            .ok_or_else(|| Error::Command {
                command: command.to_owned(),
                error: format!("no report {id} in the fleet"),
            });
    }
    if command == "usage.summary" {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as i64);
        return crate::spend::fixture_summary(USAGE_FIXTURE, args, now_ms)
            .map_err(|error| Error::Command {
                command: command.to_owned(),
                error,
            });
    }
    let text = match command {
        "captain.waiting" => WAITING_FIXTURE,
        "routes.show" => ROUTES_FIXTURE,
        "captain.feed" => FEED_FIXTURE,
        "fleet.snapshot" => FLEET_FIXTURE,
        "runtime.needs" => NEEDS_FIXTURE,
        "ship.list" => {
            r#"{"ships": [{"name": "billing"}, {"name": "status-page"}, {"name": "chandlery"}]}"#
        }
        _ => return Err(Error::NoFixture(command.to_owned())),
    };
    serde_json::from_str(text).map_err(|_| Error::Parse {
        command: command.to_owned(),
    })
}

/// The argv for one command.
pub fn argv_for(home: &Path, command: &str, args: &Value) -> Vec<String> {
    vec![
        "--home".into(),
        home.to_string_lossy().into_owned(),
        command.into(),
        "--json".into(),
        args.to_string(),
    ]
}

async fn run(
    bin: &Path,
    home: &Path,
    command: &str,
    args: &Value,
    timeout: Duration,
) -> Result<Value, Error> {
    let mut process = Command::new(bin);
    process
        .args(argv_for(home, command, args))
        // Quarterdeck acts as the captain: never as a ship whose shell it
        // was started from.
        .env_remove("PRIVATEER_ACTOR")
        .env_remove("PRIVATEER_ROLE")
        .env_remove("PRIVATEER_HOME")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    process.process_group(0);

    let mut child = process.spawn().map_err(|error| Error::Spawn {
        bin: bin.display().to_string(),
        error: error.to_string(),
    })?;
    let stdout = child.stdout.take().expect("stdout is piped");
    let stderr = child.stderr.take().expect("stderr is piped");

    let finished = tokio::time::timeout(timeout, async {
        let (out, err) = tokio::join!(
            read_capped(stdout, MAX_OUTPUT),
            read_capped(stderr, MAX_STDERR)
        );
        if out.overflowed {
            return None;
        }
        let status = child.wait().await;
        Some((status, out.bytes, err.bytes))
    })
    .await;

    let (status, stdout, stderr) = match finished {
        Ok(Some((Ok(status), stdout, stderr))) => (status, stdout, stderr),
        Ok(Some((Err(error), _, _))) => {
            return Err(Error::Spawn {
                bin: bin.display().to_string(),
                error: error.to_string(),
            });
        }
        Ok(None) => {
            stop(&mut child).await;
            return Err(Error::TooLarge {
                command: command.to_owned(),
                limit: MAX_OUTPUT,
            });
        }
        Err(_) => {
            stop(&mut child).await;
            return Err(Error::Timeout {
                command: command.to_owned(),
                seconds: timeout.as_secs(),
            });
        }
    };

    // Privateer reports a failed command as JSON on stdout, sometimes with a
    // non-zero exit: prefer that to the bare status.
    let parsed = serde_json::from_slice::<Value>(&stdout)
        .ok()
        .filter(Value::is_object);
    match parsed {
        Some(value) if value["ok"] == Value::Bool(false) => {
            Err(Error::Command {
                command: command.to_owned(),
                error: match &value["error"] {
                    Value::String(error) => error.clone(),
                    other => other.to_string(),
                },
            })
        }
        Some(value) if status.success() => Ok(value),
        _ if !status.success() => Err(Error::Exit {
            command: command.to_owned(),
            status: status.to_string(),
            stderr: String::from_utf8_lossy(&stderr).trim().to_owned(),
        }),
        _ => Err(Error::Parse {
            command: command.to_owned(),
        }),
    }
}

struct Captured {
    bytes: Vec<u8>,
    overflowed: bool,
}

/// Read to the end, keeping at most `limit` bytes. Stdout stops at the
/// limit; stderr is drained so the process never blocks writing to it.
async fn read_capped(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
) -> Captured {
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut overflowed = false;
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = limit.saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..read.min(room)]);
                if read > room {
                    overflowed = true;
                    if limit == MAX_OUTPUT {
                        break;
                    }
                }
            }
        }
    }
    Captured { bytes, overflowed }
}

/// Stop a command and everything it started: ask the process group to
/// terminate, kill it after a grace period, reap the child, and check that
/// no process of the group is left.
async fn stop(child: &mut Child) {
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        let group = pid as libc::pid_t;
        signal_group(group, libc::SIGTERM);
        if tokio::time::timeout(GRACE, child.wait()).await.is_err() {
            signal_group(group, libc::SIGKILL);
        }
        let _ = child.wait().await;
        // The child is reaped; what it started may still be exiting.
        for _ in 0..20 {
            if !group_alive(group) {
                return;
            }
            signal_group(group, libc::SIGKILL);
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        log::warn!("privateer process group {group} outlived its stop");
        return;
    }

    let _ = child.kill().await;
}

#[cfg(unix)]
fn signal_group(group: libc::pid_t, signal: libc::c_int) {
    // SAFETY: killpg only sends a signal; a gone group returns ESRCH.
    unsafe {
        libc::killpg(group, signal);
    }
}

#[cfg(unix)]
fn group_alive(group: libc::pid_t) -> bool {
    // SAFETY: signal 0 checks for the group without sending anything.
    unsafe { libc::killpg(group, 0) == 0 }
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use serde_json::json;

    use super::*;

    /// A fake privateer: a shell script written to a fresh directory.
    fn script(name: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "quarterdeck-privateer-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("privateer");
        std::fs::write(&bin, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))
            .unwrap();
        (dir, bin)
    }

    fn client(bin: PathBuf, dir: &Path) -> Client {
        Client::new(&config::Privateer {
            source: Source::Cli,
            bin,
            home: Some(dir.join("home")),
            poll_seconds: 15,
            allow_send: false,
        })
    }

    #[tokio::test]
    async fn runs_as_the_captain_with_an_argv_and_reads_the_answer() {
        let (dir, bin) = script(
            "argv",
            r#"here="$(dirname "$0")"
printf '%s\n' "$@" > "$here/argv"
printf '%s' "$PRIVATEER_ACTOR" > "$here/actor"
echo '{"waiting":[]}'"#,
        );
        // SAFETY: tests in this module do not read the environment
        // concurrently with this write.
        unsafe { std::env::set_var("PRIVATEER_ACTOR", "scout") };

        let answer = client(bin, &dir)
            .run("captain.waiting", json!({"limit": 5}))
            .await
            .unwrap();

        assert_eq!(answer, json!({"waiting": []}));
        let home = dir.join("home").display().to_string();
        assert_eq!(
            std::fs::read_to_string(dir.join("argv")).unwrap(),
            format!(
                "--home\n{home}\ncaptain.waiting\n--json\n{{\"limit\":5}}\n"
            )
        );
        assert_eq!(std::fs::read_to_string(dir.join("actor")).unwrap(), "");
    }

    #[tokio::test]
    async fn a_refusal_is_the_commands_error_not_the_exit_status() {
        let (dir, bin) = script(
            "refused",
            r#"echo '{"ok":false,"error":"no open captain item abc"}'; exit 1"#,
        );

        let error = client(bin, &dir)
            .run("captain.reply", json!({"id": "abc"}))
            .await
            .unwrap_err();

        assert_eq!(
            error,
            Error::Command {
                command: "captain.reply".into(),
                error: "no open captain item abc".into(),
            }
        );
    }

    #[tokio::test]
    async fn a_hung_command_is_stopped_with_everything_it_started() {
        let (dir, bin) = script(
            "hung",
            r#"sleep 30 & echo $! > "$(dirname "$0")/grandchild"; wait"#,
        );

        let error = client(bin, &dir)
            .with_timeout(Duration::from_millis(500))
            .run("fleet.snapshot", json!({}))
            .await
            .unwrap_err();

        assert!(matches!(error, Error::Timeout { .. }), "{error}");
        let grandchild: libc::pid_t =
            std::fs::read_to_string(dir.join("grandchild"))
                .unwrap()
                .trim()
                .parse()
                .unwrap();
        // SAFETY: signal 0 only checks that the process exists.
        let alive = unsafe { libc::kill(grandchild, 0) == 0 };
        assert!(!alive, "the command's child {grandchild} is still running");
    }

    #[tokio::test]
    async fn endless_output_is_refused() {
        let (dir, bin) = script("endless", "exec yes");

        let error = client(bin, &dir)
            .run("captain.feed", json!({}))
            .await
            .unwrap_err();

        assert!(matches!(error, Error::TooLarge { .. }), "{error}");
    }

    #[tokio::test]
    async fn a_write_runs_only_when_sending_is_on() {
        let (dir, bin) = script(
            "send",
            r#"touch "$(dirname "$0")/ran"; echo '{"id":"a1"}'"#,
        );
        let held = client(bin.clone(), &dir);
        let reply = json!({"id": "a1", "body": "Yes"});

        let Sent::Held(argv) =
            held.send("captain.reply", reply.clone()).await.unwrap()
        else {
            panic!("sent with sending off");
        };
        assert_eq!(argv[3], "captain.reply");
        assert!(!dir.join("ran").exists());

        let sending = Client {
            allow_send: true,
            ..held
        };
        assert_eq!(
            sending.send("captain.reply", reply).await.unwrap(),
            Sent::Sent(json!({"id": "a1"}))
        );
        assert!(dir.join("ran").exists());
    }

    #[tokio::test]
    async fn no_home_is_a_setup_problem_not_a_failure_to_run() {
        let client = Client::new(&config::Privateer::default());

        let error = client.run("captain.waiting", json!({})).await;

        assert!(matches!(error, Err(Error::NotConfigured(_))));
    }
}
