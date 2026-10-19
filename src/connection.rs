//! Quarterdeck's link to Privateer: what was last read, and whether the last
//! attempt worked. Polls never overlap, and an answer to a poll made under an
//! older config is dropped.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data::captain::Waiting;
use data::choices;
use data::config::{self, Source};
use data::decision::Card;
use data::feed::{Page, Scope, Thread};
use data::fleet::Snapshot;
use data::markdown::{self, Document};
use data::privateer::{Client, Error, Sent};
use data::report::Report;
use data::session::Target;
use data::ships::{self, Ship};
use data::triage;
use iced::Task;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub enum Message {
    Poll,
    LoadOlder(Which),
    Ships(u64, Result<Vec<Ship>, Error>),
    ReportRead(u64, String, Result<Report, Error>),
    SessionRead(u64, Target, Result<Value, Error>),
    FeedRead {
        generation: u64,
        which: Which,
        /// The ship it was read for, so a read for a ship no longer open
        /// is dropped.
        scope: Option<Scope>,
        older: bool,
        result: Result<Page, Error>,
    },
    Waited(u64, Result<Waiting, Error>),
    FleetRead {
        generation: u64,
        since: bool,
        result: Result<Snapshot, Error>,
    },
}

/// One ask, read for drawing: its card, and its Markdown.
pub struct Details {
    pub card: Card,
    pub body: Document,
    pub why: Option<Document>,
    /// Choices written into a plain request, to tick.
    pub choices: Option<choices::Split>,
}

impl Details {
    fn read(item: &data::captain::Item) -> Self {
        let card = Card::from_mail(&item.mail);
        let why = card.why.as_deref().map(|why| markdown::parse(why, None));
        let body = markdown::parse(&item.mail.body, None);
        let choices = if card.options.is_empty() {
            choices::split(&body)
        } else {
            None
        };
        Self {
            body,
            why,
            card,
            choices,
        }
    }
}

pub struct Connection {
    client: Client,
    poll: Duration,
    generation: u64,
    in_flight: bool,
    /// The last answer that worked, kept while a later poll fails.
    pub waiting: Option<Waiting>,
    /// Each ask read once per answer, by its triage key.
    pub details: HashMap<String, Details>,
    pub error: Option<Error>,
    /// When Privateer last answered, in ms since the epoch.
    pub checked_ms: Option<i64>,
    pub feed: Feed,
    /// The open ship's conversation, in the Ships view.
    pub ship_feed: Feed,
    /// Every ship the fleet knows, A to Z, read once per connection.
    pub ships: Vec<Ship>,
    /// The live session being watched: its last screen.
    pub screen: Option<Screen>,
    reading_session: bool,
    /// Stored reports read so far, by id, with their Markdown.
    pub reports: HashMap<String, Result<(Report, Document), Error>>,
    reading_ships: bool,
    reading_report: bool,
    pub fleet: Fleet,
}

/// The fleet as last read, and whether the last read worked.
#[derive(Default)]
pub struct Fleet {
    pub snapshot: Option<Snapshot>,
    pub error: Option<Error>,
    /// When the snapshot held was read.
    pub read_ms: Option<i64>,
    asked_ms: Option<i64>,
    reading: bool,
    /// The last read went wrong: read the next in full.
    doubt: bool,
}

/// The fleet is read at most this often while it is on screen.
const FLEET_EVERY_MS: i64 = 15_000;

/// A live session's last screen.
pub struct Screen {
    pub target: Target,
    /// The screen as read, to tell whether it changed: some hosts report
    /// no revision.
    pub raw: String,
    pub agent_status: String,
    /// A view of a headless crew: typed lines go to its first mate.
    pub viewer: bool,
    pub lines: Vec<Vec<data::ansi::Run>>,
    /// Why there is no screen: no live session, or an older Privateer.
    pub error: Option<String>,
}

/// Which conversation: the Feed's, across every ship, or the open ship's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Which {
    All,
    Ship,
}

/// A conversation as read so far: its messages, each message's Markdown,
/// and whether the last read worked.
#[derive(Default)]
pub struct Feed {
    /// The ship it is narrowed to; none for the whole history.
    pub scope: Option<Scope>,
    /// A read has worked at least once.
    pub loaded: bool,
    pub thread: Thread,
    pub bodies: HashMap<String, Document>,
    pub error: Option<Error>,
    reading_newer: bool,
    pub reading_older: bool,
}

