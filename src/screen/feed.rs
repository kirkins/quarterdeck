//! The Feed: one conversation with every ship, oldest at the top. Asks show
//! their state; an open one is answered in Triage, the one answer path.

use std::collections::HashSet;
use std::path::PathBuf;

use chrono::{DateTime, Local, TimeZone};
use data::attachment::{self, Attachment};
use data::feed::{Entry, Scope};
use data::feed_mark;
use data::privateer::{Error, Sent};
use data::ships::Ship;
use iced::widget::{
    Row, button, checkbox, column, container, image, pick_list, row,
    scrollable, space, text_editor,
};
use iced::{Alignment, Length, Padding, Task};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{self, Connection, Which};
use crate::font;
use crate::icon;
use crate::screen::reports;
use crate::screen::triage::{self, Triage};
use crate::widget::{Column, Element, loading, markdown, text};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub enum Message {
    RefreshShips,
    LoadOlder,
    /// The Feed was scrolled: whether the captain is at its newest message.
    Scrolled(scrollable::Viewport),
    /// Scroll to the newest message, from the "N new messages" pill.
    ToNewest,
    /// Show only the open items, asked of Privateer over the whole history.
    OnlyWaiting(bool),
    /// Narrow the Feed to one ship, or to every ship with `None`.
    ShipFilter(Option<String>),
    /// Show the mail between ships too, in the Feed or a ship's own.
    ShipMail(bool),
    /// Show or hide the answer controls under an open ask, by its key.
    Answer(String),
    OpenLink(String),
    /// Answering in place, through Triage's one answer path.
    Triage(triage::Message),
    Compose(Compose),
    OpenReport(reports::Opened),
    /// Open a ship's own conversation, by its name.
    OpenShip(String),
}

/// Writing to a ship.
#[derive(Debug, Clone)]
pub enum Compose {
    To(String),
    Edit(text_editor::Action),
    /// Whether the message asks for an answer (a request) or tells (a
    /// notice).
    Ask(bool),
    /// Pick files to send with the message.
    Attach,
    /// Files picked or dropped onto the window.
    Attached(Vec<PathBuf>),
    Detach(usize),
    Confirm,
    Cancel,
    Send,
}

/// What the composer asks of the app.
pub enum Out {
    Write(&'static str, Value),
    /// Open the file picker.
    Pick,
}

/// The write key for the composer's message, beside the asks' keys.
pub const COMPOSE_KEY: &str = "compose";

/// The message being written.
#[derive(Default)]
pub struct Composer {
    to: Option<String>,
    content: text_editor::Content,
    ask: bool,
    /// Files to send with the message, copied when it is sent.
    attachments: Vec<Attachment>,
    confirming: bool,
    sending: bool,
    /// What became of the last message, and whether that was good.
    last: Option<(bool, String)>,
}

impl Composer {
    /// A write to run, when the captain sends, or the picker to open.
    /// `fleet` says where the ship runs, which files need.
    pub fn update(
        &mut self,
        message: Compose,
        connection: &Connection,
    ) -> Option<Out> {
        match message {
            Compose::To(ship) => {
                self.to = Some(ship);
                self.confirming = false;
            }
            Compose::Edit(action) => {
                self.content.perform(action);
                self.confirming = false;
            }
            Compose::Ask(ask) => self.ask = ask,
            Compose::Attach => return Some(Out::Pick),
            Compose::Attached(paths) => self.attach(paths),
            Compose::Detach(index) => {
                if index < self.attachments.len() {
                    self.attachments.remove(index);
                }
                self.confirming = false;
            }
            Compose::Confirm => self.confirming = self.ready(connection),
            Compose::Cancel => self.confirming = false,
            Compose::Send => {
                if !self.ready(connection) || self.sending {
                    return None;
                }
                let to = self.to.clone()?;
                let kept = match attachment::keep(
                    &self.attachments,
                    &attachment::dir(),
                    &Local::now().format("%Y%m%d-%H%M%S").to_string(),
                ) {
                    Ok(kept) => kept,
                    Err(error) => {
                        self.confirming = false;
                        self.last = Some((false, error));
                        return None;
                    }
                };
                self.sending = true;
                self.last = None;
                let args = json!({
                    "to": to,
                    "kind": if self.ask { "request" } else { "notice" },
                    "body": attachment::body_with(&self.content.text(), &kept),
                });
                return Some(Out::Write("captain.send", args));
            }
        }
        None
    }

