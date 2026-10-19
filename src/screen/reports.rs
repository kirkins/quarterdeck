//! Reports: a ship's long document, read as Markdown and commented on block
//! by block. The comments go back to the ship as one reply, through the
//! guarded write path. HTML reports are not drawn: their source can be shown.

use std::collections::HashMap;

use data::markdown::{self, Document};
use data::privateer::{Error, Sent};
use data::report::{self, Attached, Comment, SentComment};
use iced::widget::{
    button, column, container, row, scrollable, text_editor, text_input,
};
use iced::{Alignment, Length};
use serde_json::Value;

use crate::Theme;
use crate::appearance::theme;
use crate::connection::Connection;
use crate::font;
use crate::widget::{Column, Element, loading_line, markdown as draw, text};

/// The write key for a report's comments.
pub const REPORT_KEY: &str = "report";

/// A report opened from an ask or a notice.
#[derive(Debug, Clone)]
pub struct Opened {
    /// The ask's key, sender and id.
    pub key: String,
    pub mail_id: String,
    pub from: String,
    /// `request`, `decision` or `notice`: comments answer an ask.
    pub kind: String,
    /// Whether the thread still takes the captain's comments.
    pub open: bool,
    pub attached: Attached,
}

impl Opened {
    /// The report on a message, if it carries one.
    pub fn from_mail(
        from: &str,
        id: &str,
        kind: &str,
        open: bool,
        payload: &Value,
    ) -> Option<Self> {
        Some(Opened {
            key: format!("{from}/{id}"),
            mail_id: id.to_owned(),
            from: from.to_owned(),
            kind: kind.to_owned(),
            open,
            attached: Attached::of(payload)?,
        })
    }
}

#[derive(Debug, Clone)]
pub enum Message {
    Open(Opened),
    Close,
    CommentOn(usize),
    Edit(text_editor::Action),
    Save,
    CancelEdit,
    Remove(usize),
    Note(String),
    Confirm,
    Cancel,
    Send,
    ShowSource,
    OpenLink(String),
}

pub enum Event {
    /// Fetch a stored report.
    Read(String),
    Write {
        command: &'static str,
        args: Value,
    },
    OpenLink(String),
}

#[derive(Default)]
pub struct Reports {
    current: Option<Opened>,
    /// An inline report's Markdown, parsed when opened.
    inline: Option<Document>,
    /// Comments per report, by the ask's key, kept until sent. Each change is
    /// also saved to the drafts file.
    comments: HashMap<String, Vec<Comment>>,
    /// The block being commented on, and the text so far.
    editing: Option<(usize, text_editor::Content)>,
    note: String,
    confirming: bool,
    /// The report whose comments are on their way, and those comments.
    sending: Option<(String, Vec<Comment>)>,
    /// Comments sent from here, by report, as kept in the sent file.
    sent_here: HashMap<String, Vec<SentComment>>,
    source: bool,
    last: Option<(bool, String)>,
}

