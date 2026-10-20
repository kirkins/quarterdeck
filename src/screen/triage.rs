//! Triage: everything that waits on the captain, in sections, with each ask
//! answered or dismissed in place.
//!
//! Answering takes two deliberate steps: choose (an option, or your own
//! words), then confirm. A dismissal has its own confirm step. Every write
//! goes through the connection's one guarded path.

use std::collections::{HashMap, HashSet};

use data::answered::Answered;
use data::captain::Item;
use data::choices;
use data::decision::{self, Answer, Choice};
use data::privateer::{Error, Sent};
use data::triage::{self, Filter, Group, Section};
use iced::widget::{
    button, checkbox, column, container, row, scrollable, space, text_input,
};
use iced::{Border, Length};
use serde_json::Value;

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{self, Connection, Details};
use crate::screen::reports;
use crate::widget::{Column, Element, Row, loading, markdown, text};
use crate::{font, icon};

type Style = fn(&Theme) -> iced::widget::text::Style;

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
    /// Mark an unread notice read: its key, then its mail id.
    SendMark(String, String),
    OpenLink(String),
    OpenReport(reports::Opened),
    /// Narrow the list to one ship, or to all (None).
    SetShip(Option<String>),
    /// Narrow the list to one kind, or to all (None).
    SetKind(Option<String>),
    /// Copy an ask's hands-on step to the clipboard.
    CopyStep(String),
    /// Show or fold the list of what was answered lately.
    ToggleAnswered,
    /// Open a ship's conversation, to follow up on an answer.
    FollowUp(String),
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
    /// The filter changed: it is saved with the layout.
    FilterChanged,
    /// Put this text on the clipboard.
    Copy(String),
    /// Open this ship's conversation.
    OpenShip(String),
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
    filter: Filter,
    /// Hands-on steps copied, until the ask is folded again.
    copied: HashSet<String>,
    /// The card each answered ask belongs to, by ask key.
    card_of: HashMap<String, String>,
    /// The asks each card has had sent this session, by card key: a card's
    /// progress, since an answered ask leaves Privateer's list.
    answered: HashMap<String, HashSet<String>>,
    /// What each answer sent from here said, by ask key, shown on the ask
    /// until Privateer's list drops it.
    sent_words: HashMap<String, String>,
    /// The list of what was answered lately is open.
    show_answered: bool,
}

impl Triage {
    /// Triage narrowed as the captain left it.
    pub fn with_filter(filter: Filter) -> Self {
        Self {
            filter,
            ..Self::default()
        }
    }

    pub fn filter(&self) -> Filter {
        self.filter.clone()
    }

    /// Narrow Triage to one ship's asks, with every kind.
    pub fn show_ship(&mut self, ship: String) {
        self.filter = Filter {
            ship: Some(ship),
            kind: None,
        };
    }

    pub fn update(
        &mut self,
        message: Message,
        connection: &Connection,
    ) -> Option<Event> {
        match message {
            Message::Expand(key) => {
                self.copied.remove(&key);
                if !self.toggled.remove(&key) {
                    self.toggled.insert(key);
                }
                None
            }
            Message::SetShip(ship) => {
                self.filter.ship = ship;
                Some(Event::FilterChanged)
            }
            Message::SetKind(kind) => {
                self.filter.kind = kind;
                Some(Event::FilterChanged)
            }
            Message::CopyStep(key) => {
                let step = find_item(connection, &key)?.step.clone()?;
                self.copied.insert(key);
                Some(Event::Copy(step))
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
                self.write(key, triage::group_key(item), "captain.reply", args)
            }
            Message::Done(key) => {
                let (item, _) = find(connection, &key)?;
                let args = decision::plain_reply_args(&item.mail.id, "Done.");
                self.write(key, triage::group_key(item), "captain.reply", args)
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
                let id = item.mail.id.clone();
                let group = triage::group_key(item);
                self.dismiss(key, group, &id)
            }
            Message::ToggleAnswered => {
                self.show_answered = !self.show_answered;
                None
            }
            Message::FollowUp(ship) => Some(Event::OpenShip(ship)),
            Message::SendMark(key, id) => self.dismiss(key, None, &id),
            Message::OpenLink(url) => Some(Event::OpenLink(url)),
            Message::OpenReport(opened) => Some(Event::OpenReport(opened)),
        }
    }