    /// Add files, each once, up to the most one message takes. Those that
    /// cannot be sent are said why.
    fn attach(&mut self, paths: Vec<PathBuf>) {
        if paths.is_empty() {
            return;
        }
        let mut problems = Vec::new();
        for path in paths {
            if self.attachments.iter().any(|a| a.path == path) {
                continue;
            }
            if self.attachments.len() >= attachment::MAX_FILES {
                problems.push(format!(
                    "a message takes at most {} files",
                    attachment::MAX_FILES
                ));
                break;
            }
            match Attachment::at(&path) {
                Ok(file) => self.attachments.push(file),
                Err(problem) => problems.push(problem),
            }
        }
        self.confirming = false;
        self.last =
            (!problems.is_empty()).then(|| (false, problems.join("; ")));
    }

    /// Whether files wait to be sent.
    pub fn has_attachments(&self) -> bool {
        !self.attachments.is_empty()
    }

    /// Write to this ship. Files picked for another ship are put down.
    pub fn address(&mut self, ship: &str) {
        if self.to.as_deref() != Some(ship) {
            self.to = Some(ship.to_owned());
            self.attachments.clear();
            self.confirming = false;
            self.last = None;
        }
    }

    fn ready(&self, connection: &Connection) -> bool {
        let Some(to) = &self.to else {
            return false;
        };
        if connection.ships_read_ms.is_none()
            || !connection.ships.iter().any(|ship| ship.name == *to)
        {
            return false;
        }
        if self.attachments.is_empty() {
            !self.content.text().trim().is_empty()
        } else {
            attachment::reach(to, connection.fleet.snapshot.as_ref())
                == attachment::Reach::Here
        }
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
                self.attachments.clear();
                (true, format!("Sent to {to}."))
            }
            Ok(Sent::Held(_)) => {
                self.content = text_editor::Content::new();
                self.attachments.clear();
                (true, format!("Not sent to {to}: sending is off (logged)."))
            }
            Err(error) => (false, error.to_string()),
        });
    }

    /// The composer; with `ships`, a pick of whom to write to, else it
    /// writes to the ship it was addressed to.
    pub fn view<'a>(
        &'a self,
        ships: Option<&'a [Ship]>,
        connection: &'a Connection,
    ) -> Element<'a, Message> {
        let to: Element<'a, Message> = match ships {
            Some(ships) => {
                let names: Vec<String> =
                    ships.iter().map(|s| s.name.clone()).collect();
                pick_list(self.to.clone(), names, String::clone)
                    .on_select(|ship| Message::Compose(Compose::To(ship)))
                    .placeholder("Ship")
                    .padding([4, 8])
                    .into()
            }
            None => {
                text(format!("To {}", self.to.as_deref().unwrap_or_default()))
                    .style(theme::text::secondary)
                    .into()
            }
        };

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
                    self.ready(connection) && !self.sending,
                ))
                .push(compose_button("Cancel", Compose::Cancel, false, true));
        } else {
            actions = actions.push(compose_button(
                "Send",
                Compose::Confirm,
                true,
                self.ready(connection) && !self.sending,
            ));
        }
        if let Some((good, line)) = &self.last {
            actions = actions.push(text(line.as_str()).style(if *good {
                theme::text::tertiary
            } else {
                theme::text::error
            }));
        }

        let attach = compose_button("Attach", Compose::Attach, false, true);
        let mut body = column![
            row![to, ask, space::horizontal(), attach]
                .spacing(12)
                .align_y(Alignment::Center),
            editor,
        ]
        .spacing(6);
        if connection.ships_read_ms.is_some()
            && self.to.as_ref().is_some_and(|to| {
                !connection.ships.iter().any(|s| s.name == *to)
            })
        {
            body = body.push(text("This destination is no longer in the ship list. Choose a ship before sending.").style(theme::text::error));
        }
        if !self.attachments.is_empty() {
            body = body.push(
                Row::with_children(
                    self.attachments
                        .iter()
                        .enumerate()
                        .map(|(i, file)| attachment_chip(i, file)),
                )
                .spacing(6)
                .wrap(),
            );
            if let Some(problem) = self.to.as_deref().and_then(|to| {
                attachment::reach(to, connection.fleet.snapshot.as_ref())
                    .problem(to)
            }) {
                body = body.push(text(problem).style(theme::text::tertiary));
            }
        }

        container(body.push(actions))
            .padding(10)
            .style(theme::container::buffer_title_bar)
            .into()
    }
}