impl Reports {
    pub fn update(
        &mut self,
        message: Message,
        connection: &Connection,
    ) -> Option<Event> {
        match message {
            Message::Open(opened) => {
                let drafts =
                    report::load_drafts(&report::drafts_path(), &opened.key);
                self.comments.insert(opened.key.clone(), drafts);
                self.sent_here.insert(
                    opened.key.clone(),
                    report::load_sent(&report::sent_path(), &opened.key),
                );
                let read = match &opened.attached {
                    Attached::Inline { content, .. } => {
                        self.inline = Some(markdown::parse(content, None));
                        None
                    }
                    Attached::Stored { id, .. } => {
                        self.inline = None;
                        Some(Event::Read(id.clone()))
                    }
                };
                self.current = Some(opened);
                self.editing = None;
                self.confirming = false;
                self.source = false;
                self.last = None;
                return read;
            }
            Message::Close => self.current = None,
            Message::CommentOn(index) => {
                let existing = self
                    .current_comments()
                    .iter()
                    .find(|c| c.selector == block(index));
                let text = existing.map_or("", |c| c.text.as_str());
                self.editing =
                    Some((index, text_editor::Content::with_text(text)));
            }
            Message::Edit(action) => {
                if let Some((_, content)) = &mut self.editing {
                    content.perform(action);
                }
            }
            Message::Save => {
                if self
                    .editing
                    .as_ref()
                    .is_some_and(|(_, content)| too_long(&content.text()))
                {
                    return None;
                }
                let (index, content) = self.editing.take()?;
                let comment = content.text();
                let quote = self
                    .document(connection)
                    .and_then(|doc| doc.nodes.get(index))
                    .map(block_text)
                    .unwrap_or_default();
                let key = self.current.as_ref()?.key.clone();
                let comments = self.comments.entry(key.clone()).or_default();
                comments.retain(|c| c.selector != block(index));
                if !comment.trim().is_empty() {
                    comments.push(Comment::on_block(index, &quote, &comment));
                    comments.sort_by_key(|c| index_of(&c.selector));
                }
                self.persist(&key);
                self.confirming = false;
            }
            Message::CancelEdit => self.editing = None,
            Message::Remove(index) => {
                let key = self.current.as_ref()?.key.clone();
                if let Some(comments) = self.comments.get_mut(&key) {
                    comments.retain(|c| c.selector != block(index));
                }
                self.persist(&key);
                self.confirming = false;
            }
            Message::Note(value) => self.note = value,
            Message::Confirm => {
                self.confirming = !self.current_comments().is_empty()
            }
            Message::Cancel => self.confirming = false,
            Message::Send => {
                if self.sending.is_some() {
                    return None;
                }
                let current = self.current.as_ref()?;
                let args = match report::reply_args(
                    &current.mail_id,
                    current.attached.title(),
                    self.current_comments(),
                    &self.note,
                ) {
                    Ok(args) => args,
                    Err(problem) => {
                        self.last = Some((false, problem));
                        return None;
                    }
                };
                self.sending = Some((
                    current.key.clone(),
                    self.current_comments().to_vec(),
                ));
                return Some(Event::Write {
                    command: "captain.reply",
                    args,
                });
            }
            Message::ShowSource => self.source = !self.source,
            Message::OpenLink(url) => return Some(Event::OpenLink(url)),
        }
        None
    }

    /// What became of the comments. Sent, they are cleared; held or refused,
    /// they are kept as drafts.
    pub fn written(&mut self, result: Result<Sent, Error>) {
        let sending = self.sending.take();
        self.confirming = false;
        self.last = Some(match result {
            Ok(Sent::Sent(_)) => {
                if let Some((key, sent)) = sending {
                    self.comments.remove(&key);
                    self.persist(&key);
                    let now = crate::connection::now_ms();
                    let sent: Vec<SentComment> =
                        sent.iter().map(|c| SentComment::of(c, now)).collect();
                    if let Err(error) =
                        report::keep_sent(&report::sent_path(), &key, &sent)
                    {
                        log::warn!("could not keep the sent comments: {error}");
                    }
                    self.sent_here.entry(key.clone()).or_default().extend(sent);
                    // An ask is answered by its comments: it takes no more.
                    if let Some(current) =
                        self.current.as_mut().filter(|c| c.key == key)
                        && current.kind != "notice"
                    {
                        current.open = false;
                    }
                }
                self.note.clear();
                (true, "Sent.".to_owned())
            }
            Ok(Sent::Held(_)) => (
                true,
                "Not sent: sending is off (logged). The comments are kept."
                    .to_owned(),
            ),
            Err(error) => (false, error.to_string()),
        });
    }

    /// Save one report's drafts to the drafts file. A failure is logged; the
    /// comments stay on screen either way.
    fn persist(&self, key: &str) {
        let comments: &[Comment] =
            self.comments.get(key).map_or(&[], Vec::as_slice);
        if let Err(error) =
            report::save_drafts(&report::drafts_path(), key, comments)
        {
            log::warn!("could not save the comment drafts: {error}");
        }
    }

    fn current_comments(&self) -> &[Comment] {
        self.current
            .as_ref()
            .and_then(|c| self.comments.get(&c.key))
            .map_or(&[], Vec::as_slice)
    }

    /// The comments already sent on the open report: those the feed shows,
    /// then any sent from here that it does not show.
    fn sent(
        &self,
        current: &Opened,
        connection: &Connection,
    ) -> Vec<SentComment> {
        let mut sent = report::sent_on(
            connection.feed.thread.entries(),
            &current.from,
            &current.mail_id,
        );
        if let Some(kept) = self.sent_here.get(&current.key) {
            let missing: Vec<SentComment> =
                report::missing_from(kept, &sent).cloned().collect();
            sent.extend(missing);
            sent.sort_by_key(|c| c.sent_ms);
        }
        sent
    }

