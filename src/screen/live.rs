//! Live: a ship's first mate as it works, its terminal screen with colours,
//! and a line to type into it. Typing is a write: it goes through the
//! guarded path, so nothing reaches the session while sending is off.

use data::ansi::{self, Colour, Run};
use data::privateer::{Error, Sent};
use iced::widget::{
    button, column, container, rich_text, row, scrollable, span, text_input,
};
use iced::{Alignment, Color, Length};
use serde_json::{Value, json};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{Connection, Screen};
use crate::font;
use crate::widget::{Column, Element, text};

/// The write key for typing into a session.
pub const LIVE_KEY: &str = "live";

#[derive(Debug, Clone)]
pub enum Message {
    Pick(String),
    Input(String),
    Send,
    /// A key such as `Enter`, `Escape` or `C-c`.
    Key(&'static str),
}

pub enum Event {
    /// Read this ship's screen now.
    Watch(String),
    Write {
        command: &'static str,
        args: Value,
    },
}

#[derive(Default)]
pub struct Live {
    ship: Option<String>,
    input: String,
    sending: bool,
    last: Option<(bool, String)>,
}

impl Live {
    /// The ship being watched.
    pub fn ship(&self) -> Option<&str> {
        self.ship.as_deref()
    }

    pub fn update(&mut self, message: Message) -> Option<Event> {
        match message {
            Message::Pick(ship) => {
                self.ship = Some(ship.clone());
                self.last = None;
                Some(Event::Watch(ship))
            }
            Message::Input(value) => {
                self.input = value;
                None
            }
            Message::Send => {
                let text = self.input.clone();
                self.write(json!({"text": text, "keys": ["Enter"]}))
            }
            Message::Key(key) => self.write(json!({"keys": [key]})),
        }
    }

    fn write(&mut self, mut args: Value) -> Option<Event> {
        if self.sending {
            return None;
        }
        args["ship"] = json!(self.ship.clone()?);
        self.sending = true;
        Some(Event::Write {
            command: "session.send",
            args,
        })
    }

    pub fn written(&mut self, result: Result<Sent, Error>) {
        self.sending = false;
        self.last = match result {
            Ok(Sent::Sent(_)) => {
                self.input.clear();
                None
            }
            Ok(Sent::Held(_)) => Some((
                true,
                "Not sent: sending is off, so typing does not reach the session.".into(),
            )),
            Err(error) => Some((false, error.to_string())),
        };
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let ships =
            Column::with_children(connection.ships.iter().map(|ship| {
                let picked = self.ship.as_deref() == Some(ship.name.as_str());
                button(text(ship.name.as_str()).style({
                    let name = ship.name.clone();
                    move |theme| theme::text::seeded(theme, &name)
                }))
                .width(Length::Fill)
                .padding([3, 8])
                .style(move |theme, status| {
                    theme::button::sidebar_buffer(theme, status, picked, picked)
                })
                .on_press(Message::Pick(ship.name.clone()))
                .into()
            }))
            .spacing(2);

        let screen: Element<'a, Message> =
            match (&self.ship, &connection.screen) {
                (None, _) => container(
                    text("Pick a ship to see its first mate's live session.")
                        .style(theme::text::secondary),
                )
                .center(Length::Fill)
                .into(),
                (Some(ship), Some(screen)) if &screen.ship == ship => {
                    self.screen(screen, theme)
                }
                (Some(_), _) => container(
                    text("Reading the session...")
                        .style(theme::text::secondary),
                )
                .center(Length::Fill)
                .into(),
            };

        row![
            scrollable(ships).width(160).height(Length::Fill),
            column![screen, self.input_bar()].width(Length::Fill),
        ]
        .spacing(8)
        .padding(8)
        .into()
    }