/// A file waiting to be sent: a thumbnail for an image, its name and size,
/// and a way to take it off.
fn attachment_chip<'a>(
    index: usize,
    file: &'a Attachment,
) -> Element<'a, Message> {
    let mut chip = row![].spacing(6).align_y(Alignment::Center);
    if file.is_image() && file.thumbnail() {
        chip = chip.push(
            image(image::Handle::from_path(&file.path))
                .height(40)
                .content_fit(iced::ContentFit::Contain),
        );
    }
    chip = chip
        .push(text(file.name.as_str()))
        .push(text(attachment::size(file.bytes)).style(theme::text::tertiary))
        .push(
            button(text("✕"))
                .padding([0, 6])
                .style(|theme, status| {
                    theme::button::secondary(theme, status, false)
                })
                .on_press(Message::Compose(Compose::Detach(index))),
        );
    container(chip)
        .padding([4, 8])
        .style(|theme| theme::container::buffer(theme, false))
        .into()
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

/// Where the captain is in the Feed: the mark it was last read to, and
/// whether the captain has scrolled up from the newest message.
pub struct Reading {
    key: String,
    /// The mark when the Feed was opened: the Unread divider sits above the
    /// first newer message and stays for this visit.
    pub mark: Option<i64>,
    /// The mark as saved, so the file is written only when it moves.
    saved: Option<i64>,
    /// Scrolled up: the newest message's time when the captain left the
    /// bottom. Messages newer than it are counted in the pill.
    away: Option<i64>,
}

impl Reading {
    /// The Feed of a scope, with the mark it was last read to.
    pub fn of(scope: &Scope) -> Self {
        let key = feed_mark::key(scope);
        let mark = feed_mark::load(&feed_mark::path(), &key);
        Self {
            key,
            mark,
            saved: mark,
            away: None,
        }
    }

    /// The Feed was scrolled. At its bottom the captain has read to the
    /// newest message; above it, what comes next is new.
    pub fn scrolled(
        &mut self,
        view: &scrollable::Viewport,
        newest: Option<i64>,
    ) {
        let bounds = view.bounds();
        let content = view.content_bounds();
        let to_bottom =
            content.height - bounds.height - view.absolute_offset().y;
        if to_bottom <= 1.0 {
            self.away = None;
            self.seen(newest);
        } else if self.away.is_none() {
            self.away = Some(newest.unwrap_or(i64::MIN));
        }
    }

    /// Save the newest message as read, while the captain is at the bottom.
    pub fn seen(&mut self, newest: Option<i64>) {
        if self.away.is_some() {
            return;
        }
        let Some(at) = newest else {
            return;
        };
        if self.saved.is_some_and(|saved| at <= saved) {
            return;
        }
        match feed_mark::save(&feed_mark::path(), &self.key, at) {
            Ok(()) => self.saved = Some(at),
            Err(error) => log::warn!("could not save the Feed mark: {error}"),
        }
    }

    /// How many messages the pill counts, while the captain is scrolled up.
    fn pill(&self, created: impl IntoIterator<Item = i64>) -> Option<usize> {
        let away = self.away?;
        let count = feed_mark::newer(created, away);
        (count > 0).then_some(count)
    }
}

/// The Feed's scroll, by its id, so it can be moved to the newest message.
fn scroll_id() -> iced::widget::Id {
    iced::widget::Id::new("feed")
}

