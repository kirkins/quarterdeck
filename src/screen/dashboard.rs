use std::collections::HashSet;

use data::config::{Position, Source};
use data::dashboard::{Axis, Layout, View};
use iced::widget::pane_grid::{self, PaneGrid};
use iced::widget::{button, column, container, row, scrollable, space};
use iced::{Alignment, Length, Padding};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{self, Connection, Which};
use crate::screen::triage::{self, Triage};
use crate::screen::{feed, fleet, live, reports, ships};
use crate::widget::{Column, Element, text};
use crate::{font, icon};

#[derive(Debug, Clone)]
pub enum Message {
    Open(View),
    Clicked(pane_grid::Pane),
    Resized(pane_grid::ResizeEvent),
    Dragged(pane_grid::DragEvent),
    Split(pane_grid::Pane, pane_grid::Axis),
    Close(pane_grid::Pane),
    ToggleMaximize(pane_grid::Pane),
    OpenSettings,
    Refresh,
    Triage(triage::Message),
    Feed(feed::Message),
    Reports(reports::Message),
    Live(live::Message),
    Fleet(fleet::Message),
    Ships(ships::Message),
}

/// What the app must do after an update.
pub enum Event {
    LayoutChanged,
    OpenSettings,
    Refresh,
    OpenLink(String),
    LoadOlder(Which),
    /// Read this ship's own conversation.
    OpenShip(data::feed::Scope),
    /// Fetch a stored report.
    ReadReport(String),
    /// Read a ship's live session now.
    WatchSession(data::session::Target),
    /// Run a write for the ask `key`.
    Write {
        key: String,
        command: &'static str,
        args: serde_json::Value,
    },
}

#[derive(Debug, Clone, Copy)]
struct Pane {
    view: View,
}

pub struct Dashboard {
    panes: pane_grid::State<Pane>,
    focus: Option<pane_grid::Pane>,
    triage: Triage,
    /// Asks whose answer controls are open under them in the Feed.
    answering: HashSet<String>,
    composer: feed::Composer,
    reports: reports::Reports,
    live: live::Live,
    fleet: fleet::Fleet,
    ships: ships::Ships,
    /// Writing to the ship open in Ships.
    ship_composer: feed::Composer,
}

impl Dashboard {
    pub fn new(saved: &data::Dashboard) -> Self {
        let panes =
            pane_grid::State::with_configuration(configuration(&saved.layout));
        let focus = panes.iter().next().map(|(pane, _)| *pane);
        Self {
            panes,
            focus,
            triage: Triage::default(),
            answering: HashSet::new(),
            composer: feed::Composer::default(),
            reports: reports::Reports::default(),
            live: live::Live::default(),
            fleet: fleet::Fleet::default(),
            ships: ships::Ships::default(),
            ship_composer: feed::Composer::default(),
        }
    }

    /// The layout to save.
    pub fn saved(&self) -> data::Dashboard {
        data::Dashboard {
            layout: layout(&self.panes, self.panes.layout()),
        }
    }

    /// The ship whose live session should be read now: one is picked and
    /// the Live pane is on screen.
    pub fn watching(&self) -> Option<&data::session::Target> {
        self.shows(View::Live).then(|| self.live.target()).flatten()
    }

    /// Whether a view's pane is on screen: open, and not behind a
    /// maximized pane.
    pub fn shows(&self, view: View) -> bool {
        match self.panes.maximized() {
            Some(pane) => self.panes.get(pane).is_some_and(|p| p.view == view),
            None => self.panes.iter().any(|(_, pane)| pane.view == view),
        }
    }

    /// Open a report in the Reports pane, putting the pane on screen.
    fn open_report(
        &mut self,
        opened: reports::Opened,
        connection: &Connection,
    ) -> Option<Event> {
        let read = self
            .reports
            .update(reports::Message::Open(opened), connection);
        let shown = self.update(Message::Open(View::Reports), connection);
        match read {
            Some(reports::Event::Read(id)) => Some(Event::ReadReport(id)),
            _ => shown,
        }
    }