    fn screen<'a>(
        &'a self,
        screen: &'a Screen,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        if let Some(error) = &screen.error {
            return container(
                text(error.as_str()).style(theme::text::secondary),
            )
            .padding(16)
            .center(Length::Fill)
            .into();
        }
        let status = text(format!("{}: {}", screen.ship, screen.agent_status))
            .style(match screen.agent_status.as_str() {
                "working" => theme::text::success,
                "blocked" => theme::text::error,
                _ => theme::text::tertiary,
            });
        let lines = Column::with_children(screen.lines.iter().map(|line| {
            rich_text(
                line.iter()
                    .map(|run| styled(run, theme))
                    .collect::<Vec<_>>(),
            )
            .font(font::MONO.clone())
            .size(theme::TEXT_SIZE)
            .into()
        }));
        column![
            status,
            container(scrollable(lines).anchor_bottom().height(Length::Fill))
                .padding(8)
                .width(Length::Fill)
                .height(Length::Fill)
                .style(|theme| theme::container::buffer(theme, false)),
        ]
        .spacing(6)
        .into()
    }

    fn input_bar(&self) -> Element<'_, Message> {
        let mut bar = row![].spacing(6).align_y(Alignment::Center);
        if self.ship.is_some() {
            bar = bar
                .push(
                    text_input(
                        "Type to the first mate, Enter to send",
                        &self.input,
                    )
                    .on_input(Message::Input)
                    .on_submit(Message::Send)
                    .padding(6)
                    .width(Length::Fill),
                )
                .push(key("Esc", "Escape"))
                .push(key("Ctrl-C", "C-c"))
                .push(key("Enter", "Enter"));
        }
        let mut content = column![bar].spacing(4);
        if let Some((good, line)) = &self.last {
            content = content.push(text(line.as_str()).style(if *good {
                theme::text::tertiary
            } else {
                theme::text::error
            }));
        }
        container(content).padding([6, 0]).into()
    }
}

fn key(label: &'static str, name: &'static str) -> Element<'static, Message> {
    button(text(label))
        .padding([4, 10])
        .style(|theme, status| theme::button::secondary(theme, status, false))
        .on_press(Message::Key(name))
        .into()
}

type Span<'a> = iced::widget::text::Span<
    'a,
    (),
    <crate::widget::Renderer as iced::advanced::text::Renderer>::Font,
>;

fn styled<'a>(run: &'a Run, theme: &Theme) -> Span<'a> {
    let style = run.style;
    let default_fg = theme.styles().text.primary.color;
    let mut fg = style.fg.map_or(default_fg, colour);
    let mut bg = style.bg.map(colour);
    if style.inverse {
        let swapped = bg.unwrap_or(theme.styles().buffer.background);
        bg = Some(fg);
        fg = swapped;
    }
    if style.dim {
        fg = fg.scale_alpha(0.6);
    }
    let mut piece = span(run.text.as_str())
        .color(fg)
        .underline(style.underline)
        .font(font::get(data::appearance::theme::FontStyle::new(
            style.bold,
            style.italic,
        )));
    if let Some(bg) = bg {
        piece = piece.background(bg);
    }
    piece
}

/// The standard 16 colours, tuned to read on a dark background.
const BASE: [(u8, u8, u8); 16] = [
    (40, 40, 40),
    (204, 85, 85),
    (120, 190, 110),
    (215, 180, 95),
    (100, 150, 220),
    (190, 120, 200),
    (90, 185, 190),
    (200, 200, 200),
    (110, 110, 110),
    (240, 110, 110),
    (150, 220, 140),
    (240, 210, 120),
    (130, 175, 245),
    (220, 150, 230),
    (120, 215, 220),
    (245, 245, 245),
];

fn colour(colour: Colour) -> Color {
    let (r, g, b) = match colour {
        Colour::Indexed(index) => BASE[usize::from(index.min(15))],
        Colour::Palette(index) => ansi::palette_rgb(index),
        Colour::Rgb(r, g, b) => (r, g, b),
    };
    Color::from_rgb8(r, g, b)
}
