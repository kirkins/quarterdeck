//! Triage: everything that waits on the captain, in sections, with each ask
//! answered or dismissed in place.
//!
//! Answering takes two deliberate steps: choose (an option, or your own
//! words), then confirm. A dismissal has its own confirm step. Every write
//! goes through the connection's one guarded path.

use std::collections::{HashMap, HashSet};

use data::captain::Item;
use data::choices;
use data::decision::{self, Answer, Choice};
use data::privateer::{Error, Sent};
use data::triage::{self, Section};
use iced::widget::{
    button, checkbox, column, container, row, scrollable, space, text_input,
};
use iced::{Border, Length};
use serde_json::Value;

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{self, Connection, Details};
use crate::screen::reports;
use crate::widget::{Column, Element, markdown, text};
use crate::{font, icon};

#[derive(Debug, Clone)]
pub enum Message {
    Expand(String),
    Choose(String, String),
    OwnWords(String),
    Text(String, String),
    /// Tick or untick a choice written into a request, by its marker.
    Tick(String, String),
    Confirm(String),
    Back(String),
    Send(String),
    Done(String),
    StartDismiss(String),
    Note(String, String),
    SendDismiss(String),
    OpenLink(String),
    OpenReport(reports::Opened),
}

pub enum Event {
    /// Run a write for the ask `key`.
    Write {
        key: String,
        command: &'static str,
        args: Value,
    },
    OpenLink(String),
    OpenReport(reports::Opened),
}

/// The captain's answer so far to one ask.
#[derive(Debug, Default, Clone)]
struct Draft {
    choice: Option<String>,
    own_words: bool,
    text: String,
    confirming: bool,
    dismissing: bool,
    note: String,
    /// Ticked choices of a plain request, by marker.
    ticked: HashSet<String>,
}

#[derive(Debug, Clone)]
enum Outcome {
    Sending,
    Sent,
    /// Sending is off: logged, not sent.
    Held,
    Failed(String),
}

#[derive(Default)]
pub struct Triage {
    /// Asks shown the other way from their default: decisions start open,
    /// other asks start as one line.
    toggled: HashSet<String>,
    drafts: HashMap<String, Draft>,
    outcomes: HashMap<String, Outcome>,
}

impl Triage {
    pub fn update(
        &mut self,
        message: Message,
        connection: &Connection,
    ) -> Option<Event> {
        match message {
            Message::Expand(key) => {
                if !self.toggled.remove(&key) {
                    self.toggled.insert(key);
                }
                None
            }
            Message::Choose(key, option) => {
                let draft = self.drafts.entry(key).or_default();
                draft.choice = Some(option);
                draft.own_words = false;
                draft.confirming = false;
                None
            }
            Message::OwnWords(key) => {
                let draft = self.drafts.entry(key).or_default();
                draft.own_words = true;
                draft.choice = None;
                draft.confirming = false;
                None
            }
            Message::Tick(key, marker) => {
                let draft = self.drafts.entry(key).or_default();
                if !draft.ticked.remove(&marker) {
                    draft.ticked.insert(marker);
                }
                draft.confirming = false;
                None
            }
            Message::Text(key, value) => {
                self.drafts.entry(key).or_default().text = value;
                None
            }
            Message::Confirm(key) => {
                let draft = self.drafts.entry(key).or_default();
                draft.confirming = true;
                None
            }
            Message::Back(key) => {
                let draft = self.drafts.entry(key).or_default();
                draft.confirming = false;
                draft.dismissing = false;
                None
            }
            Message::Send(key) => {
                let (item, details) = find(connection, &key)?;
                let draft = self.drafts.get(&key)?;
                let args = reply(item, details, draft);
                self.write(key, "captain.reply", args)
            }
            Message::Done(key) => {
                let (item, _) = find(connection, &key)?;
                let args = decision::plain_reply_args(&item.mail.id, "Done.");
                self.write(key, "captain.reply", args)
            }
            Message::StartDismiss(key) => {
                let draft = self.drafts.entry(key).or_default();
                draft.dismissing = true;
                draft.confirming = false;
                None
            }
            Message::Note(key, value) => {
                self.drafts.entry(key).or_default().note = value;
                None
            }
            Message::SendDismiss(key) => {
                let (item, _) = find(connection, &key)?;
                let note = self.drafts.get(&key).map(|d| d.note.clone());
                let args = Ok(decision::dismiss_args(
                    &item.mail.id,
                    note.as_deref().unwrap_or_default(),
                ));
                self.write(key, "captain.dismiss", args)
            }
            Message::OpenLink(url) => Some(Event::OpenLink(url)),
            Message::OpenReport(opened) => Some(Event::OpenReport(opened)),
        }
    }

