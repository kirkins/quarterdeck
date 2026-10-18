//! The Feed: one conversation with every ship, oldest at the top. Asks show
//! their state; an open one is answered in Triage, the one answer path.

use chrono::{DateTime, Local, TimeZone};
use data::feed::Entry;
use iced::widget::{button, column, container, row, scrollable, space};
use iced::{Alignment, Length, Padding};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::Connection;
use crate::font;
use crate::widget::{Column, Element, markdown, text};

#[derive(Debug, Clone)]
pub enum Message {
    LoadOlder,
    /// Open this ask, by its key, in Triage.
    Answer(String),
    OpenLink(String),
}

pub fn view<'a>(
    connection: &'a Connection,
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
        list = list.push(message_view(
            entry,
            connection.feed.bodies.get(&entry.key()),
            theme,
        ));
    }

    scrollable(list).anchor_bottom().height(Length::Fill).into()
}

fn message_view<'a>(
    entry: &'a Entry,
    body: Option<&'a data::markdown::Document>,
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
    if entry.is_open_ask() {
        content = content.push(
            button(text("Answer"))
                .padding([4, 12])
                .style(|theme, status| {
                    theme::button::primary(theme, status, false)
                })
                .on_press(Message::Answer(entry.key())),
        );
    }

    // The captain's own messages sit indented, as a reply does in a chat.
    let padding = if mine {
        Padding::default().left(32)
    } else {
        Padding::default()
    };
    container(content).padding(padding).into()
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