/// Scroll the Feed to its newest message.
pub fn to_newest<T: Send + 'static>() -> Task<T> {
    iced::widget::operation::snap_to_end(scroll_id())
}

/// The newest message's time in the Feed, or None while nothing is read.
pub fn newest(connection: &Connection) -> Option<i64> {
    connection
        .feed(Which::All)
        .thread
        .entries()
        .map(|entry| entry.created_ms)
        .max()
}

/// The ship picker's first choice: every ship.
const ALL_SHIPS: &str = "All ships";

pub fn view<'a>(
    connection: &'a Connection,
    triage: &'a Triage,
    answering: &'a HashSet<String>,
    composer: &'a Composer,
    reading: &'a Reading,
    theme: &'a Theme,
) -> Element<'a, Message> {
    let feed = connection.feed(Which::All);
    let (ship, ship_mail) = feed
        .scope
        .as_ref()
        .map_or((None, false), |scope| (scope.ship.clone(), scope.ship_mail));

    let names: Vec<String> = std::iter::once(ALL_SHIPS.to_owned())
        .chain(connection.ships.iter().map(|ship| ship.name.clone()))
        .collect();
    let picked = ship.unwrap_or_else(|| ALL_SHIPS.to_owned());
    let ship_pick = pick_list(Some(picked), names, String::clone)
        .on_select(|name| {
            Message::ShipFilter((name != ALL_SHIPS).then_some(name))
        })
        .padding([4, 8]);
    let mail = checkbox(ship_mail)
        .label("Ship-to-ship mail")
        .on_toggle(Message::ShipMail)
        .style(theme::checkbox::primary);
    let only_waiting = checkbox(feed.open_only)
        .label("Only waiting on me")
        .on_toggle(Message::OnlyWaiting)
        .style(theme::checkbox::primary);
    let thread = conversation(
        connection,
        Which::All,
        triage,
        answering,
        reading.mark,
        theme,
    );
    let newer = reading.pill(
        connection
            .feed(Which::All)
            .thread
            .entries()
            .map(|entry| entry.created_ms),
    );
    let mut page = column![
        container(
            column![
                row![ship_pick, mail, only_waiting]
                    .spacing(12)
                    .align_y(Alignment::Center),
                ships_status(connection),
            ]
            .spacing(6)
        )
        .padding([4, 12]),
        thread,
    ];
    if let Some(count) = newer {
        page = page.push(new_messages(count));
    }
    page.push(composer.view(Some(&connection.ships), connection))
        .into()
}

/// Roster freshness and failures stay beside the ship controls. The last
/// good list remains usable while a refresh is in flight or has failed.
pub fn ships_status(connection: &Connection) -> Element<'_, Message> {
    let line = match (&connection.ships_error, connection.ships_read_ms) {
        (Some(error), Some(at)) => format!(
            "Ship refresh failed: {error}. Showing list from {}.",
            triage::ago(connection::now_ms() - at)
        ),
        (Some(error), None) => format!("Could not read ships: {error}"),
        (None, Some(at)) => format!(
            "{} ships · checked {}",
            connection.ships.len(),
            triage::ago(connection::now_ms() - at)
        ),
        (None, None) => "Reading ships…".into(),
    };
    let refresh = button(text(if connection.ships_refreshing() {
        "Refreshing…"
    } else {
        "Refresh ships"
    }))
    .padding([3, 8])
    .style(|theme, status| theme::button::secondary(theme, status, false))
    .on_press_maybe(
        (!connection.ships_refreshing()).then_some(Message::RefreshShips),
    );
    column![
        text(line).style(if connection.ships_error.is_some() {
            theme::text::error
        } else {
            theme::text::tertiary
        }),
        refresh,
    ]
    .spacing(4)
    .into()
}

#[cfg(test)]
mod composer_tests {
    use super::*;