impl Feed {
    /// Its first read is still to come.
    pub fn loading(&self) -> bool {
        !self.loaded && self.error.is_none()
    }
}

/// Messages read per page.
const FEED_PAGE: u32 = 30;

impl Connection {
    pub fn new(config: &config::Privateer) -> Self {
        Self {
            client: Client::new(config),
            poll: poll_interval(config),
            generation: 0,
            in_flight: false,
            waiting: None,
            details: HashMap::new(),
            error: None,
            checked_ms: None,
            feed: Feed::default(),
            ship_feed: Feed::default(),
            ships: Vec::new(),
            reading_ships: false,
            reading_report: false,
            reports: HashMap::new(),
            screen: None,
            reading_session: false,
            fleet: Fleet::default(),
        }
    }

    pub fn source(&self) -> Source {
        self.client.source()
    }

    pub fn poll_every(&self) -> Duration {
        self.poll
    }

    pub fn is_loading(&self) -> bool {
        self.in_flight && self.waiting.is_none() && self.error.is_none()
    }

    /// The ships list's first read is under way.
    pub fn ships_loading(&self) -> bool {
        self.ships.is_empty() && self.reading_ships
    }

    /// The fleet's first read is still to come.
    pub fn fleet_loading(&self) -> bool {
        self.fleet.snapshot.is_none() && self.fleet.error.is_none()
    }

    /// Anything shown is waiting on its first read, so a loading spinner
    /// needs turning.
    pub fn busy(&self) -> bool {
        self.is_loading()
            || self.feed.loading()
            || (self.ship_feed.scope.is_some() && self.ship_feed.loading())
            || self.ships_loading()
            || (self.fleet.reading && self.fleet.snapshot.is_none())
            || (self.reading_session && self.screen.is_none())
            || self.reading_report
    }

    /// Point at a new config. Returns a poll when anything changed.
    pub fn configure(&mut self, config: &config::Privateer) -> Task<Message> {
        let client = Client::new(config);
        if client == self.client {
            return Task::none();
        }
        *self = Self {
            generation: self.generation + 1,
            ..Self::new(config)
        };
        self.poll()
    }

    /// Whether writes really reach Privateer.
    pub fn sends(&self) -> bool {
        self.client.sends()
    }

    /// A write, such as `captain.reply`, through the one guarded path.
    pub fn send(
        &self,
        command: &'static str,
        args: serde_json::Value,
    ) -> impl Future<Output = Result<Sent, Error>> + use<> {
        let client = self.client.clone();
        async move { client.send(command, args).await }
    }

    pub fn poll(&mut self) -> Task<Message> {
        Task::batch([
            self.poll_waiting(),
            self.read_feed(Which::All, false),
            self.read_feed(Which::Ship, false),
            self.read_ships(),
        ])
    }

    /// Narrow the ship conversation to `scope`, read anew when it changed.
    pub fn open_ship(&mut self, scope: Scope) -> Task<Message> {
        if self.ship_feed.scope.as_ref() == Some(&scope) {
            return Task::none();
        }
        self.ship_feed = Feed {
            scope: Some(scope),
            ..Feed::default()
        };
        self.read_feed(Which::Ship, false)
    }

    pub fn feed(&self, which: Which) -> &Feed {
        match which {
            Which::All => &self.feed,
            Which::Ship => &self.ship_feed,
        }
    }

    fn feed_mut(&mut self, which: Which) -> &mut Feed {
        match which {
            Which::All => &mut self.feed,
            Which::Ship => &mut self.ship_feed,
        }
    }

    /// The screen of a first mate's or crew's live session, unless a read
    /// is under way.
    pub fn read_session(&mut self, target: &Target) -> Task<Message> {
        if self.reading_session {
            return Task::none();
        }
        self.reading_session = true;
        let client = self.client.clone();
        let generation = self.generation;
        let target = target.clone();
        let mut args = target.args();
        args["lines"] = json!(200);
        Task::perform(
            async move { client.run("session.read", args).await },
            move |result| {
                Message::SessionRead(generation, target.clone(), result)
            },
        )
    }

    /// The fleet, unless it was asked for in the last 15 s. Machines
    /// unchanged since the snapshot held are not sent again.
    pub fn read_fleet(&mut self) -> Task<Message> {
        let due = self
            .fleet
            .asked_ms
            .is_none_or(|at| now_ms() - at >= FLEET_EVERY_MS);
        if !due || self.fleet.reading {
            return Task::none();
        }
        self.ask_fleet()
    }