    /// Close the ask `id` with the note in its draft, as Dismiss does.
    fn dismiss(
        &mut self,
        key: String,
        group: Option<String>,
        id: &str,
    ) -> Option<Event> {
        let note = self.drafts.get(&key).map(|d| d.note.clone());
        let args = Ok(decision::dismiss_args(
            id,
            note.as_deref().unwrap_or_default(),
        ));
        self.write(key, group, "captain.dismiss", args)
    }

    fn write(
        &mut self,
        key: String,
        group: Option<String>,
        command: &'static str,
        args: Result<Value, String>,
    ) -> Option<Event> {
        if matches!(self.outcomes.get(&key), Some(Outcome::Sending)) {
            return None;
        }
        match args {
            Ok(args) => {
                if let Some(group) = group {
                    self.card_of.insert(key.clone(), group);
                }
                self.sent_words
                    .insert(key.clone(), sent_words(command, &args));
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
                if let Some(group) = self.card_of.get(&key) {
                    self.answered
                        .entry(group.clone())
                        .or_default()
                        .insert(key.clone());
                }
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
            if connection.error.is_none() {
                return loading("Asking Privateer what waits on you");
            }
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

        if !waiting.waiting.is_empty() {
            list = list.push(filters(&waiting.waiting, &self.filter));
        }
        if !connection.sends() {
            list = list.push(
                text(
                    "Sending is off: answers are logged, not sent. Enable \
                     Allow sending under Privateer in Settings, then save the connection.",
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
        if let Some(reason) = &connection.needs_reason {
            list = list.push(
                text(format!("Blockers and approvals are not shown: {reason}"))
                    .style(theme::text::tertiary),
            );
        }
        if waiting.waiting.is_empty() {
            list = list.push(
                text("Nothing waits on you.").style(theme::text::secondary),
            );
        }

        let now = connection::now_ms();
        let shown = waiting.waiting.iter().filter(|i| self.filter.matches(i));
        let sections = triage::sections(shown, now);
        if sections.is_empty() && !waiting.waiting.is_empty() {
            list = list.push(
                text("Nothing matches these filters.")
                    .style(theme::text::secondary),
            );
        }
        for (section, groups) in sections {
            let count: usize = groups.iter().map(|g| g.items.len()).sum();
            list = list.push(section_title(section, count));
            for group in groups {
                list = list.push(self.group_view(group, connection, theme));
            }
        }
        if let Some(answered) = self.answered_view(connection, waiting, now) {
            list = list.push(answered);
        }

        scrollable(container(list).padding(12))
            .height(Length::Fill)
            .into()
    }

    /// A card: its asks, each answered on its own, under one header when it
    /// is more than one ask or has answers this session.
    fn group_view<'a>(
        &'a self,
        group: Group<'a>,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let progress = self.progress(&group);
        let mut asks = Column::new().spacing(10);
        if let Some((done, total)) = progress {
            asks = asks.push(card_header(&group, done, total, connection));
        }
        for &item in &group.items {
            let key = triage::key(item);
            let details = connection.details.get(&key);
            let decision = details.is_some_and(|d| !d.card.options.is_empty());
            let open = decision != self.toggled.contains(&key);
            asks = asks.push(self.item_view(
                key,
                item,
                details,
                open,
                progress.is_some(),
                theme,
            ));
        }
        match progress {
            Some(_) => container(asks)
                .padding(10)
                .style(|theme| theme::container::buffer(theme, false))
                .into(),
            None => asks.into(),
        }
    }

    /// A card's progress as (answered, in all), or None when it is a card of
    /// one with no answers. Answered asks count whether or not Privateer's
    /// list still shows them, once each.
    fn progress(&self, group: &Group<'_>) -> Option<(usize, usize)> {
        let answered = self.answered.get(group.key.as_ref()?);
        let done = answered.map_or(0, HashSet::len);
        if group.items.len() < 2 && done == 0 {
            return None;
        }
        let open: HashSet<String> =
            group.items.iter().map(|item| triage::key(item)).collect();
        let gone = answered.map_or(0, |sent| {
            sent.iter().filter(|key| !open.contains(*key)).count()
        });
        Some((done, group.items.len() + gone))
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

    /// Whether an answer to this ask was sent from here. The Feed closes the
    /// ask in place then, before Privateer's next read shows it closed.
    pub fn sent(&self, key: &str) -> bool {
        matches!(self.outcomes.get(key), Some(Outcome::Sent))
    }

    /// The Mark read control under an unread notice, for a view that shows
    /// it, such as the Feed: a note and a confirm step, as Dismiss has.
    pub fn mark_panel<'a>(
        &'a self,
        key: &str,
        id: &str,
    ) -> Element<'a, Message> {
        let draft = self.drafts.get(key).cloned().unwrap_or_default();
        let key = key.to_owned();
        let mut panel = Column::new().spacing(6);
        match self.outcomes.get(&key) {
            Some(Outcome::Sent) => {
                return text("Marked read").style(theme::text::tertiary).into();
            }
            Some(Outcome::Held) => {
                return text("not sent: sending is off")
                    .style(theme::text::tertiary)
                    .into();
            }
            Some(Outcome::Sending) => {
                return text("sending").style(theme::text::tertiary).into();
            }
            Some(Outcome::Failed(problem)) => {
                panel = panel
                    .push(text(problem.as_str()).style(theme::text::error));
            }
            None => {}
        }
        if draft.dismissing {
            let id = id.to_owned();
            panel = panel
                .push(
                    text_input("A note for the ship (optional)", &draft.note)
                        .on_input({
                            let key = key.clone();
                            move |value| Message::Note(key.clone(), value)
                        })
                        .on_submit(Message::SendMark(key.clone(), id.clone()))
                        .padding(6),
                )
                .push(
                    row![
                        action(
                            "Mark read",
                            Message::SendMark(key.clone(), id),
                            true
                        ),
                        action("Cancel", Message::Back(key), false),
                    ]
                    .spacing(6),
                );
        } else {
            panel = panel.push(action(
                "Mark read",
                Message::StartDismiss(key),
                false,
            ));
        }
        panel.into()
    }

    /// An ask just answered from here, until Privateer's list drops it:
    /// folded, faded, and saying what was sent.
    fn sent_view<'a>(
        &self,
        key: &str,
        item: &'a Item,
        details: Option<&Details>,
        outcome: &Outcome,
    ) -> Element<'a, Message> {
        let question = match details {
            Some(d) if !d.card.options.is_empty() => &d.card.question,
            _ => &item.mail.body,
        };
        let (mark, said) = match outcome {
            Outcome::Held => (
                text("not sent: sending is off").style(theme::text::tertiary),
                None,
            ),
            _ => (
                text("answered").style(theme::text::success),
                self.sent_words.get(key).cloned(),
            ),
        };
        let mut lines = column![
            row![
                icon::checkmark().style(theme::text::success),
                text(item.asker().to_owned()).style(theme::text::tertiary),
                mark,
            ]
            .spacing(8),
            text(preview(question, 140)).style(theme::text::tertiary),
        ]
        .spacing(2);
        if let Some(said) = said {
            lines = lines.push(
                text(format!("You sent: {said}")).style(theme::text::secondary),
            );
        }
        container(lines).padding([4, 0]).into()
    }

    /// What was answered in the last day, folded to one line until opened.
    /// Asks still on the waiting list are left out: they show there.
    fn answered_view<'a>(
        &self,
        connection: &'a Connection,
        waiting: &data::captain::Waiting,
        now: i64,
    ) -> Option<Element<'a, Message>> {
        let answers = &connection.answers;
        let Some(all) = &answers.list else {
            return answers.error.as_ref().map(|error| {
                text(format!("Could not read what was answered: {error}"))
                    .style(theme::text::tertiary)
                    .into()
            });
        };
        let open: HashSet<String> =
            waiting.waiting.iter().map(triage::key).collect();
        let shown: Vec<&Answered> = all
            .iter()
            .filter(|a| !open.contains(&a.key))
            .filter(|a| self.filter.ship.as_ref().is_none_or(|s| *s == a.ship))
            .collect();
        if shown.is_empty() {
            return None;
        }
        let title = row![
            text(if self.show_answered { "▾" } else { "▸" })
                .style(theme::text::tertiary),
            text(format!("Answered in the last day ({})", shown.len()))
                .font(font::MONO_BOLD.clone())
                .style(theme::text::secondary),
        ]
        .spacing(6);
        let mut list = Column::new().spacing(10).push(
            button(title)
                .padding(0)
                .style(theme::button::bare)
                .on_press(Message::ToggleAnswered),
        );
        if !self.show_answered {
            return Some(list.into());
        }
        for answered in shown {
            let mut top = row![
                icon::checkmark().style(theme::text::success),
                text(answered.ship.clone()).style({
                    let ship = answered.ship.clone();
                    move |theme| theme::text::seeded(theme, &ship)
                }),
                text(self.outcome_words(answered))
                    .style(theme::text::secondary),
            ]
            .spacing(8);
            if answered.relayed {
                top = top.push(
                    text("relayed by the operator")
                        .style(theme::text::tertiary),
                );
            }
            top = top
                .push(space().width(Length::Fill))
                .push(
                    text(ago(now - answered.closed_ms))
                        .style(theme::text::tertiary),
                )
                .push(
                    button(text("Follow up").style(theme::text::secondary))
                        .padding(0)
                        .style(theme::button::bare)
                        .on_press(Message::FollowUp(answered.ship.clone())),
                );
            list = list.push(
                column![
                    top,
                    text(preview(&answered.question, 160))
                        .style(theme::text::tertiary),
                ]
                .spacing(2),
            );
        }
        Some(list.into())
    }

    /// What an answered ask says became of it: when the feed has no reply
    /// but the answer went from here, what was sent.
    fn outcome_words(&self, answered: &Answered) -> String {
        match self.sent_words.get(&answered.key) {
            Some(words) if !answered.said => format!("You sent: {words}"),
            _ => answered.outcome.clone(),
        }
    }

    fn item_view<'a>(
        &'a self,
        key: String,
        item: &'a Item,
        details: Option<&'a Details>,
        open: bool,
        grouped: bool,
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
        header = header.push(space().width(Length::Fill)).push({
            let (label, style) = due(item);
            text(label).style(style)
        });

        if let Some(outcome @ (Outcome::Sent | Outcome::Held)) = outcome {
            return self.sent_view(&key, item, details, outcome);
        }

        let header = button(header)
            .padding(0)
            .style(theme::button::bare)
            .on_press(Message::Expand(key.clone()));

        if triage::is_read_only(item) {
            return column![header, read_only_view(item)].spacing(4).into();
        }

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
        // A card shows what its asks wait on once, as chips.
        if !details.card.blocked.is_empty() && !grouped {
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
            &item.mail.kind,
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
                let copied = self.copied.contains(&key);
                actions = actions.push(action(
                    if copied { "Copied" } else { "Copy" },
                    Message::CopyStep(key.clone()),
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

/// A card's header: who asked, how many questions, how many are answered,
/// the blockers its questions share, and the earliest open deadline.
fn card_header<'a>(
    group: &Group<'a>,
    done: usize,
    total: usize,
    connection: &'a Connection,
) -> Element<'a, Message> {
    let first: &'a Item = group.items[0];
    let asker = first.asker();
    let mut blocked: Vec<&'a str> = Vec::new();
    for item in &group.items {
        let shared = connection
            .details
            .get(&triage::key(item))
            .into_iter()
            .flat_map(|d| d.card.blocked.iter().map(String::as_str));
        for name in shared {
            if !blocked.contains(&name) {
                blocked.push(name);
            }
        }
    }
    let (due, style) = due_label(group.deadline_ms());

    let header = row![
        text(asker).style(move |theme| theme::text::seeded(theme, asker)),
        text(format!("{total} related questions"))
            .style(theme::text::secondary),
        text(format!("{done} of {total} answered"))
            .style(theme::text::tertiary),
        space().width(Length::Fill),
        text(due).style(style),
    ]
    .spacing(8);
    let mut header = Column::new().spacing(6).push(header);
    if !blocked.is_empty() {
        let mut chips = Row::new().spacing(6);
        for name in blocked {
            chips = chips.push(
                container(text(name).size(theme::TEXT_SIZE - 1.0))
                    .padding([2, 8])
                    .style(|theme| theme::container::buffer(theme, false)),
            );
        }
        header = header.push(
            row![
                text("Waiting on this:").style(theme::text::secondary),
                chips.wrap(),
            ]
            .spacing(8),
        );
    }
    header.into()
}

fn find_item<'a>(connection: &'a Connection, key: &str) -> Option<&'a Item> {
    connection
        .waiting
        .as_ref()?
        .waiting
        .iter()
        .find(|item| triage::key(item) == key)
}