    fn write(
        &mut self,
        key: String,
        command: &'static str,
        args: Result<Value, String>,
    ) -> Option<Event> {
        if matches!(self.outcomes.get(&key), Some(Outcome::Sending)) {
            return None;
        }
        match args {
            Ok(args) => {
                self.outcomes.insert(key.clone(), Outcome::Sending);
                Some(Event::Write { key, command, args })
            }
            Err(problem) => {
                self.outcomes.insert(key, Outcome::Failed(problem));
                None
            }
        }
    }

    /// What became of a write. A sent answer leaves the list on the next
    /// poll; a refused one keeps the draft so nothing typed is lost.
    pub fn written(&mut self, key: String, result: Result<Sent, Error>) {
        let outcome = match result {
            Ok(Sent::Sent(_)) => {
                self.drafts.remove(&key);
                Outcome::Sent
            }
            Ok(Sent::Held(_)) => {
                self.drafts.remove(&key);
                Outcome::Held
            }
            Err(error) => {
                if let Some(draft) = self.drafts.get_mut(&key) {
                    draft.confirming = false;
                    draft.dismissing = false;
                }
                Outcome::Failed(error.to_string())
            }
        };
        self.outcomes.insert(key, outcome);
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let Some(waiting) = &connection.waiting else {
            let message = match &connection.error {
                Some(error) => error.to_string(),
                None if connection.is_loading() => "Asking Privateer...".into(),
                None => "Not asked yet.".into(),
            };
            return container(text(message).style(
                if connection.error.is_some() {
                    theme::text::error
                } else {
                    theme::text::secondary
                },
            ))
            .padding(16)
            .center(Length::Fill)
            .max_width(480)
            .into();
        };

        let mut list = Column::new().spacing(14);

        if !connection.sends() {
            list = list.push(
                text(
                    "Sending is off: answers are logged, not sent. Set \
                     allow_send = true under [privateer] in config.toml.",
                )
                .style(theme::text::tertiary),
            );
        }
        if let Some(error) = &connection.error {
            list = list.push(
                text(format!("Showing the last answer: {error}"))
                    .style(theme::text::error),
            );
        }
        if waiting.waiting.is_empty() {
            list = list.push(
                text("Nothing waits on you.").style(theme::text::secondary),
            );
        }

        let now = connection::now_ms();
        for (section, items) in triage::sections(&waiting.waiting, now) {
            list = list.push(section_title(section, items.len()));
            for item in items {
                let key = triage::key(item);
                let details = connection.details.get(&key);
                let decision =
                    details.is_some_and(|d| !d.card.options.is_empty());
                let open = decision != self.toggled.contains(&key);
                list =
                    list.push(self.item_view(key, item, details, open, theme));
            }
        }

        scrollable(container(list).padding(12))
            .height(Length::Fill)
            .into()
    }

