use data::config::Position;
use data::dashboard::{Axis, Layout, View};
use iced::widget::pane_grid::{self, PaneGrid};
use iced::widget::{button, column, container, row, scrollable, space};
use iced::{Alignment, Length, Padding};

use crate::appearance::theme;
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
}

/// What the app must do after an update.
pub enum Event {
    LayoutChanged,
    OpenSettings,
}

#[derive(Debug, Clone, Copy)]
struct Pane {
    view: View,
}

pub struct Dashboard {
    panes: pane_grid::State<Pane>,
    focus: Option<pane_grid::Pane>,
}

impl Dashboard {
    pub fn new(saved: &data::Dashboard) -> Self {
        let panes =
            pane_grid::State::with_configuration(configuration(&saved.layout));
        let focus = panes.iter().next().map(|(pane, _)| *pane);
        Self { panes, focus }
    }

    /// The layout to save.
    pub fn saved(&self) -> data::Dashboard {
        data::Dashboard {
            layout: layout(&self.panes, self.panes.layout()),
        }
    }

    pub fn update(&mut self, message: Message) -> Option<Event> {
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
        }
    }

    pub fn view<'a>(
        &'a self,
        config: &'a data::Config,
    ) -> Element<'a, Message> {
        let sidebar = self.sidebar(config);
        let panes = self.panes();

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

    fn sidebar<'a>(&'a self, config: &'a data::Config) -> Element<'a, Message> {
        let focused = self
            .focus
            .and_then(|pane| self.panes.get(pane))
            .map(|pane| pane.view);

        let sections = View::ALL.into_iter().map(|view| {
            let is_open = self.panes.iter().any(|(_, pane)| pane.view == view);
            let is_focused = focused == Some(view);

            button(
                row![
                    section_icon(view).style(theme::text::secondary),
                    text(view.title()),
                ]
                .spacing(8)
                .align_y(Alignment::Center),
            )
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
            row![
                icon::config().style(theme::text::secondary),
                text("Settings")
            ]
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
                settings,
            ]
            .spacing(8),
        )
        .width(f32::from(config.sidebar.width))
        .height(Length::Fill)
        .padding(padding)
        .into()
    }

    fn panes(&self) -> Element<'_, Message> {
        let count = self.panes.len();
        let maximized = self.panes.maximized().is_some();

        PaneGrid::new(&self.panes, |id, pane, _| {
            let is_focused = self.focus == Some(id);

            let title = row![
                section_icon(pane.view).style(theme::text::secondary),
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

            pane_grid::Content::new(placeholder(pane.view))
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
            text("Not connected to Privateer yet.")
                .style(theme::text::tertiary),
        ]
        .spacing(6)
        .max_width(420),
    )
    .padding(16)
    .center(Length::Fill)
    .into()
}

fn section_icon<'a>(view: View) -> crate::widget::Text<'a> {
    match view {
        View::Triage => icon::bell(),
        View::Feed => icon::mail_alt(),
        View::Ships => icon::people(),
        View::Fleet => icon::globe(),
        View::Spend => icon::highlights(),
        View::Reports => icon::book(),
    }
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