fn find<'a>(
    connection: &'a Connection,
    key: &str,
) -> Option<(&'a Item, &'a Details)> {
    let item = find_item(connection, key)?;
    // Blockers and approvals are read, never answered here.
    if triage::is_read_only(item) {
        return None;
    }
    Some((item, connection.details.get(key)?))
}

/// The text of a blocker or approval, with what Quarterdeck can say about
/// it. Neither takes an answer here.
fn read_only_view<'a>(item: &'a Item) -> Element<'a, Message> {
    let payload = &item.mail.payload;
    let note = if item.mail.kind == "blocker" {
        let status = payload["status"].as_str().unwrap_or("blocked");
        format!(
            "Blocked ({status}). Quarterdeck offers nothing here: resolve it in Privateer."
        )
    } else {
        format!(
            "Approval to ship {} to {}. Grant or deny it in Privateer with approval.grant or approval.deny; Quarterdeck does not answer approvals.",
            payload["artifact"].as_str().unwrap_or("this artifact"),
            payload["environment"]
                .as_str()
                .unwrap_or("this environment"),
        )
    };
    column![
        text(preview(&item.mail.body, 400)).style(theme::text::primary),
        text(note).style(theme::text::secondary),
    ]
    .spacing(4)
    .into()
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

/// When an ask is due, in words and colour: overdue in red, due within a
/// day in amber, and "No deadline" when it has none.
fn due(item: &Item) -> (String, Style) {
    due_label(item.mail.deadline_ms)
}