    fn ask_fleet(&mut self) -> Task<Message> {
        let fleet = &mut self.fleet;
        let since = fleet
            .snapshot
            .as_ref()
            .filter(|_| !fleet.doubt)
            .and_then(Snapshot::since);
        fleet.reading = true;
        fleet.asked_ms = Some(now_ms());
        let client = self.client.clone();
        let generation = self.generation;
        let args = since
            .as_ref()
            .map_or_else(|| json!({}), |since| json!({ "since": since }));
        let since = since.is_some();
        Task::perform(
            async move {
                let value = client.run("fleet.snapshot", args).await?;
                Snapshot::parse(value).map_err(|error| Error::Command {
                    command: "fleet.snapshot".into(),
                    error: format!("unexpected answer: {error}"),
                })
            },
            move |result| Message::FleetRead {
                generation,
                since,
                result,
            },
        )
    }

    /// A stored report, read once; it is kept until the connection changes.
    pub fn read_report(&mut self, id: String) -> Task<Message> {
        if matches!(self.reports.get(&id), Some(Ok(_))) {
            return Task::none();
        }
        self.reading_report = true;
        let client = self.client.clone();
        let generation = self.generation;
        Task::perform(
            {
                let id = id.clone();
                async move {
                    let value =
                        client.run("report.get", json!({"id": id})).await?;
                    Report::parse(value).map_err(|error| Error::Command {
                        command: "report.get".into(),
                        error: format!("unexpected answer: {error}"),
                    })
                }
            },
            move |result| Message::ReportRead(generation, id.clone(), result),
        )
    }

    /// The fleet's ships, until they have been read once.
    fn read_ships(&mut self) -> Task<Message> {
        if !self.ships.is_empty() || self.reading_ships {
            return Task::none();
        }
        self.reading_ships = true;
        let client = self.client.clone();
        let generation = self.generation;
        Task::perform(
            async move {
                let value = client.run("ship.list", json!({})).await?;
                ships::parse(value).map_err(|error| Error::Command {
                    command: "ship.list".into(),
                    error: format!("unexpected answer: {error}"),
                })
            },
            move |result| Message::Ships(generation, result),
        )
    }

    /// Read new mail, or the newest page when nothing is read yet; with
    /// `older`, the page before the oldest message read.
    fn read_feed(&mut self, which: Which, older: bool) -> Task<Message> {
        let feed = self.feed_mut(which);
        if which == Which::Ship && feed.scope.is_none() {
            return Task::none();
        }
        let args = if older {
            if feed.reading_older {
                return Task::none();
            }
            let Some(args) = feed.thread.older_args(FEED_PAGE) else {
                return Task::none();
            };
            feed.reading_older = true;
            args
        } else {
            if feed.reading_newer {
                return Task::none();
            }
            feed.reading_newer = true;
            feed.thread.newer_args(FEED_PAGE, now_ms())
        };
        let scope = feed.scope.clone();
        let args = match &scope {
            Some(scope) => scope.narrow(args),
            None => args,
        };
        let client = self.client.clone();
        let generation = self.generation;
        Task::perform(
            async move {
                let value = client.run("captain.feed", args).await?;
                Page::parse(value).map_err(|error| Error::Command {
                    command: "captain.feed".into(),
                    error: format!("unexpected answer: {error}"),
                })
            },
            move |result| Message::FeedRead {
                generation,
                which,
                scope: scope.clone(),
                older,
                result,
            },
        )
    }