    /// The answer controls for one open ask, without the ask itself: for a
    /// view that already shows it, such as the Feed. None when Privateer's
    /// list of what waits on the captain does not hold the ask.
    pub fn answer_panel<'a>(
        &'a self,
        key: &str,
        connection: &'a Connection,
    ) -> Option<Element<'a, Message>> {
        let (item, details) = find(connection, key)?;
        let draft = self.drafts.get(key).cloned().unwrap_or_default();
        let outcome = self.outcomes.get(key);
        let mut panel = Column::new().spacing(8);
        if let Some(outcome) = outcome {
            panel = panel.push(outcome_label(outcome));
            if matches!(outcome, Outcome::Sent | Outcome::Held) {
                return Some(panel.into());
            }
        }
        if let Some(split) = &details.choices {
            panel = panel.push(ticks(key, split, &draft));
        }
        panel = panel.push(self.answer_view(key, item, details, &draft));
        if let Some(Outcome::Failed(problem)) = outcome {
            panel =
                panel.push(text(problem.as_str()).style(theme::text::error));
        }
        Some(panel.into())
    }

    fn item_view<'a>(
        &'a self,
        key: String,
        item: &'a Item,
        details: Option<&'a Details>,
        open: bool,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let outcome = self.outcomes.get(&key);
        let kind = if item.step.is_some() {
            text("needs your hands").style(theme::text::error)
        } else {
            text(item.mail.kind.as_str()).style(theme::text::tertiary)
        };
        let mut header = row![
            text(item.asker())
                .style(move |theme| theme::text::seeded(theme, item.asker())),
            kind,
        ]
        .spacing(8);
        if let Some(outcome) = outcome {
            header = header.push(outcome_label(outcome));
        }
        header = header
            .push(space().width(Length::Fill))
            .push(text(due(item)).style(theme::text::tertiary));

        let header = button(header)
            .padding(0)
            .style(theme::button::bare)
            .on_press(Message::Expand(key.clone()));

        let (Some(details), true) = (details, open) else {
            // A decision leads with its question; any other ask with how it
            // starts, since its last question alone ("OK?") says nothing.
            let summary = match details {
                Some(d) if !d.card.options.is_empty() => {
                    preview(&d.card.question, 180)
                }
                _ => preview(&item.mail.body, 180),
            };
            let mut lines =
                column![text(summary).style(theme::text::primary)].spacing(2);
            if let Some(choice) = details
                .and_then(|d| d.card.options.iter().find(|c| c.recommended))
            {
                lines = lines.push(
                    row![
                        icon::star().style(theme::text::success),
                        text(format!("Recommended: {}", choice.label))
                            .style(theme::text::secondary),
                    ]
                    .spacing(4),
                );
            }
            return column![
                header,
                button(lines)
                    .padding(0)
                    .style(theme::button::bare)
                    .on_press(Message::Expand(key)),
            ]
            .spacing(2)
            .into();
        };

        let draft = self.drafts.get(&key).cloned().unwrap_or_default();
        let mut body = Column::new().spacing(10).push(header);

        if let Some(split) = &details.choices {
            body = body
                .push(markdown(&split.before, theme, Message::OpenLink))
                .push(ticks(&key, split, &draft))
                .push(markdown(&split.after, theme, Message::OpenLink));
        } else if details.card.options.is_empty() {
            body = body.push(markdown(&details.body, theme, Message::OpenLink));
        } else {
            body = body.push(
                text(details.card.question.as_str())
                    .size(theme::TEXT_SIZE + 2.0)
                    .font(font::MONO_BOLD.clone()),
            );
            if let Some(why) = &details.why {
                body = body.push(markdown(why, theme, Message::OpenLink));
            }
        }
        if !details.card.blocked.is_empty() {
            body = body.push(
                text(format!(
                    "Waiting on this: {}",
                    details.card.blocked.join(", ")
                ))
                .style(theme::text::secondary),
            );
        }
        if !details.card.problems.is_empty() {
            body = body.push(
                text(format!(
                    "This ask did not read as a decision ({}), so answer it in words.",
                    details.card.problems.join("; ")
                ))
                .style(theme::text::tertiary),
            );
        }
        if let Some(opened) = reports::Opened::from_mail(
            &item.mail.from,
            &item.mail.id,
            true,
            &item.mail.payload,
        ) {
            body = body.push(
                button(text(format!(
                    "Open report: {}",
                    opened.attached.title()
                )))
                .padding([4, 12])
                .style(|theme, status| {
                    theme::button::secondary(theme, status, false)
                })
                .on_press(Message::OpenReport(opened)),
            );
        }
        if let Some(step) = &item.step {
            body = body.push(
                container(
                    column![
                        text("Only you can do this:")
                            .style(theme::text::secondary),
                        text(step.as_str()),
                    ]
                    .spacing(4),
                )
                .padding(10)
                .width(Length::Fill)
                .style(|theme| theme::container::buffer(theme, false)),
            );
        }

        if let Some(Outcome::Sent | Outcome::Held) = outcome {
            return container(body).padding([4, 0]).into();
        }

        body = body.push(self.answer_view(&key, item, details, &draft));
        if let Some(Outcome::Failed(problem)) = outcome {
            body = body.push(text(problem.as_str()).style(theme::text::error));
        }

        container(body).padding([4, 0]).into()
    }

    fn answer_view<'a>(
        &'a self,
        key: &str,
        item: &'a Item,
        details: &'a Details,
        draft: &Draft,
    ) -> Element<'a, Message> {
        let key = key.to_owned();
        let card = &details.card;

        if draft.dismissing {
            return column![
                text_input("A note for the ship (optional)", &draft.note)
                    .on_input({
                        let key = key.clone();
                        move |value| Message::Note(key.clone(), value)
                    })
                    .on_submit(Message::SendDismiss(key.clone()))
                    .padding(6),
                row![
                    action(
                        dismiss_label(item),
                        Message::SendDismiss(key.clone()),
                        true
                    ),
                    action("Cancel", Message::Back(key), false),
                ]
                .spacing(6),
            ]
            .spacing(6)
            .into();
        }

        let mut content = Column::new().spacing(6);

        for choice in &card.options {
            let selected = draft.choice.as_deref() == Some(choice.id.as_str());
            content = content.push(option_view(&key, choice, selected));
        }

        let words_label = if details.choices.is_some() {
            "A note with your choice (optional)"
        } else if card.options.is_empty() {
            "Your reply"
        } else if card.free_text_ok {
            "Write my own answer (the ship invites one)"
        } else {
            "Write my own answer"
        };
        let writing = draft.own_words || card.options.is_empty();
        if !card.options.is_empty() {
            content = content.push(
                button(text(words_label))
                    .width(Length::Fill)
                    .padding([6, 10])
                    .style(move |theme, status| {
                        theme::button::secondary(theme, status, writing)
                    })
                    .on_press(Message::OwnWords(key.clone())),
            );
        }
        if writing || draft.choice.is_some() {
            let placeholder = if writing {
                words_label
            } else {
                "A note with your choice (optional)"
            };
            content = content.push(
                text_input(placeholder, &draft.text)
                    .on_input({
                        let key = key.clone();
                        move |value| Message::Text(key.clone(), value)
                    })
                    .on_submit(Message::Confirm(key.clone()))
                    .padding(6),
            );
        }

        let ready = draft.choice.is_some()
            || !draft.ticked.is_empty()
            || !draft.text.trim().is_empty();
        let mut actions = row![].spacing(6);
        if draft.confirming && ready {
            let summary = match (&draft.choice, draft.text.trim()) {
                (Some(id), note) => {
                    let label = card
                        .options
                        .iter()
                        .find(|c| &c.id == id)
                        .map_or(id.as_str(), |c| c.label.as_str());
                    if note.is_empty() {
                        label.to_owned()
                    } else {
                        format!("{label} — {note}")
                    }
                }
                (None, words) => ticked_reply(details, draft)
                    .unwrap_or_else(|| words.to_owned()),
            };
            content = content.push(
                text(format!("Send to {}: {summary}", item.mail.from))
                    .style(theme::text::secondary),
            );
            actions = actions
                .push(action("Send answer", Message::Send(key.clone()), true))
                .push(action("Cancel", Message::Back(key.clone()), false));
        } else {
            let mut send = button(text("Send answer")).padding([5, 12]).style(
                |theme, status| theme::button::primary(theme, status, false),
            );
            if ready {
                send = send.on_press(Message::Confirm(key.clone()));
            }
            actions = actions.push(send);
            if item.step.is_some() {
                actions = actions.push(action(
                    "Done, I did this",
                    Message::Done(key.clone()),
                    false,
                ));
            }
            actions = actions.push(space().width(Length::Fill)).push(action(
                dismiss_label(item),
                Message::StartDismiss(key.clone()),
                false,
            ));
        }

        content.push(actions).into()
    }
}