fn due_label(deadline: Option<i64>) -> (String, Style) {
    let Some(deadline) = deadline else {
        return ("No deadline".into(), theme::text::tertiary);
    };
    let left = deadline - connection::now_ms();
    if left < 0 {
        (format!("overdue {}", ago(-left)), theme::text::error)
    } else if left <= triage::DAY_MS {
        (format!("due in {}", ago(left)), theme::text::action)
    } else {
        (format!("due in {}", ago(left)), theme::text::tertiary)
    }
}

/// Chips to narrow the list by ship and by kind. The chosen chip clears
/// its choice.
fn filters<'a>(items: &[Item], filter: &Filter) -> Element<'a, Message> {
    let mut ships: Vec<String> =
        items.iter().map(|item| item.asker().to_owned()).collect();
    if let Some(ship) = &filter.ship {
        ships.push(ship.clone());
    }
    ships.sort();
    ships.dedup();

    let mut kinds: Vec<String> = items
        .iter()
        .map(|item| triage::kind_of(item).to_owned())
        .collect();
    if let Some(kind) = &filter.kind {
        kinds.push(kind.clone());
    }
    kinds.sort();
    kinds.dedup();

    let mut ship_chips = Row::new().spacing(6).push(chip(
        "All ships".into(),
        filter.ship.is_none(),
        Message::SetShip(None),
    ));
    for ship in ships {
        let chosen = filter.ship.as_deref() == Some(ship.as_str());
        let next = (!chosen).then(|| ship.clone());
        ship_chips =
            ship_chips.push(chip(ship, chosen, Message::SetShip(next)));
    }

    let mut kind_chips = Row::new().spacing(6).push(chip(
        "All kinds".into(),
        filter.kind.is_none(),
        Message::SetKind(None),
    ));
    for kind in kinds {
        let chosen = filter.kind.as_deref() == Some(kind.as_str());
        let next = (!chosen).then(|| kind.clone());
        kind_chips = kind_chips.push(chip(
            kind.replace('_', " "),
            chosen,
            Message::SetKind(next),
        ));
    }

    column![ship_chips.wrap(), kind_chips.wrap()]
        .spacing(6)
        .into()
}