    fn poll_waiting(&mut self) -> Task<Message> {
        if self.in_flight {
            return Task::none();
        }
        self.in_flight = true;
        let client = self.client.clone();
        let generation = self.generation;
        Task::perform(
            async move {
                let value = client.run("captain.waiting", json!({})).await?;
                Waiting::parse(value).map_err(|error| Error::Command {
                    command: "captain.waiting".into(),
                    error: format!("unexpected answer: {error}"),
                })
            },
            move |result| Message::Waited(generation, result),
        )
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Poll => self.poll(),
            Message::LoadOlder(which) => self.read_feed(which, true),
            Message::SessionRead(generation, target, result) => {
                if generation != self.generation {
                    return Task::none();
                }
                self.reading_session = false;
                let screen = match result {
                    Ok(read) => {
                        let raw = read["text"].as_str().unwrap_or_default();
                        let status =
                            read["agent_status"].as_str().unwrap_or("unknown");
                        // An unchanged screen is not read into lines again.
                        if let Some(current) = &self.screen
                            && current.target == target
                            && current.error.is_none()
                            && current.raw == raw
                            && current.agent_status == status
                        {
                            return Task::none();
                        }
                        Screen {
                            target,
                            raw: raw.to_owned(),
                            agent_status: status.to_owned(),
                            viewer: read["viewer"] == json!(true),
                            lines: data::ansi::parse(raw),
                            error: None,
                        }
                    }
                    Err(error) => Screen {
                        target,
                        raw: String::new(),
                        agent_status: "unknown".into(),
                        viewer: false,
                        lines: Vec::new(),
                        error: Some(match &error {
                            Error::Command { error, .. }
                                if error.contains("unknown") =>
                            {
                                "This Privateer cannot show live sessions yet."
                                    .to_owned()
                            }
                            Error::Command { error, .. } => error.clone(),
                            other => other.to_string(),
                        }),
                    },
                };
                self.screen = Some(screen);
                Task::none()
            }
            Message::ReportRead(generation, id, result) => {
                if generation == self.generation {
                    self.reading_report = false;
                    let read = result.map(|report| {
                        let document = markdown::parse(&report.content, None);
                        (report, document)
                    });
                    self.reports.insert(id, read);
                }
                Task::none()
            }
            Message::Ships(generation, result) => {
                if generation == self.generation {
                    self.reading_ships = false;
                    match result {
                        Ok(ships) => self.ships = ships,
                        Err(error) => log::warn!("{error}"),
                    }
                }
                Task::none()
            }
            Message::FeedRead {
                generation,
                which,
                scope,
                older,
                result,
            } => {
                if generation != self.generation {
                    return Task::none();
                }
                let feed = self.feed_mut(which);
                if feed.scope != scope {
                    return Task::none();
                }
                if older {
                    feed.reading_older = false;
                } else {
                    feed.reading_newer = false;
                }
                match result {
                    Ok(page) => {
                        for entry in &page.entries {
                            feed.bodies.insert(
                                entry.key(),
                                markdown::parse(&entry.body, None),
                            );
                        }
                        if older {
                            feed.thread.add_older(page);
                        } else {
                            feed.thread.add_newer(page);
                        }
                        feed.loaded = true;
                        feed.error = None;
                    }
                    Err(error) => {
                        log::warn!("{error}");
                        feed.error = Some(error);
                    }
                }
                Task::none()
            }
            Message::FleetRead {
                generation,
                since,
                result,
            } => {
                if generation != self.generation {
                    return Task::none();
                }
                let fleet = &mut self.fleet;
                fleet.reading = false;
                match result {
                    Ok(next) => {
                        let held = fleet.snapshot.as_ref();
                        match Snapshot::merge(held, next.clone()) {
                            Some(merged) => fleet.snapshot = Some(merged),
                            // An unchanged machine with nothing held: read
                            // again in full.
                            None if since => {
                                fleet.doubt = true;
                                return self.ask_fleet();
                            }
                            None => fleet.snapshot = Some(next),
                        }
                        fleet.read_ms = Some(now_ms());
                        fleet.error = None;
                        fleet.doubt = false;
                    }
                    Err(error) => {
                        log::warn!("{error}");
                        fleet.error = Some(error);
                        fleet.doubt = true;
                    }
                }
                Task::none()
            }
            Message::Waited(generation, result) => {
                if generation != self.generation {
                    return Task::none();
                }
                self.in_flight = false;
                match result {
                    Ok(waiting) => {
                        self.details = waiting
                            .waiting
                            .iter()
                            .map(|item| {
                                (triage::key(item), Details::read(item))
                            })
                            .collect();
                        self.waiting = Some(waiting);
                        self.error = None;
                        self.checked_ms = Some(now_ms());
                    }
                    Err(error) => {
                        log::warn!("{error}");
                        self.error = Some(error);
                    }
                }
                Task::none()
            }
        }
    }
}

fn poll_interval(config: &config::Privateer) -> Duration {
    // Each poll may cross SSH to the captain's desk: not more than every 5s.
    Duration::from_secs(config.poll_seconds.max(5))
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}