    fn document<'a>(
        &'a self,
        connection: &'a Connection,
    ) -> Option<&'a Document> {
        match &self.current.as_ref()?.attached {
            Attached::Inline { .. } => self.inline.as_ref(),
            Attached::Stored { id, .. } => match connection.reports.get(id)? {
                Ok((_, document)) => Some(document),
                Err(_) => None,
            },
        }
    }

    fn format<'a>(&'a self, connection: &'a Connection) -> Option<&'a str> {
        match &self.current.as_ref()?.attached {
            Attached::Inline { format, .. } => Some(format),
            Attached::Stored { id, format, .. } => {
                match connection.reports.get(id) {
                    Some(Ok((report, _))) => Some(&report.format),
                    _ => format.as_deref(),
                }
            }
        }
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        match &self.current {
            None => list(connection),
            Some(current) => self.reader(current, connection, theme),
        }
    }

    fn reader<'a>(
        &'a self,
        current: &'a Opened,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let header = row![
            button(text("← Reports"))
                .padding([2, 8])
                .style(|theme, status| theme::button::secondary(
                    theme, status, false
                ))
                .on_press(Message::Close),
            text(current.attached.title())
                .size(theme::TEXT_SIZE + 2.0)
                .font(font::MONO_BOLD.clone()),
            text(format!("from {}", current.from))
                .style(move |theme| theme::text::seeded(theme, &current.from)),
        ]
        .spacing(10)
        .align_y(Alignment::Center);

        let mut body = Column::new().spacing(10);
        let is_html = self.format(connection) == Some("html");
        let document = self.document(connection).filter(|_| !is_html);
        let blocks: Vec<String> = document
            .map(|d| d.nodes.iter().map(block_text).collect())
            .unwrap_or_default();
        let mut placed: Vec<Vec<SentComment>> = vec![Vec::new(); blocks.len()];
        let mut unplaced = Vec::new();
        for comment in self.sent(current, connection) {
            match report::place(&comment, &blocks) {
                Some(index) => placed[index].push(comment),
                None => unplaced.push(comment),
            }
        }
        if (is_html || document.is_some()) && !unplaced.is_empty() {
            body = body.push(
                text(if is_html {
                    "Comments sent on this report:"
                } else {
                    "Comments sent on text no longer in this report:"
                })
                .style(theme::text::secondary),
            );
            for comment in unplaced {
                body = body.push(sent_view(comment, true));
            }
        }
        if is_html {
            body = body.push(
                text("This report is HTML. Quarterdeck shows Markdown reports only, so it is not drawn.")
                    .style(theme::text::secondary),
            );
            body = body.push(
                button(text(if self.source {
                    "Hide source"
                } else {
                    "Show source"
                }))
                .padding([4, 10])
                .style(|theme, status| {
                    theme::button::secondary(theme, status, false)
                })
                .on_press(Message::ShowSource),
            );
            if self.source {
                body = body
                    .push(text(self.raw(connection)).font(font::MONO.clone()));
            }
        } else {
            match document {
                Some(document) => {
                    for ((index, node), sent) in
                        document.nodes.iter().enumerate().zip(placed)
                    {
                        body = body.push(self.block(
                            index,
                            node,
                            sent,
                            current.open,
                            theme,
                        ));
                    }
                }
                None => {
                    if let Attached::Stored { id, .. } = &current.attached {
                        body = body.push(match connection.reports.get(id) {
                            Some(Err(error))
                                if report::held_elsewhere(
                                    &error.to_string(),
                                    &current.from,
                                    connection.fleet.snapshot.as_ref(),
                                ) =>
                            {
                                text(
                                    "This report is stored on another machine and can't be opened here yet.",
                                )
                                .style(theme::text::secondary)
                                .into()
                            }
                            Some(Err(error)) => text(error.to_string())
                                .style(theme::text::error)
                                .into(),
                            _ => loading_line("Reading the report"),
                        });
                    }
                }
            }
        }

        column![
            container(header).padding([8, 12]),
            scrollable(container(body).padding(12)).height(Length::Fill),
            self.footer(current, connection),
        ]
        .into()
    }

    fn raw<'a>(&'a self, connection: &'a Connection) -> &'a str {
        match self.current.as_ref().map(|c| &c.attached) {
            Some(Attached::Inline { content, .. }) => content,
            Some(Attached::Stored { id, .. }) => {
                match connection.reports.get(id) {
                    Some(Ok((report, _))) => &report.content,
                    _ => "",
                }
            }
            None => "",
        }
    }

    /// One block, with its comment, or the box to write one.
    fn block<'a>(
        &'a self,
        index: usize,
        node: &'a markdown::Node,
        sent: Vec<SentComment>,
        open: bool,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let mut line = row![
            container(draw::node_view(node, theme, Message::OpenLink))
                .width(Length::Fill)
        ]
        .spacing(8);
        if open && self.editing.is_none() {
            line = line.push(
                button(text("Comment").size(theme::TEXT_SIZE - 1.0))
                    .padding([2, 8])
                    .style(|theme, status| {
                        theme::button::secondary(theme, status, false)
                    })
                    .on_press(Message::CommentOn(index)),
            );
        }
        let mut content = column![line].spacing(6);
        for comment in sent {
            content = content.push(sent_view(comment, false));
        }

        match &self.editing {
            Some((editing, value)) if *editing == index => {
                let written = value.text();
                let mut actions = row![
                    small_button("Save", Message::Save, true),
                    small_button("Cancel", Message::CancelEdit, false),
                ]
                .spacing(6)
                .align_y(Alignment::Center);
                if too_long(&written) {
                    actions = actions.push(
                        text(format!(
                            "{} characters; a comment holds at most {}.",
                            written.trim().chars().count(),
                            report::MAX_COMMENT_CHARS
                        ))
                        .style(theme::text::error),
                    );
                }
                content = content.push(
                    column![
                        text_editor(value)
                            .placeholder("Your comment on this block")
                            .on_action(Message::Edit)
                            .height(Length::Shrink)
                            .padding(6),
                        actions,
                    ]
                    .spacing(6),
                );
            }
            _ => {
                if let Some(comment) = self
                    .current_comments()
                    .iter()
                    .find(|c| c.selector == block(index))
                {
                    content = content.push(
                        container(
                            row![
                                text(comment.text.as_str()).width(Length::Fill),
                                small_button(
                                    "Edit",
                                    Message::CommentOn(index),
                                    false
                                ),
                                small_button(
                                    "Remove",
                                    Message::Remove(index),
                                    false
                                ),
                            ]
                            .spacing(6)
                            .align_y(Alignment::Center),
                        )
                        .padding(8)
                        .width(Length::Fill)
                        .style(|theme| theme::container::buffer(theme, true)),
                    );
                }
            }
        }
        content.into()
    }

    fn footer<'a>(
        &'a self,
        current: &'a Opened,
        connection: &'a Connection,
    ) -> Element<'a, Message> {
        let count = self.current_comments().len();
        let mut bar = row![].spacing(8).align_y(Alignment::Center);
        let mut warning = answers(&current.kind);
        if !current.open {
            let answered = current.kind != "notice"
                && !self.sent(current, connection).is_empty();
            bar = bar.push(
                text(if answered {
                    "Your comments answered this ask, so it takes no more."
                } else {
                    "This report's thread is closed, so it takes no comments."
                })
                .style(theme::text::tertiary),
            );
            warning = None;
        } else if self.confirming {
            bar = bar
                .push(text(format!(
                    "Send {count} comment{} to {}?",
                    if count == 1 { "" } else { "s" },
                    current.from
                )))
                .push(small_button("Send", Message::Send, true))
                .push(small_button("Cancel", Message::Cancel, false));
        } else {
            bar = bar
                .push(
                    text(format!(
                        "{count} comment{}",
                        if count == 1 { "" } else { "s" }
                    ))
                    .style(theme::text::secondary),
                )
                .push(
                    text_input(
                        "A note with your comments (optional)",
                        &self.note,
                    )
                    .on_input(Message::Note)
                    .padding(6)
                    .width(Length::Fill),
                );
            let mut send = button(text("Send comments"))
                .padding([4, 12])
                .style(|theme, status| {
                    theme::button::primary(theme, status, false)
                });
            if count > 0 && self.sending.is_none() {
                send = send.on_press(Message::Confirm);
            }
            bar = bar.push(send);
        }
        let mut footer = column![bar].spacing(4);
        if let Some(warning) = warning {
            footer = footer.push(text(warning).style(if self.confirming {
                theme::text::error
            } else {
                theme::text::tertiary
            }));
        }
        if let Some((good, line)) = &self.last {
            footer = footer.push(text(line.as_str()).style(if *good {
                theme::text::tertiary
            } else {
                theme::text::error
            }));
        }
        container(footer)
            .padding(10)
            .style(theme::container::buffer_title_bar)
            .into()
    }
}