fn chip<'a>(
    label: String,
    selected: bool,
    message: Message,
) -> Element<'a, Message> {
    button(text(label).size(theme::TEXT_SIZE - 1.0))
        .padding([2, 8])
        .style(move |theme, status| {
            theme::button::secondary(theme, status, selected)
        })
        .on_press(message)
        .into()
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

/// What an answer sent from here said, in a few words.
fn sent_words(command: &str, args: &Value) -> String {
    if command == "captain.dismiss" {
        return match args["note"].as_str().map(str::trim) {
            Some(note) if !note.is_empty() => format!("Dismissed: {note}"),
            _ => "Dismissed".into(),
        };
    }
    preview(args["body"].as_str().unwrap_or_default(), 120)
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

#[cfg(test)]
mod tests {
    use super::*;
    use data::captain::Mail;
    use serde_json::json;

    fn ask(id: &str, group: Option<&str>) -> Item {
        let payload = match group {
            Some(group) => json!({"decision": {"group": group}}),
            None => json!({}),
        };
        Item {
            ship: "analytics".into(),
            asked_ms: 1,
            mail: Mail {
                id: id.into(),
                from: "analytics".into(),
                kind: "decision".into(),
                payload,
                ..Mail::default()
            },
            ..Item::default()
        }
    }

    fn cards(items: &[Item]) -> Vec<Group<'_>> {
        triage::sections(items, 0)
            .into_iter()
            .flat_map(|(_, groups)| groups)
            .collect()
    }

    fn write(triage: &mut Triage, item: &Item) -> Option<Event> {
        triage.write(
            triage::key(item),
            triage::group_key(item),
            "captain.reply",
            Ok(json!({})),
        )
    }

    #[test]
    fn a_card_counts_its_answers_as_they_go() {
        let asks = [
            ask("a", Some("setup")),
            ask("b", Some("setup")),
            ask("c", Some("setup")),
        ];
        let mut triage = Triage::default();
        let shown = cards(&asks);
        assert_eq!(shown.len(), 1);
        assert_eq!(triage.progress(&shown[0]), Some((0, 3)));

        // Each question sends on its own; the others stay open meanwhile.
        assert!(write(&mut triage, &asks[0]).is_some());
        assert!(write(&mut triage, &asks[1]).is_some());
        triage.written(triage::key(&asks[0]), Ok(Sent::Sent(json!({}))));

        // Privateer's list drops the answered ask on the next poll.
        let open = [asks[1].clone(), asks[2].clone()];
        assert_eq!(triage.progress(&cards(&open)[0]), Some((1, 3)));

        // A held answer was not sent, so it is not counted.
        triage.written(triage::key(&asks[1]), Ok(Sent::Held(vec![])));
        assert_eq!(triage.progress(&cards(&open)[0]), Some((1, 3)));

        // Answered and still listed counts once, not twice.
        assert!(write(&mut triage, &asks[1]).is_some());
        triage.written(triage::key(&asks[1]), Ok(Sent::Sent(json!({}))));
        assert_eq!(triage.progress(&cards(&asks)[0]), Some((2, 3)));

        // One question left: still a card, so its progress shows.
        let last = [asks[2].clone()];
        assert_eq!(triage.progress(&cards(&last)[0]), Some((2, 3)));
    }

    #[test]
    fn a_card_of_one_with_no_answers_has_no_progress() {
        let asks = [ask("solo", Some("setup")), ask("plain", None)];
        let triage = Triage::default();
        for card in cards(&asks) {
            assert_eq!(triage.progress(&card), None);
        }
    }

    #[test]
    fn a_failed_answer_leaves_the_card_as_it_was() {
        let asks = [ask("a", Some("setup")), ask("b", Some("setup"))];
        let mut triage = Triage::default();
        assert!(write(&mut triage, &asks[0]).is_some());
        triage.written(
            triage::key(&asks[0]),
            Err(data::privateer::Error::NotConfigured("refused".into())),
        );
        assert_eq!(triage.progress(&cards(&asks)[0]), Some((0, 2)));
    }

    #[test]
    fn a_sent_answer_keeps_what_it_said_until_the_list_drops_it() {
        let asks = [ask("a", None), ask("b", None)];
        let mut triage = Triage::default();
        let sent = || Ok(Sent::Sent(json!({})));
        triage.write(
            triage::key(&asks[0]),
            None,
            "captain.reply",
            Ok(json!({"id": "a", "body": "Keep it for renewals",
                      "payload": {"answer": {"option_id": "b"}}})),
        );
        triage.written(triage::key(&asks[0]), sent());
        triage.write(
            triage::key(&asks[1]),
            None,
            "captain.dismiss",
            Ok(json!({"id": "b", "note": "already done"})),
        );
        triage.written(triage::key(&asks[1]), sent());

        assert!(triage.sent(&triage::key(&asks[0])));
        assert_eq!(
            triage.sent_words[&triage::key(&asks[0])],
            "Keep it for renewals"
        );
        assert_eq!(
            triage.sent_words[&triage::key(&asks[1])],
            "Dismissed: already done"
        );
    }
}