fn find<'a>(
    connection: &'a Connection,
    key: &str,
) -> Option<(&'a Item, &'a Details)> {
    let item = connection
        .waiting
        .as_ref()?
        .waiting
        .iter()
        .find(|item| triage::key(item) == key)?;
    Some((item, connection.details.get(key)?))
}

fn reply(
    item: &Item,
    details: &Details,
    draft: &Draft,
) -> Result<Value, String> {
    let id = &item.mail.id;
    match &draft.choice {
        Some(option) => decision::reply_args(
            id,
            &details.card,
            &Answer::Option {
                id: option.clone(),
                note: draft.text.clone(),
            },
        ),
        None if details.card.options.is_empty() => {
            let body = ticked_reply(details, draft).unwrap_or_default();
            decision::plain_reply_args(id, &body)
        }
        None => decision::reply_args(
            id,
            &details.card,
            &Answer::Words(draft.text.clone()),
        ),
    }
}

/// The reply for a request's ticked choices and the note, in the order the
/// ship listed them.
fn ticked_reply(details: &Details, draft: &Draft) -> Option<String> {
    let Some(split) = &details.choices else {
        return Some(draft.text.trim().to_owned()).filter(|t| !t.is_empty());
    };
    let ticked: Vec<&choices::Choice> = split
        .choices
        .iter()
        .filter(|choice| draft.ticked.contains(&choice.marker))
        .collect();
    choices::reply(&ticked, &draft.text)
}