    /// A message from a conversation: the Feed's, or the open ship's.
    fn feed_message(
        &mut self,
        which: Which,
        message: feed::Message,
        connection: &Connection,
    ) -> Option<Event> {
        match message {
            feed::Message::LoadOlder => Some(Event::LoadOlder(which)),
            feed::Message::OpenLink(url) => Some(Event::OpenLink(url)),
            feed::Message::Answer(key) => {
                if !self.answering.remove(&key) {
                    self.answering.insert(key);
                }
                None
            }
            feed::Message::OpenReport(opened) => {
                self.open_report(opened, connection)
            }
            feed::Message::OpenShip(ship) => self.open_ship(ship, connection),
            feed::Message::Compose(message) => {
                let (composer, key) = match which {
                    Which::All => (&mut self.composer, feed::COMPOSE_KEY),
                    Which::Ship => {
                        (&mut self.ship_composer, ships::COMPOSE_KEY)
                    }
                };
                let (command, args) = composer.update(message)?;
                Some(Event::Write {
                    key: key.to_owned(),
                    command,
                    args,
                })
            }
            feed::Message::Triage(message) => {
                self.update(Message::Triage(message), connection)
            }
        }
    }

    /// Show a ship's own conversation and work in Ships.
    fn open_ship(
        &mut self,
        ship: String,
        connection: &Connection,
    ) -> Option<Event> {
        let opened = self.ships.update(ships::Message::Select(ship));
        self.update(Message::Open(View::Ships), connection);
        match opened {
            Some(ships::Event::Open(scope)) => {
                self.ship_composer.address(&scope.ship);
                Some(Event::OpenShip(scope))
            }
            _ => None,
        }
    }

    /// Show a session in Live and read it now.
    fn watch(
        &mut self,
        target: data::session::Target,
        label: String,
        connection: &Connection,
    ) -> Option<Event> {
        let read = self.live.update(live::Message::Pick(target, label));
        self.update(Message::Open(View::Live), connection);
        match read {
            Some(live::Event::Watch(target)) => {
                Some(Event::WatchSession(target))
            }
            _ => None,
        }
    }

    /// What became of a write Triage asked for.
    pub fn written(
        &mut self,
        key: String,
        result: Result<data::privateer::Sent, data::privateer::Error>,
    ) {
        if key == live::LIVE_KEY {
            self.live.written(result);
        } else if key == reports::REPORT_KEY {
            self.reports.written(result);
        } else if key == feed::COMPOSE_KEY {
            self.composer.written(result);
        } else if key == ships::COMPOSE_KEY {
            self.ship_composer.written(result);
        } else {
            self.triage.written(key, result);
        }
    }

