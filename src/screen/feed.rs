//! The Feed: one conversation with every ship, oldest at the top. Asks show
//! their state; an open one is answered in Triage, the one answer path.

use std::collections::HashSet;

use chrono::{DateTime, Local, TimeZone};
use data::feed::Entry;
use data::privateer::{Error, Sent};
use data::ships::Ship;
use iced::widget::{
    button, checkbox, column, container, pick_list, row, scrollable, space,
    text_editor,
};
use iced::{Alignment, Length, Padding};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::Connection;
use crate::font;
use crate::screen::reports;
use crate::screen::triage::{self, Triage};
use crate::widget::{Column, Element, markdown, text};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub enum Message {
    LoadOlder,
    /// Show or hide the answer controls under an open ask, by its key.
    Answer(String),
    OpenLink(String),
    /// Answering in place, through Triage's one answer path.
    Triage(triage::Message),
    Compose(Compose),
    OpenReport(reports::Opened),
}

/// Writing to a ship.
#[derive(Debug, Clone)]
pub enum Compose {
    To(String),
    Edit(text_editor::Action),
    /// Whether the message asks for an answer (a request) or tells (a
    /// notice).
    Ask(bool),
    Confirm,
    Cancel,
    Send,
}

/// The write key for the composer's message, beside the asks' keys.
pub const COMPOSE_KEY: &str = "compose";

/// The message being written.
#[derive(Default)]
pub struct Composer {
    to: Option<String>,
    content: text_editor::Content,
    ask: bool,
    confirming: bool,
    sending: bool,
    /// What became of the last message, and whether that was good.
    last: Option<(bool, String)>,
}

impl Composer {
    /// A write to run, when the captain sends.
    pub fn update(
        &mut self,
        message: Compose,
    ) -> Option<(&'static str, Value)> {
        match message {
            Compose::To(ship) => self.to = Some(ship),
            Compose::Edit(action) => {
                self.content.perform(action);
                self.confirming = false;
            }
            Compose::Ask(ask) => self.ask = ask,
            Compose::Confirm => self.confirming = self.ready(),
            Compose::Cancel => self.confirming = false,
            Compose::Send => {
                if !self.ready() || self.sending {
                    return None;
                }
                self.sending = true;
                self.last = None;
                let args = json!({
                    "to": self.to.clone()?,
                    "kind": if self.ask { "request" } else { "notice" },
                    "body": self.content.text().trim(),
                });
                return Some(("captain.send", args));
            }
        }
        None
    }

    fn ready(&self) -> bool {
        self.to.is_some() && !self.content.text().trim().is_empty()
    }

    /// What became of the message. A sent or logged one clears the box; a
    /// refused one keeps it.
    pub fn written(&mut self, result: Result<Sent, Error>) {
        self.sending = false;
        self.confirming = false;
        let to = self.to.clone().unwrap_or_default();
        self.last = Some(match result {
            Ok(Sent::Sent(_)) => {
                self.content = text_editor::Content::new();
                (true, format!("Sent to {to}."))
            }
            Ok(Sent::Held(_)) => {
                self.content = text_editor::Content::new();
                (true, format!("Not sent to {to}: sending is off (logged)."))
            }
            Err(error) => (false, error.to_string()),
        });
    }

    fn view<'a>(&'a self, ships: &'a [Ship]) -> Element<'a, Message> {
        let names: Vec<String> = ships.iter().map(|s| s.name.clone()).collect();
        let to = pick_list(self.to.clone(), names, String::clone)
            .on_select(|ship| Message::Compose(Compose::To(ship)))
            .placeholder("Ship")
            .padding([4, 8]);

        let ask = checkbox(self.ask)
            .label("Ask for an answer")
            .on_toggle(|ask| Message::Compose(Compose::Ask(ask)))
            .style(theme::checkbox::primary);

        let editor = text_editor(&self.content)
            .placeholder("Write to a ship")
            .on_action(|action| Message::Compose(Compose::Edit(action)))
            .height(Length::Shrink)
            .padding(6);

        let mut actions = row![].spacing(6).align_y(Alignment::Center);
        if self.confirming {
            let to = self.to.as_deref().unwrap_or_default();
            let kind = if self.ask { "a request" } else { "a notice" };
            actions = actions
                .push(
                    text(format!("Send {kind} to {to}?"))
                        .style(theme::text::secondary),
                )
                .push(compose_button(
                    "Send",
                    Compose::Send,
                    true,
                    !self.sending,
                ))
                .push(compose_button("Cancel", Compose::Cancel, false, true));
        } else {
            actions = actions.push(compose_button(
                "Send",
                Compose::Confirm,
                true,
                self.ready() && !self.sending,
            ));
        }
        if let Some((good, line)) = &self.last {
            actions = actions.push(text(line.as_str()).style(if *good {
                theme::text::tertiary
            } else {
                theme::text::error
            }));
        }

        container(
            column![
                row![to, ask].spacing(12).align_y(Alignment::Center),
                editor,
                actions
            ]
            .spacing(6),
        )
        .padding(10)
        .style(theme::container::buffer_title_bar)
        .into()
    }
}

fn compose_button<'a>(
    label: &'a str,
    message: Compose,
    primary: bool,
    enabled: bool,
) -> Element<'a, Message> {
    let mut press =
        button(text(label))
            .padding([4, 12])
            .style(move |theme, status| {
                if primary {
                    theme::button::primary(theme, status, false)
                } else {
                    theme::button::secondary(theme, status, false)
                }
            });
    if enabled {
        press = press.on_press(Message::Compose(message));
    }
    press.into()
}

