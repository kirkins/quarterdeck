//! Ships: one first mate at a time. Its conversation with the captain (and,
//! when asked, its other mail), what it is working on, its crew, and a line
//! to write to it. Answers and reports work as in the Feed. Its tools are a
//! second tab.

use std::collections::HashSet;

use data::feed::Scope;
use data::fleet::{Job, Machine, Ship};
use data::session::Target;
use iced::widget::{
    button, checkbox, column, container, row, scrollable, space,
};
use iced::{Alignment, Length, Padding};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{Connection, Which};
use crate::font;
use crate::screen::triage::Triage;
use crate::screen::{feed, tools};
use crate::widget::{Column, Element, loading_line, text};

/// The write key for a message to the open ship.
pub const COMPOSE_KEY: &str = "compose-ship";

#[derive(Debug, Clone)]
pub enum Message {
    Select(String),
    /// Show the ship's other mail too: ship to ship, crew and runtime.
    ShipMail(bool),
    /// Watch a first mate's or crew's live session, under this name.
    Watch(Target, String),
    Feed(feed::Message),
    /// Show the conversation or the tools.
    Tab(Tab),
    Tools(tools::Message),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Tab {
    #[default]
    Conversation,
    Tools,
}

pub enum Event {
    /// Read this ship's conversation.
    Open(Scope),
    Watch(Target, String),
}

#[derive(Default)]
pub struct Ships {
    selected: Option<String>,
    ship_mail: bool,
    tab: Tab,
    tools: tools::Tools,
}

impl Ships {
    /// The conversation to read for the ship on screen.
    pub fn scope(&self) -> Option<Scope> {
        Some(Scope {
            ship: Some(self.selected.clone()?),
            ship_mail: self.ship_mail,
        })
    }

    /// The ship whose tools are on the tab shown.
    pub fn tools_ship(&self) -> Option<&str> {
        self.selected.as_deref().filter(|_| self.tab == Tab::Tools)
    }

    pub fn update(&mut self, message: Message) -> Option<Event> {
        match message {
            Message::Select(ship) => {
                if self.selected.as_ref() != Some(&ship) {
                    self.tools = tools::Tools::default();
                }
                self.selected = Some(ship);
                self.scope().map(Event::Open)
            }
            Message::ShipMail(on) => {
                self.ship_mail = on;
                self.scope().map(Event::Open)
            }
            Message::Watch(target, label) => Some(Event::Watch(target, label)),
            // The tools are read once the tab is on screen.
            Message::Tab(tab) => {
                self.tab = tab;
                None
            }
            Message::Tools(message) => {
                self.tools.update(message);
                None
            }
            // The dashboard handles the conversation's own messages.
            Message::Feed(_) => None,
        }
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
        triage: &'a Triage,
        answering: &'a HashSet<String>,
        composer: &'a feed::Composer,
        theme: &'a Theme,
    ) -> Element<'a, Message> {
        let body: Element<'a, Message> = match &self.selected {
            None => container(
                text("Pick a ship to see its conversation and work.")
                    .style(theme::text::secondary),
            )
            .center(Length::Fill)
            .into(),
            Some(ship) if self.tab == Tab::Tools => column![
                self.header(ship, connection),
                self.tools.view(connection, ship).map(Message::Tools),
            ]
            .into(),
            Some(ship) => column![
                self.header(ship, connection),
                feed::conversation(
                    connection,
                    Which::Ship,
                    triage,
                    answering,
                    None,
                    theme
                )
                .map(Message::Feed),
                composer
                    .view(None, connection.fleet.snapshot.as_ref())
                    .map(Message::Feed),
            ]
            .into(),
        };