/// Every report that came in on an ask or a message, newest first.
fn list(connection: &Connection) -> Element<'_, Message> {
    let mut seen: Vec<(i64, Opened)> = Vec::new();
    for entry in connection.feed.thread.entries() {
        if let Some(opened) = Opened::from_mail(
            &entry.from,
            &entry.id,
            &entry.kind,
            entry.is_open_ask() || entry.is_unread_notice(),
            &entry.payload,
        ) {
            seen.push((entry.created_ms, opened));
        }
    }
    if let Some(waiting) = &connection.waiting {
        for item in &waiting.waiting {
            if let Some(opened) = Opened::from_mail(
                &item.mail.from,
                &item.mail.id,
                &item.mail.kind,
                true,
                &item.mail.payload,
            ) && !seen.iter().any(|(_, o)| o.key == opened.key)
            {
                seen.push((item.asked_ms, opened));
            }
        }
    }
    seen.sort_by_key(|(at, _)| std::cmp::Reverse(*at));

    if seen.is_empty() {
        return container(
            text("No reports yet. A ship sends one when it has a long document for you; it appears here, in the Feed and in Triage.")
                .style(theme::text::secondary),
        )
        .padding(16)
        .center(Length::Fill)
        .max_width(480)
        .into();
    }

    scrollable(
        Column::with_children(seen.into_iter().map(|(at, opened)| {
            let title = opened.attached.title().to_owned();
            let from = opened.from.clone();
            button(
                row![
                    text(title)
                        .font(font::MONO_BOLD.clone())
                        .width(Length::Fill),
                    text(from.clone())
                        .style(move |theme| theme::text::seeded(theme, &from)),
                    text(crate::screen::triage::ago(
                        crate::connection::now_ms() - at
                    ))
                    .style(theme::text::tertiary),
                ]
                .spacing(10),
            )
            .width(Length::Fill)
            .padding([6, 10])
            .style(|theme, status| {
                theme::button::secondary(theme, status, false)
            })
            .on_press(Message::Open(opened))
            .into()
        }))
        .spacing(4)
        .padding(12),
    )
    .height(Length::Fill)
    .into()
}