    pub fn update(
        &mut self,
        message: Message,
        connection: &Connection,
    ) -> Option<Event> {
        match message {
            Message::Open(view) => {
                // Show the view where it already is; otherwise put it in the
                // focused pane.
                if let Some((pane, _)) =
                    self.panes.iter().find(|(_, p)| p.view == view)
                {
                    self.focus = Some(*pane);
                    return None;
                }
                let pane = self
                    .focus
                    .or_else(|| self.panes.iter().next().map(|(p, _)| *p))?;
                self.panes.get_mut(pane)?.view = view;
                self.focus = Some(pane);
                Some(Event::LayoutChanged)
            }
            Message::Clicked(pane) => {
                self.focus = Some(pane);
                None
            }
            Message::Resized(pane_grid::ResizeEvent { split, ratio }) => {
                self.panes.resize(split, ratio);
                Some(Event::LayoutChanged)
            }
            Message::Dragged(pane_grid::DragEvent::Dropped {
                pane,
                target,
            }) => {
                self.panes.drop(pane, target);
                Some(Event::LayoutChanged)
            }
            Message::Dragged(_) => None,
            Message::Split(pane, axis) => {
                // A new pane shows the first view not on screen yet.
                let view = View::ALL
                    .into_iter()
                    .find(|view| {
                        !self.panes.iter().any(|(_, p)| p.view == *view)
                    })
                    .unwrap_or(View::Triage);
                let (new, _) = self.panes.split(axis, pane, Pane { view })?;
                self.focus = Some(new);
                Some(Event::LayoutChanged)
            }
            Message::Close(pane) => {
                let (_, sibling) = self.panes.close(pane)?;
                self.focus = Some(sibling);
                Some(Event::LayoutChanged)
            }
            Message::ToggleMaximize(pane) => {
                if self.panes.maximized().is_some() {
                    self.panes.restore();
                } else {
                    self.panes.maximize(pane);
                }
                None
            }
            Message::OpenSettings => Some(Event::OpenSettings),
            Message::Refresh => Some(Event::Refresh),
            Message::Feed(message) => {
                self.feed_message(Which::All, message, connection)
            }
            Message::Ships(ships::Message::Feed(message)) => {
                self.feed_message(Which::Ship, message, connection)
            }
            Message::Ships(message) => match self.ships.update(message)? {
                ships::Event::Open(scope) => {
                    self.ship_composer.address(&scope.ship);
                    Some(Event::OpenShip(scope))
                }
                ships::Event::Watch(target, label) => {
                    self.watch(target, label, connection)
                }
            },
            Message::Fleet(message) => match self.fleet.update(message)? {
                fleet::Event::Watch(target, label) => {
                    self.watch(target, label, connection)
                }
                fleet::Event::OpenShip(ship) => {
                    self.open_ship(ship, connection)
                }
            },
            Message::Live(message) => match self.live.update(message)? {
                live::Event::Watch(ship) => Some(Event::WatchSession(ship)),
                live::Event::Write { command, args } => Some(Event::Write {
                    key: live::LIVE_KEY.to_owned(),
                    command,
                    args,
                }),
            },
            Message::Reports(message) => {
                match self.reports.update(message, connection)? {
                    reports::Event::Read(id) => Some(Event::ReadReport(id)),
                    reports::Event::Write { command, args } => {
                        Some(Event::Write {
                            key: reports::REPORT_KEY.to_owned(),
                            command,
                            args,
                        })
                    }
                    reports::Event::OpenLink(url) => Some(Event::OpenLink(url)),
                }
            }
            Message::Triage(message) => {
                match self.triage.update(message, connection)? {
                    triage::Event::Write { key, command, args } => {
                        Some(Event::Write { key, command, args })
                    }
                    triage::Event::OpenLink(url) => Some(Event::OpenLink(url)),
                    triage::Event::OpenReport(opened) => {
                        self.open_report(opened, connection)
                    }
                }
            }
        }
    }

    pub fn view<'a>(
        &'a self,
        config: &'a data::Config,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let sidebar = self.sidebar(config, connection);
        let panes = self.panes(connection, theme);

