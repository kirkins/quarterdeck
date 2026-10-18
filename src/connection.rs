//! Quarterdeck's link to Privateer: what was last read, and whether the last
//! attempt worked. Polls never overlap, and an answer to a poll made under an
//! older config is dropped.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use data::captain::Waiting;
use data::config::{self, Source};
use data::markdown::{self, Document};
use data::privateer::{Client, Error};
use iced::Task;
use serde_json::json;

#[derive(Debug, Clone)]
pub enum Message {
    Poll,
    Waited(u64, Result<Waiting, Error>),
}

pub struct Connection {
    client: Client,
    poll: Duration,
    generation: u64,
    in_flight: bool,
    /// The last answer that worked, kept while a later poll fails.
    pub waiting: Option<Waiting>,
    /// Each ask's body as Markdown, by mail id, parsed once per answer.
    pub bodies: HashMap<String, Document>,
    pub error: Option<Error>,
    /// When Privateer last answered, in ms since the epoch.
    pub checked_ms: Option<i64>,
}

impl Connection {
    pub fn new(config: &config::Privateer) -> Self {
        Self {
            client: Client::new(config),
            poll: poll_interval(config),
            generation: 0,
            in_flight: false,
            waiting: None,
            bodies: HashMap::new(),
            error: None,
            checked_ms: None,
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

    pub fn poll(&mut self) -> Task<Message> {
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
            Message::Waited(generation, result) => {
                if generation != self.generation {
                    return Task::none();
                }
                self.in_flight = false;
                match result {
                    Ok(waiting) => {
                        self.bodies = waiting
                            .waiting
                            .iter()
                            .map(|item| {
                                (
                                    item.mail.id.clone(),
                                    markdown::parse(&item.mail.body, None),
                                )
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