        row![
            scrollable(self.list(connection))
                .width(180)
                .height(Length::Fill),
            container(body).width(Length::Fill).height(Length::Fill),
        ]
        .spacing(8)
        .padding(Padding::default().top(8).left(8))
        .into()
    }

    /// Every ship, from the fleet when it is read, else the ships list.
    fn list<'a>(&self, connection: &'a Connection) -> Column<'a, Message> {
        let names: Vec<&'a str> = match &connection.fleet.snapshot {
            Some(snapshot) => snapshot
                .machines
                .iter()
                .flat_map(|m| m.ships.iter().map(|s| s.name.as_str()))
                .collect(),
            None => connection.ships.iter().map(|s| s.name.as_str()).collect(),
        };
        let mut names = names;
        names.sort_unstable();
        names.dedup();
        if names.is_empty()
            && (connection.ships_loading() || connection.fleet_loading())
        {
            return Column::new().push(loading_line("Reading ships"));
        }

        Column::with_children(names.into_iter().map(|name| {
            let picked = self.selected.as_deref() == Some(name);
            let fleet = connection
                .fleet
                .snapshot
                .as_ref()
                .and_then(|s| s.ship(name));
            let mut line = row![
                text(name)
                    .style(move |theme| theme::text::seeded(theme, name))
                    .width(Length::Fill)
            ]
            .spacing(6)
            .align_y(Alignment::Center);
            if let Some((_, ship)) = fleet {
                let crew = ship.jobs.iter().filter(|j| j.is_running()).count();
                if crew > 0 {
                    line = line.push(
                        text(format!("{crew}⚒")).style(theme::text::success),
                    );
                }
            }
            button(line)
                .width(Length::Fill)
                .padding([3, 8])
                .style(move |theme, status| {
                    theme::button::sidebar_buffer(theme, status, picked, picked)
                })
                .on_press(Message::Select(name.to_owned()))
                .into()
        }))
        .spacing(2)
    }

    /// Who the ship is and what it is doing: presence, its open tasks, and
    /// its crew, each live one with a way to watch it.
    fn header<'a>(
        &'a self,
        name: &'a str,
        connection: &'a Connection,
    ) -> Element<'a, Message> {
        let fleet = connection
            .fleet
            .snapshot
            .as_ref()
            .and_then(|s| s.ship(name));

        let mut title = row![
            text(name)
                .size(theme::TEXT_SIZE + 4.0)
                .font(font::MONO_BOLD.clone())
                .style(move |theme| theme::text::seeded(theme, name)),
        ]
        .spacing(12)
        .align_y(Alignment::Center);
        if let Some((machine, ship)) = fleet {
            title = title
                .push(text(facts(machine, ship)).style(theme::text::tertiary));
        }
        title = title
            .push(space().width(Length::Fill))
            .push(tab("Conversation", Tab::Conversation, self.tab))
            .push(tab("Tools", Tab::Tools, self.tab));
        if self.tab == Tab::Conversation {
            title = title.push(
                checkbox(self.ship_mail)
                    .label("Ship and crew mail")
                    .on_toggle(Message::ShipMail)
                    .style(theme::checkbox::primary),
            );
        }
        if fleet.is_some_and(|(_, ship)| ship.hosted) {
            title = title.push(watch(
                Target::first_mate(name),
                name.to_owned(),
                "Watch live",
            ));
        }

        let mut block = column![title].spacing(6);
        if let Some((_, ship)) = fleet {
            block = block.push(work(ship));
        }

        container(block)
            .padding([8, 10])
            .width(Length::Fill)
            .style(theme::container::buffer_title_bar)
            .into()
    }
}

/// Machine, presence, harness and what the ship has outstanding.
fn facts(machine: &Machine, ship: &Ship) -> String {
    let mut parts = vec![machine.name.clone(), ship.presence.as_str().into()];
    if let Some(harness) = &ship.harness {
        parts.push(harness.clone());
    }
    if ship.unread > 0 {
        parts.push(format!("{} unread", ship.unread));
    }
    if ship.open_requests > 0 {
        parts.push(format!("{} open requests", ship.open_requests));
    }
    parts.join(" · ")
}

/// Open tasks and live crew, a line each.
fn work<'a>(ship: &'a Ship) -> Element<'a, Message> {
    let mut lines = Column::new().spacing(3);
    let tasks = ship.open_tasks_total.max(ship.open_tasks.len() as u64);
    if tasks > 0 {
        let titles: Vec<&str> = ship
            .open_tasks
            .iter()
            .take(3)
            .map(|t| t.title.as_deref().unwrap_or(t.id.as_str()))
            .collect();
        let more = tasks.saturating_sub(titles.len() as u64);
        let mut line = format!("Open: {}", titles.join("; "));
        if more > 0 {
            line.push_str(&format!(" and {more} more"));
        }
        lines = lines.push(text(line).style(theme::text::secondary));
    }
    for job in ship
        .jobs
        .iter()
        .filter(|j| j.kind.as_deref() == Some("crew"))
    {
        lines = lines.push(crew(&ship.name, job));
    }
    lines.into()
}

fn crew<'a>(ship: &'a str, job: &'a Job) -> Element<'a, Message> {
    let task = job
        .task_title
        .as_deref()
        .or(job.task_id.as_deref())
        .unwrap_or(job.id.as_str());
    let state = job.state.as_deref().unwrap_or("unknown");
    let mut line = row![
        text(format!("└ {state}")).style(if job.is_running() {
            theme::text::success
        } else {
            theme::text::tertiary
        }),
        text(task).style(theme::text::primary),
    ]
    .spacing(8)
    .align_y(Alignment::Center);
    if let Some(doing) = job.doing.as_ref().filter(|d| !d.text.is_empty()) {
        line = line.push(
            text(doing.text.lines().next().unwrap_or_default())
                .style(theme::text::tertiary),
        );
    }
    if job.session.is_some() {
        line = line.push(space().width(Length::Fill)).push(watch(
            Target::crew(ship, job.id.as_str()),
            format!("{ship} › {task}"),
            "Watch",
        ));
    }
    line.into()
}

fn tab(label: &str, tab: Tab, shown: Tab) -> Element<'_, Message> {
    button(text(label))
        .padding([2, 10])
        .style(move |theme, status| {
            theme::button::secondary(theme, status, tab == shown)
        })
        .on_press(Message::Tab(tab))
        .into()
}

fn watch<'a>(
    target: Target,
    label: String,
    caption: &'a str,
) -> Element<'a, Message> {
    button(text(caption))
        .padding([2, 10])
        .style(|theme, status| theme::button::secondary(theme, status, false))
        .on_press(Message::Watch(target, label))
        .into()
}