    #[test]
    fn removing_a_destination_blocks_send_and_preserves_the_message() {
        let mut connection =
            Connection::new(&data::config::Privateer::default());
        let mut composer = Composer {
            to: Some("test".into()),
            content: text_editor::Content::with_text("Keep my message"),
            ..Composer::default()
        };
        assert!(!composer.ready(&connection));
        drop(connection.update(connection::Message::Ships(
            0,
            Ok(vec![Ship {
                name: "test".into(),
                ..Ship::default()
            }]),
        )));
        assert!(composer.ready(&connection));
        composer.update(Compose::Confirm, &connection);
        assert!(composer.confirming);
        // A failed refresh keeps a known destination usable.
        drop(connection.update(connection::Message::Ships(
            0,
            Err(Error::NotConfigured("offline".into())),
        )));
        assert!(composer.ready(&connection));
        drop(connection.update(connection::Message::Ships(0, Ok(vec![]))));
        assert!(!composer.ready(&connection));
        assert!(composer.update(Compose::Send, &connection).is_none());
        assert_eq!(composer.content.text(), "Keep my message");
        assert_eq!(composer.to.as_deref(), Some("test"));
        assert!(!composer.sending);
    }
}

/// The "N new messages" pill, which scrolls the Feed to its newest message.
fn new_messages<'a>(count: usize) -> Element<'a, Message> {
    let words = if count == 1 {
        "1 new message".to_owned()
    } else {
        format!("{count} new messages")
    };
    let pill = button(
        row![icon::scroll_to_bottom(), text(words)]
            .spacing(6)
            .align_y(Alignment::Center),
    )
    .padding([4, 12])
    .style(|theme, status| theme::button::primary(theme, status, false))
    .on_press(Message::ToNewest);
    container(pill)
        .center_x(Length::Fill)
        .padding([0, 12])
        .into()
}

