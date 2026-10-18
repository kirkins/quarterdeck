//! Quarterdeck's link to Privateer: what was last read, and whether the last
//! attempt worked. Polls never overlap, and an answer to a poll made under an
//! older config is dropped.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data::captain::Waiting;
use data::choices;
use data::config::{self, Source};
use data::decision::Card;
use data::feed::{Page, Thread};
use data::markdown::{self, Document};
use data::privateer::{Client, Error, Sent};
use data::report::Report;
use data::ships::{self, Ship};
use data::triage;
use iced::Task;
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub enum Message {
    Poll,
    LoadOlder,
    Ships(u64, Result<Vec<Ship>, Error>),
    ReportRead(u64, String, Result<Report, Error>),
    SessionRead(u64, String, Result<Value, Error>),
    FeedRead {
        generation: u64,
        older: bool,
        result: Result<Page, Error>,
    },
    Waited(u64, Result<Waiting, Error>),
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
    /// Every ship the fleet knows, A to Z, read once per connection.
    pub ships: Vec<Ship>,
    /// The live session being watched: its last screen.
    pub screen: Option<Screen>,
    reading_session: bool,
    /// Stored reports read so far, by id, with their Markdown.
    pub reports: HashMap<String, Result<(Report, Document), Error>>,
    reading_ships: bool,
}

/// A live session's last screen.
pub struct Screen {
    pub ship: String,
    pub revision: u64,
    pub agent_status: String,
    pub lines: Vec<Vec<data::ansi::Run>>,
    /// Why there is no screen: no live session, or an older Privateer.
    pub error: Option<String>,
}

/// The Feed as read so far: the conversation, each message's Markdown, and
/// whether the last read worked.
#[derive(Default)]
pub struct Feed {
    pub thread: Thread,
    pub bodies: HashMap<String, Document>,
    pub error: Option<Error>,
    reading_newer: bool,
    pub reading_older: bool,
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
            ships: Vec::new(),
            reading_ships: false,
            reports: HashMap::new(),
            screen: None,
            reading_session: false,
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
            self.read_feed(false),
            self.read_ships(),
        ])
    }

    /// The screen of `ship`'s live session, unless a read is under way.
    pub fn read_session(&mut self, ship: &str) -> Task<Message> {
        if self.reading_session {
            return Task::none();
        }
        self.reading_session = true;
        let client = self.client.clone();
        let generation = self.generation;
        let ship = ship.to_owned();
        Task::perform(
            {
                let ship = ship.clone();
                async move {
                    client
                        .run(
                            "session.read",
                            json!({"ship": ship, "lines": 200}),
                        )
                        .await
                }
            },
            move |result| {
                Message::SessionRead(generation, ship.clone(), result)
            },
        )
    }

    /// A stored report, read once; it is kept until the connection changes.
    pub fn read_report(&mut self, id: String) -> Task<Message> {
        if matches!(self.reports.get(&id), Some(Ok(_))) {
            return Task::none();
        }
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
    fn read_feed(&mut self, older: bool) -> Task<Message> {
        let feed = &mut self.feed;
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
            Message::LoadOlder => self.read_feed(true),
            Message::SessionRead(generation, ship, result) => {
                if generation != self.generation {
                    return Task::none();
                }
                self.reading_session = false;
                let screen = match result {
                    Ok(read) => {
                        let revision = read["revision"].as_u64().unwrap_or(0);
                        // An unchanged screen is not drawn again.
                        if let Some(current) = &self.screen
                            && current.ship == ship
                            && current.error.is_none()
                            && current.revision == revision
                        {
                            return Task::none();
                        }
                        Screen {
                            ship,
                            revision,
                            agent_status: read["agent_status"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_owned(),
                            lines: data::ansi::parse(
                                read["text"].as_str().unwrap_or_default(),
                            ),
                            error: None,
                        }
                    }
                    Err(error) => Screen {
                        ship,
                        revision: 0,
                        agent_status: "unknown".into(),
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
                older,
                result,
            } => {
                if generation != self.generation {
                    return Task::none();
                }
                let feed = &mut self.feed;
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
                        feed.error = None;
                    }
                    Err(error) => {
                        log::warn!("{error}");
                        feed.error = Some(error);
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