        let content: Element<'a, Message> = match config.sidebar.position {
            Position::Left => row![sidebar, panes].into(),
            Position::Right => row![panes, sidebar].into(),
        };

        container(content)
            .padding(8)
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
    }

    fn sidebar<'a>(
        &'a self,
        config: &'a data::Config,
        connection: &'a Connection,
    ) -> Element<'a, Message> {
        let waiting =
            connection.waiting.as_ref().map_or(0, |w| w.waiting.len());
        let focused = self
            .focus
            .and_then(|pane| self.panes.get(pane))
            .map(|pane| pane.view);

        let sections = View::ALL.into_iter().map(|view| {
            let is_open = self.panes.iter().any(|(_, pane)| pane.view == view);
            let is_focused = focused == Some(view);

            let mut label = row![
                icon::naval::view(view),
                text(view.title()).width(Length::Fill),
            ]
            .spacing(8)
            .align_y(Alignment::Center);
            if view == View::Triage && waiting > 0 {
                label = label.push(
                    text(waiting.to_string())
                        .style(theme::text::highlight_indicator),
                );
            }

            button(label)
                .width(Length::Fill)
                .padding([5, 8])
                .style(move |theme, status| {
                    theme::button::sidebar_buffer(
                        theme, status, is_focused, is_open,
                    )
                })
                .on_press(Message::Open(view))
                .into()
        });

        let settings = button(
            row![icon::naval::settings(), text("Settings")]
                .spacing(8)
                .align_y(Alignment::Center),
        )
        .width(Length::Fill)
        .padding([5, 8])
        .style(|theme, status| theme::button::secondary(theme, status, false))
        .on_press(Message::OpenSettings);

        let wordmark = text("Quarterdeck")
            .font(font::MONO_BOLD.clone())
            .style(theme::text::primary);

        let padding = match config.sidebar.position {
            Position::Left => Padding::default().right(8),
            Position::Right => Padding::default().left(8),
        };

        container(
            column![
                container(wordmark).padding([4, 8]),
                scrollable(Column::with_children(sections).spacing(2))
                    .style(theme::scrollable::hidden)
                    .height(Length::Fill),
                status(connection),
                settings,
            ]
            .spacing(8),
        )
        .width(f32::from(config.sidebar.width))
        .height(Length::Fill)
        .padding(padding)
        .into()
    }

    fn panes<'a>(
        &'a self,
        connection: &'a Connection,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let count = self.panes.len();
        let maximized = self.panes.maximized().is_some();

        PaneGrid::new(&self.panes, |id, pane, _| {
            let is_focused = self.focus == Some(id);

            let title = row![
                icon::naval::view(pane.view),
                text(pane.view.title()).style(theme::text::buffer_title_bar),
            ]
            .spacing(8)
            .align_y(Alignment::Center);

            let mut controls = row![
                control(
                    icon::popout(),
                    "Split right",
                    Message::Split(id, pane_grid::Axis::Vertical),
                ),
                control(
                    icon::menu(),
                    "Split down",
                    Message::Split(id, pane_grid::Axis::Horizontal),
                ),
            ]
            .spacing(2);
            if count > 1 {
                controls = controls.push(control(
                    if maximized {
                        icon::restore()
                    } else {
                        icon::maximize()
                    },
                    if maximized { "Restore" } else { "Maximize" },
                    Message::ToggleMaximize(id),
                ));
                controls = controls.push(control(
                    icon::cancel(),
                    "Close",
                    Message::Close(id),
                ));
            }

            let body = match pane.view {
                View::Triage => {
                    self.triage.view(connection, theme).map(Message::Triage)
                }
                View::Live => {
                    self.live.view(connection, theme).map(Message::Live)
                }
                View::Reports => {
                    self.reports.view(connection, theme).map(Message::Reports)
                }
                View::Fleet => {
                    self.fleet.view(connection, theme).map(Message::Fleet)
                }
                View::Feed => feed::view(
                    connection,
                    &self.triage,
                    &self.answering,
                    &self.composer,
                    theme,
                )
                .map(Message::Feed),
                View::Ships => self
                    .ships
                    .view(
                        connection,
                        &self.triage,
                        &self.answering,
                        &self.ship_composer,
                        theme,
                    )
                    .map(Message::Ships),
                view => placeholder(view),
            };

            pane_grid::Content::new(body)
                .title_bar(
                    pane_grid::TitleBar::new(title)
                        .controls(pane_grid::Controls::new(controls))
                        .padding([4, 8])
                        .style(theme::container::buffer_title_bar),
                )
                .style(move |theme| theme::container::buffer(theme, is_focused))
        })
        .spacing(6)
        .on_click(Message::Clicked)
        .on_drag(Message::Dragged)
        .on_resize(6, Message::Resized)
        .style(theme::pane_grid::primary)
        .into()
    }
}