/// A conversation, oldest at the top: the whole history, or one ship's. With
/// `unread`, the Unread divider sits above the first message newer than it.
pub fn conversation<'a>(
    connection: &'a Connection,
    which: Which,
    triage: &'a Triage,
    answering: &'a HashSet<String>,
    unread: Option<i64>,
    theme: &'a Theme,
) -> Element<'a, Message> {
    let feed = connection.feed(which);

    if feed.thread.is_empty() {
        if feed.loading() {
            return loading("Reading the conversation");
        }
        let message = match &feed.error {
            Some(error)
                if error.to_string().contains("unknown captain command") =>
            {
                "This Privateer has no captain.feed yet.".to_owned()
            }
            Some(error) => error.to_string(),
            None if feed.open_only => "Nothing is waiting on you.".to_owned(),
            None if which == Which::All => "No messages yet.".to_owned(),
            None => "No messages with this ship yet.".to_owned(),
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

    let replies = feed.thread.replies();
    let now = connection::now_ms();
    let created: Vec<i64> = feed
        .thread
        .entries()
        .map(|entry| entry.created_ms)
        .collect();
    let divider = feed_mark::divider(&created, unread);
    let mut day = None;
    for (index, entry) in feed.thread.entries().enumerate() {
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
        if divider == Some(index) {
            list = list.push(
                container(
                    text("Unread").style(theme::text::highlight_indicator),
                )
                .center_x(Length::Fill),
            );
        }
        let key = entry.key();
        let sent = triage.sent(&key);
        let asked = entry
            .correlation
            .as_ref()
            .and_then(|ask| feed.thread.get(&format!("{}/{ask}", entry.to)));
        let notes =
            Notes::of(entry, replies.get(&key).copied(), asked, sent, now);
        let panel = (answering.contains(&key) && !sent)
            .then(|| answer_panel(&key, connection, triage));
        let mark = awaits_read(entry)
            .then(|| triage.mark_panel(&key, &entry.id).map(Message::Triage));
        list = list.push(message_view(
            entry,
            feed.bodies.get(&key),
            notes,
            panel,
            mark,
            theme,
        ));
    }

    let list = scrollable(list).anchor_bottom().height(Length::Fill);
    // Only the Feed is followed: a ship's conversation has no pill or mark.
    if which == Which::All {
        list.id(scroll_id()).on_scroll(Message::Scrolled).into()
    } else {
        list.into()
    }
}

/// What the feed says about a message beside its body.
#[derive(Default)]
struct Notes {
    /// An answer was sent from here, so the ask is closed in place.
    sent: bool,
    /// What became of a closed ask, or of a notice marked read.
    outcome: Option<String>,
    /// "N comments on <title>", for a message that carries comments.
    comments: Option<String>,
    /// The captain's own words with its comments, in place of the body.
    note: Option<String>,
}

impl Notes {
    fn of(
        entry: &Entry,
        reply: Option<&Entry>,
        asked: Option<&Entry>,
        sent: bool,
        now: i64,
    ) -> Self {
        let comments = entry.comments_line(asked);
        Self {
            sent,
            outcome: entry
                .outcome(reply, now)
                .filter(|_| !(sent && entry.is_open_ask())),
            note: comments.as_ref().and_then(|_| entry.captain_note()),
            comments,
        }
    }
}

/// A notice to the captain nobody has marked read.
fn awaits_read(entry: &Entry) -> bool {
    entry.to == "captain" && entry.is_unread_notice()
}

fn message_view<'a>(
    entry: &'a Entry,
    body: Option<&'a data::markdown::Document>,
    notes: Notes,
    panel: Option<Element<'a, Message>>,
    mark: Option<Element<'a, Message>>,
    theme: &'a Theme,
) -> Element<'a, Message> {
    let mine = entry.from == "captain";
    let mut header = row![].spacing(8).align_y(Alignment::Center);
    if mine {
        header = header
            .push(text("You →").font(font::MONO_BOLD.clone()))
            .push(ship_name(&entry.to));
    } else {
        header = header.push(ship_name(&entry.from));
        // Mail between ships, shown in a ship's own conversation.
        if entry.to != "captain" {
            header = header
                .push(text("→").style(theme::text::tertiary))
                .push(ship_name(&entry.to));
        }
    }
    if awaits_read(entry) {
        header =
            header.push(text("Unread").style(theme::text::highlight_indicator));
    }
    if let Some(label) = state_label(entry, &notes) {
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
    match (notes.comments, notes.note) {
        (Some(comments), note) => {
            content =
                content.push(text(comments).style(theme::text::secondary));
            if let Some(note) = note {
                content = content.push(text(note));
            }
        }
        (None, _) => match body {
            Some(document) => {
                content =
                    content.push(markdown(document, theme, Message::OpenLink));
            }
            None => content = content.push(text(entry.body.clone())),
        },
    }
    let takes_comments = entry.is_open_ask() || entry.is_unread_notice();
    if let Some(opened) = reports::Opened::from_mail(
        &entry.from,
        &entry.id,
        &entry.kind,
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
    if entry.is_open_ask() && !notes.sent {
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
    if let Some(mark) = mark {
        content = content.push(mark);
    }

    // The captain's own messages sit indented, as a reply does in a chat.
    let padding = if mine {
        Padding::default().left(32)
    } else {
        Padding::default()
    };
    container(content).padding(padding).into()
}

/// A ship's name, in its colour, that opens its own conversation.
pub fn ship_name<'a>(ship: &'a str) -> Element<'a, Message> {
    button(
        text(ship)
            .font(font::MONO_BOLD.clone())
            .style(move |theme| theme::text::seeded(theme, ship)),
    )
    .padding(0)
    .style(theme::button::bare)
    .on_press(Message::OpenShip(ship.to_owned()))
    .into()
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

/// Where an ask stands, or what became of a closed one; nothing for a
/// plain message that nothing happened to.
fn state_label<'a>(
    entry: &'a Entry,
    notes: &Notes,
) -> Option<Element<'a, Message>> {
    if entry.is_open_ask() {
        return Some(if notes.sent {
            text(format!("Answer sent to {}", entry.ship()))
                .style(theme::text::success)
                .into()
        } else {
            text(format!("{}, waiting on you", entry.kind))
                .style(theme::text::error)
                .into()
        });
    }
    notes
        .outcome
        .as_ref()
        .map(|words| text(words.clone()).style(theme::text::tertiary).into())
}

fn local(ms: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(ms).single()
}