/// What sending comments does to the ask they answer, if anything.
fn answers(kind: &str) -> Option<&'static str> {
    match kind {
        "request" => {
            Some("Sending your comments answers this request and closes it.")
        }
        "decision" => Some(
            "Sending your comments answers this decision without choosing an option, and closes it. To choose one, answer it in Triage.",
        ),
        _ => None,
    }
}

/// A comment already sent, with its block's text when no block holds it.
fn sent_view<'a>(
    comment: SentComment,
    with_quote: bool,
) -> Element<'a, Message> {
    let mut content = column![].spacing(4);
    if with_quote && let Some(quote) = &comment.quote {
        let mut quote: String = quote.chars().take(160).collect();
        if comment
            .quote
            .as_ref()
            .is_some_and(|q| q.chars().count() > 160)
        {
            quote.push('…');
        }
        content = content
            .push(text(format!("On \"{quote}\"")).style(theme::text::tertiary));
    }
    content = content.push(text(comment.text)).push(
        text(
            match crate::screen::triage::ago(
                crate::connection::now_ms() - comment.sent_ms,
            ) {
                ago if ago == "now" => "Sent just now".to_owned(),
                ago => format!("Sent {ago} ago"),
            },
        )
        .size(theme::TEXT_SIZE - 1.0)
        .style(theme::text::tertiary),
    );
    container(content)
        .padding(8)
        .width(Length::Fill)
        .style(|theme| theme::container::buffer(theme, false))
        .into()
}

/// A block's text, as a comment quotes it.
fn block_text(node: &markdown::Node) -> String {
    Document {
        nodes: vec![node.clone()],
    }
    .plain_text()
}

/// Whether a comment is longer than Privateer takes.
fn too_long(comment: &str) -> bool {
    comment.trim().chars().count() > report::MAX_COMMENT_CHARS
}

fn small_button<'a>(
    label: &'a str,
    message: Message,
    primary: bool,
) -> Element<'a, Message> {
    button(text(label))
        .padding([3, 10])
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

fn block(index: usize) -> String {
    format!("block:{index}")
}

fn index_of(selector: &str) -> usize {
    selector
        .strip_prefix("block:")
        .and_then(|n| n.parse().ok())
        .unwrap_or(usize::MAX)
}