fn control<'a>(
    glyph: crate::widget::Text<'a>,
    label: &'a str,
    message: Message,
) -> Element<'a, Message> {
    iced::widget::tooltip(
        button(glyph)
            .padding([2, 6])
            .style(|theme, status| {
                theme::button::secondary(theme, status, false)
            })
            .on_press(message),
        container(text(label).style(theme::text::secondary))
            .padding([2, 6])
            .style(theme::container::tooltip),
        iced::widget::tooltip::Position::Bottom,
    )
    .into()
}

/// Until a view is built, its pane says what it will show.
fn placeholder<'a>(view: View) -> Element<'a, Message> {
    container(
        column![
            text(view.title()).size(18).font(font::MONO_BOLD.clone()),
            text(view.summary()).style(theme::text::secondary),
            space().height(4),
            text("Not built yet.").style(theme::text::tertiary),
        ]
        .spacing(6)
        .max_width(420),
    )
    .padding(16)
    .center(Length::Fill)
    .into()
}

/// Whether Privateer answered, in one line above Settings. Pressing it asks
/// again now.
fn status(connection: &Connection) -> Element<'_, Message> {
    let (glyph, line, style): (_, String, fn(&crate::Theme) -> _) =
        match (&connection.error, connection.source()) {
            (Some(data::privateer::Error::NotConfigured(_)), _) => (
                icon::error(),
                "Privateer not set up".into(),
                theme::text::error,
            ),
            (Some(_), _) => {
                (icon::error(), "Privateer failed".into(), theme::text::error)
            }
            (None, Source::Fixtures) => (
                icon::dot(),
                "Fixtures: invented data".into(),
                theme::text::tertiary,
            ),
            (None, Source::Cli) => match connection.checked_ms {
                Some(at) => (
                    icon::dot(),
                    format!(
                        "Privateer, {}",
                        triage::ago(connection::now_ms() - at)
                    ),
                    theme::text::success,
                ),
                None => (
                    icon::dot(),
                    "Asking Privateer".into(),
                    theme::text::tertiary,
                ),
            },
        };

    let tip = connection
        .error
        .as_ref()
        .map_or_else(|| "Check now".to_owned(), ToString::to_string);

    iced::widget::tooltip(
        button(
            row![glyph.style(style), text(line).style(theme::text::secondary)]
                .spacing(8)
                .align_y(Alignment::Center),
        )
        .width(Length::Fill)
        .padding([4, 8])
        .style(theme::button::bare)
        .on_press(Message::Refresh),
        container(text(tip).style(theme::text::secondary))
            .padding([4, 8])
            .max_width(360)
            .style(theme::container::tooltip),
        iced::widget::tooltip::Position::Top,
    )
    .into()
}

fn configuration(layout: &Layout) -> pane_grid::Configuration<Pane> {
    match layout {
        Layout::Split { axis, ratio, a, b } => {
            pane_grid::Configuration::Split {
                axis: match axis {
                    Axis::Horizontal => pane_grid::Axis::Horizontal,
                    Axis::Vertical => pane_grid::Axis::Vertical,
                },
                ratio: *ratio,
                a: Box::new(configuration(a)),
                b: Box::new(configuration(b)),
            }
        }
        Layout::Pane { view } => {
            pane_grid::Configuration::Pane(Pane { view: *view })
        }
    }
}

fn layout(panes: &pane_grid::State<Pane>, node: &pane_grid::Node) -> Layout {
    match node {
        pane_grid::Node::Split {
            axis, ratio, a, b, ..
        } => Layout::Split {
            axis: match axis {
                pane_grid::Axis::Horizontal => Axis::Horizontal,
                pane_grid::Axis::Vertical => Axis::Vertical,
            },
            ratio: *ratio,
            a: Box::new(layout(panes, a)),
            b: Box::new(layout(panes, b)),
        },
        pane_grid::Node::Pane(pane) => Layout::Pane {
            view: panes.get(*pane).map_or(View::Triage, |pane| pane.view),
        },
    }
}