/// A request's choices as checkboxes; the text ticks too.
fn ticks<'a>(
    key: &str,
    split: &'a choices::Split,
    draft: &Draft,
) -> Element<'a, Message> {
    Column::with_children(split.choices.iter().map(|choice| {
        let tick = Message::Tick(key.to_owned(), choice.marker.clone());
        row![
            checkbox(draft.ticked.contains(&choice.marker))
                .on_toggle({
                    let tick = tick.clone();
                    move |_| tick.clone()
                })
                .style(theme::checkbox::primary),
            button(
                row![
                    text(format!("{}.", choice.marker))
                        .font(font::MONO_BOLD.clone())
                        .width(24),
                    text(choice.text.as_str()).width(Length::Fill),
                ]
                .spacing(6),
            )
            .padding(0)
            .style(theme::button::bare)
            .on_press(tick),
        ]
        .spacing(8)
        .into()
    }))
    .spacing(8)
    .into()
}

fn option_view<'a>(
    key: &str,
    choice: &'a Choice,
    selected: bool,
) -> Element<'a, Message> {
    // The ship's recommendation is marked, never preselected.
    let mut title =
        row![text(choice.label.as_str()).font(font::MONO_BOLD.clone())]
            .spacing(10);
    if choice.recommended {
        title = title.push(
            row![
                icon::star().style(theme::text::success),
                text("Recommended").style(theme::text::success),
            ]
            .spacing(4),
        );
    }
    let mut content = column![title].spacing(4);
    if let Some(cost) = &choice.cost {
        content =
            content.push(text(cost.as_str()).style(theme::text::secondary));
    }
    if let Some(what) = &choice.what_happens {
        content =
            content.push(text(what.as_str()).style(theme::text::secondary));
    }

    button(content)
        .width(Length::Fill)
        .padding([8, 10])
        .style(move |theme: &Theme, status| {
            let mut style = theme::button::secondary(theme, status, selected);
            if choice.recommended {
                style.border = Border {
                    color: theme.styles().text.success.color.scale_alpha(0.6),
                    width: 1.0,
                    radius: 4.0.into(),
                };
            }
            style
        })
        .on_press(Message::Choose(key.to_owned(), choice.id.clone()))
        .into()
}

fn action<'a>(
    label: &'a str,
    message: Message,
    primary: bool,
) -> Element<'a, Message> {
    button(text(label))
        .padding([5, 12])
        .style(move |theme, status| {
            if primary {
                theme::button::primary(theme, status, false)
            } else {
                theme::button::secondary(theme, status, false)
            }
        })
        .on_press(message)
        .into()
}

fn dismiss_label(item: &Item) -> &'static str {
    if item.step.is_some() {
        "Done, nothing to add"
    } else if item.mail.kind == "notice" {
        "Mark read"
    } else {
        "Dismiss"
    }
}

fn outcome_label<'a>(outcome: &Outcome) -> Element<'a, Message> {
    match outcome {
        Outcome::Sending => text("sending").style(theme::text::tertiary),
        Outcome::Sent => text("sent").style(theme::text::success),
        Outcome::Held => {
            text("not sent: sending is off").style(theme::text::tertiary)
        }
        Outcome::Failed(_) => text("failed").style(theme::text::error),
    }
    .into()
}

fn section_title<'a>(section: Section, count: usize) -> Element<'a, Message> {
    text(format!("{} ({count})", section.title()))
        .font(font::MONO_BOLD.clone())
        .style(theme::text::secondary)
        .into()
}

/// How long ago an ask was made, or, when it has a deadline, how long is
/// left (or how long ago it passed).
fn due(item: &Item) -> String {
    match item.mail.deadline_ms {
        Some(deadline) => {
            let left = deadline - connection::now_ms();
            if left < 0 {
                format!("overdue {}", ago(-left))
            } else {
                format!("due in {}", ago(left))
            }
        }
        None => ago(item.age_ms),
    }
}

/// A rough span of time: "now", "12m", "3h", "2d".
pub fn ago(ms: i64) -> String {
    let minutes = ms.max(0) / 60_000;
    match minutes {
        0 => "now".into(),
        1..60 => format!("{minutes}m"),
        60..1440 => format!("{}h", minutes / 60),
        _ => format!("{}d", minutes / 1440),
    }
}

/// The start of a message, on one line, cut at a word near `limit`
/// characters.
fn preview(body: &str, limit: usize) -> String {
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        return flat;
    }
    let cut: String = flat.chars().take(limit).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{cut}…")
}