pub fn view<'a>(
    connection: &'a Connection,
    triage: &'a Triage,
    answering: &'a HashSet<String>,
    composer: &'a Composer,
    theme: &'a Theme,
) -> Element<'a, Message> {
    column![
        conversation(connection, triage, answering, theme),
        composer.view(&connection.ships),
    ]
    .into()
}

fn conversation<'a>(
    connection: &'a Connection,
    triage: &'a Triage,
    answering: &'a HashSet<String>,
    theme: &'a Theme,
) -> Element<'a, Message> {
    let feed = &connection.feed;

    if feed.thread.is_empty() {
        let message = match &feed.error {
            Some(error)
                if error.to_string().contains("unknown captain command") =>
            {
                "This Privateer has no captain.feed yet.".to_owned()
            }
            Some(error) => error.to_string(),
            None => "Reading the conversation...".to_owned(),
        };
        return container(text(message).style(theme::text::secondary))
            .padding(16)
            .center(Length::Fill)
            .into();
    }

    let mut list = Column::new().spacing(14).padding(12);

    if feed.thread.more_older {
        let mut older = button(text("Load older")).padding([4, 12]).style(
            |theme, status| theme::button::secondary(theme, status, false),
        );
        if !feed.reading_older {
            older = older.on_press(Message::LoadOlder);
        }
        list = list.push(container(older).center_x(Length::Fill));
    }
    if let Some(error) = &feed.error {
        list = list.push(
            text(format!("Showing what was read before: {error}"))
                .style(theme::text::error),
        );
    }

    let mut day = None;
    for entry in feed.thread.entries() {
        let when = local(entry.created_ms);
        let date = when.map(|w| w.date_naive());
        if date != day {
            day = date;
            if let Some(when) = when {
                list = list.push(
                    container(
                        text(when.format("%A %-d %B").to_string())
                            .style(theme::text::tertiary),
                    )
                    .center_x(Length::Fill),
                );
            }
        }
        let key = entry.key();
        let panel = answering
            .contains(&key)
            .then(|| answer_panel(&key, connection, triage));
        list = list.push(message_view(
            entry,
            connection.feed.bodies.get(&key),
            panel,
            theme,
        ));
    }

    scrollable(list).anchor_bottom().height(Length::Fill).into()
}

fn message_view<'a>(
    entry: &'a Entry,
    body: Option<&'a data::markdown::Document>,
    panel: Option<Element<'a, Message>>,
    theme: &'a Theme,
) -> Element<'a, Message> {
    let mine = entry.from == "captain";
    let sender: Element<'a, Message> = if mine {
        text(format!("You → {}", entry.to))
            .font(font::MONO_BOLD.clone())
            .into()
    } else {
        text(entry.from.as_str())
            .style(move |theme| theme::text::seeded(theme, &entry.from))
            .into()
    };

    let mut header = row![sender].spacing(8).align_y(Alignment::Center);
    if let Some(label) = state_label(entry) {
        header = header.push(label);
    }
    header = header.push(space().width(Length::Fill)).push(
        text(
            local(entry.created_ms)
                .map(|when| when.format("%H:%M").to_string())
                .unwrap_or_default(),
        )
        .style(theme::text::tertiary),
    );

    let mut content = column![header].spacing(4);
    match body {
        Some(document) => {
            content =
                content.push(markdown(document, theme, Message::OpenLink));
        }
        None => content = content.push(text(entry.body.as_str())),
    }
    let takes_comments = entry.is_open_ask() || entry.is_unread_notice();
    if let Some(opened) = reports::Opened::from_mail(
        &entry.from,
        &entry.id,
        takes_comments,
        &entry.payload,
    ) {
        content = content.push(
            button(text(format!("Open report: {}", opened.attached.title())))
                .padding([4, 12])
                .style(|theme, status| {
                    theme::button::secondary(theme, status, false)
                })
                .on_press(Message::OpenReport(opened)),
        );
    }
    if entry.is_open_ask() {
        let open = panel.is_some();
        content = content.push(
            button(text(if open { "Hide" } else { "Answer" }))
                .padding([4, 12])
                .style(move |theme, status| {
                    if open {
                        theme::button::secondary(theme, status, false)
                    } else {
                        theme::button::primary(theme, status, false)
                    }
                })
                .on_press(Message::Answer(entry.key())),
        );
        if let Some(panel) = panel {
            content = content.push(panel);
        }
    }

    // The captain's own messages sit indented, as a reply does in a chat.
    let padding = if mine {
        Padding::default().left(32)
    } else {
        Padding::default()
    };
    container(content).padding(padding).into()
}

/// The answer controls under an ask. An ask that is open in the Feed but
/// not yet in Privateer's list of what waits on the captain cannot be
/// answered until the next poll.
fn answer_panel<'a>(
    key: &str,
    connection: &'a Connection,
    triage: &'a Triage,
) -> Element<'a, Message> {
    match triage.answer_panel(key, connection) {
        Some(panel) => container(panel.map(Message::Triage))
            .padding([6, 0])
            .into(),
        None => text("This ask is not in the list of what waits on you yet; it will be after the next check.")
            .style(theme::text::tertiary)
            .into(),
    }
}

/// What became of an ask; nothing for a notice or a reply.
fn state_label<'a>(entry: &'a Entry) -> Option<Element<'a, Message>> {
    if !matches!(entry.kind.as_str(), "request" | "decision") {
        return None;
    }
    let label = match entry.state.as_deref() {
        Some("open") => {
            return Some(
                text(format!("{}, waiting on you", entry.kind))
                    .style(theme::text::error)
                    .into(),
            );
        }
        Some("answered") => "answered",
        Some("dismissed") => "dismissed",
        Some(other) => other,
        None => return None,
    };
    Some(text(label).style(theme::text::tertiary).into())
}

fn local(ms: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(ms).single()
}
