//! The Fleet: machine, then ship, then crew, as Privateer's `fleet.snapshot`
//! last read them. What needs the captain and running crew come first. It
//! only reads; nothing here changes the fleet.

use std::collections::HashSet;

use data::fleet::{Board, Job, Machine, MachineRow, Ship, ShipRow, Wait};
use data::session::Target;
use iced::widget::{button, column, container, row, scrollable, space};
use iced::{Alignment, Length, Padding};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{self, Connection};
use crate::font;
use crate::widget::{Column, Element, Row, loading, text};

type Style = fn(&Theme) -> iced::widget::text::Style;

#[derive(Debug, Clone)]
pub enum Message {
    /// Fold or unfold a machine's ships, by its name.
    Toggle(String),
    /// Watch a first mate's or crew's live session, under this name.
    Watch(Target, String),
    /// Open a ship's own conversation and work.
    OpenShip(String),
}

pub enum Event {
    Watch(Target, String),
    OpenShip(String),
}

#[derive(Default)]
pub struct Fleet {
    folded: HashSet<String>,
}

impl Fleet {
    pub fn update(&mut self, message: Message) -> Option<Event> {
        match message {
            Message::Watch(target, label) => Some(Event::Watch(target, label)),
            Message::OpenShip(ship) => Some(Event::OpenShip(ship)),
            Message::Toggle(machine) => {
                if !self.folded.remove(&machine) {
                    self.folded.insert(machine);
                }
                None
            }
        }
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
        _theme: &'a Theme,
    ) -> Element<'a, Message> {
        let fleet = &connection.fleet;
        let Some(snapshot) = &fleet.snapshot else {
            if fleet.error.is_none() {
                return loading("Reading the fleet");
            }
            let message = match &fleet.error {
                Some(error) if error.to_string().contains("unknown") => {
                    "This Privateer does not offer a fleet view yet.".to_owned()
                }
                Some(error) => error.to_string(),
                None => "Reading the fleet...".to_owned(),
            };
            return container(text(message).style(theme::text::secondary))
                .padding(16)
                .center(Length::Fill)
                .into();
        };

        let now = connection::now_ms();
        let board = Board::build(snapshot);

        let mut list = Column::new().spacing(16).padding(12);
        list = list.push(summary(&board));
        if let Some(error) = &fleet.error {
            list = list.push(
                text(format!("Showing what was read before: {error}"))
                    .style(theme::text::error),
            );
        }
        if board.machines.is_empty() {
            list = list.push(
                text("Privateer knows no machines.")
                    .style(theme::text::secondary),
            );
        }
        for row in &board.machines {
            let machine = &snapshot.machines[row.index];
            let folded = self.folded.contains(&machine.name);
            list = list.push(machine_view(machine, row, folded, now));
        }

        scrollable(list).height(Length::Fill).into()
    }
}

/// One line of counts across the fleet.
fn summary<'a>(board: &Board) -> Element<'a, Message> {
    let s = &board.summary;
    let mut parts: Vec<(String, Style)> = vec![
        (
            format!(
                "{} of {} machines reachable",
                s.machines_reachable, s.machines_total
            ),
            if s.machines_reachable < s.machines_total {
                theme::text::error
            } else {
                theme::text::secondary
            },
        ),
        (
            count(s.ships_awake, "ship awake", "ships awake"),
            theme::text::secondary,
        ),
        (
            count(s.crew_running, "crew running", "crew running"),
            theme::text::secondary,
        ),
    ];
    if s.crew_waiting > 0 {
        parts.push((
            format!("{} waiting", s.crew_waiting),
            theme::text::tertiary,
        ));
    }
    if s.crew_orphaned > 0 {
        parts.push((
            format!("{} orphaned", s.crew_orphaned),
            theme::text::error,
        ));
    }
    if s.ships_unsure > 0 {
        parts.push((
            count(s.ships_unsure, "ship unknown", "ships unknown"),
            theme::text::action,
        ));
    }
    parts.push((
        count(s.needs, "item needs you", "items need you"),
        if s.needs > 0 {
            theme::text::highlight_indicator
        } else {
            theme::text::secondary
        },
    ));
    dotted(parts)
}

fn machine_view<'a>(
    machine: &'a Machine,
    board: &MachineRow,
    folded: bool,
    now: i64,
) -> Element<'a, Message> {
    let dim = !machine.reachable;

    let mut badges: Vec<(String, Style)> = vec![if machine.reachable {
        ("reachable".into(), theme::text::success)
    } else {
        ("unreachable".into(), theme::text::error)
    }];
    if machine.desk {
        badges.push(("desk".into(), theme::text::action));
    }
    if machine.stowed == Some(true) {
        badges.push(("stowed".into(), theme::text::tertiary));
    }
    if machine.truncated {
        badges.push(("partial".into(), theme::text::action));
    }
    if folded {
        badges.push((
            count(machine.ships.len(), "ship", "ships"),
            theme::text::tertiary,
        ));
    }

    let when = if machine.reachable {
        machine
            .changed_ms
            .map(|at| format!("updated {}", ago(now - at)))
    } else {
        machine
            .as_of_ms
            .map(|at| format!("last known {}", ago(now - at)))
    };

    let header = button(
        row![
            text(machine.name.as_str())
                .font(font::MONO_BOLD.clone())
                .style(if dim {
                    theme::text::tertiary
                } else {
                    theme::text::primary
                }),
            dotted(badges),
            space().width(Length::Fill),
            text(when.unwrap_or_default()).style(theme::text::tertiary),
        ]
        .spacing(12)
        .align_y(Alignment::Center),
    )
    .width(Length::Fill)
    .padding([4, 8])
    .style(theme::button::bare)
    .on_press(Message::Toggle(machine.name.clone()));

    let mut section =
        column![container(header).style(theme::container::buffer_title_bar)]
            .spacing(8);

    if folded {
        return section.into();
    }

    let mut notes = Column::new().spacing(2).padding([0, 8]);
    if !machine.reachable {
        let error = machine.error.as_deref().unwrap_or("not reached");
        notes = notes.push(
            text(format!("{error}. Shown as last known."))
                .style(theme::text::tertiary),
        );
    }
    if machine.truncated {
        notes = notes.push(
            text(
                "Partial: some ships, tasks or crew were left out to fit; \
                 ships held from the last read are kept.",
            )
            .style(theme::text::tertiary),
        );
    }
    if !machine.unknown.is_empty() {
        notes = notes.push(
            text(format!("Could not check: {}", machine.unknown.join(", ")))
                .style(theme::text::tertiary),
        );
    }
    section = section.push(notes);

    if board.ships.is_empty() {
        section = section.push(
            container(text("No ships.").style(theme::text::tertiary))
                .padding([0, 8]),
        );
    }
    for ship in &board.ships {
        section =
            section.push(ship_view(&machine.ships[ship.index], ship, dim, now));
    }

    section.into()
}

fn ship_view<'a>(
    ship: &'a Ship,
    board: &ShipRow,
    dim: bool,
    now: i64,
) -> Element<'a, Message> {
    let name = text(ship.name.as_str()).font(font::MONO_BOLD.clone());
    let name = if dim {
        name.style(theme::text::tertiary)
    } else {
        name.style(move |theme| theme::text::seeded(theme, &ship.name))
    };
    let name = button(name)
        .padding(0)
        .style(theme::button::bare)
        .on_press(Message::OpenShip(ship.name.clone()));

    let presence = ship.presence;
    let mut label = presence.as_str().to_owned();
    if let Some(since) = ship.presence_since_ms.filter(|&at| at <= now) {
        label = format!("{label} for {}", span(now - since));
    }
    let presence_style: Style = if dim {
        theme::text::tertiary
    } else if presence.is_awake() {
        theme::text::success
    } else if presence.is_unsure() {
        theme::text::action
    } else {
        theme::text::secondary
    };

    let mut facts: Vec<(String, Style)> = vec![(label, presence_style)];
    let tasks = ship.open_tasks_total.max(ship.open_tasks.len() as u64);
    if tasks > 0 {
        facts.push((
            count(tasks as usize, "open task", "open tasks"),
            theme::text::tertiary,
        ));
    }
    if board.needs > 0 {
        facts.push((
            count(board.needs, "needs you", "need you"),
            theme::text::highlight_indicator,
        ));
    }

    let mut head = row![name, dotted(facts)]
        .spacing(12)
        .align_y(Alignment::Center);
    if ship.hosted && !dim {
        head = head.push(space().width(Length::Fill)).push(watch(
            Target::first_mate(ship.name.as_str()),
            ship.name.clone(),
        ));
    }
    let mut block = column![head].spacing(4);

    let mut crew = Column::new()
        .spacing(6)
        .padding(Padding::default().left(16));
    for job in &ship.jobs {
        crew = crew.push(job_view(&ship.name, job, dim, now));
    }
    let hidden = (ship.jobs_total as usize).saturating_sub(ship.jobs.len());
    if hidden > 0 {
        crew = crew.push(
            text(format!("and {hidden} more")).style(theme::text::tertiary),
        );
    }
    block = block.push(crew);

    container(block).padding([0, 8]).into()
}

fn job_view<'a>(
    ship: &str,
    job: &'a Job,
    dim: bool,
    now: i64,
) -> Element<'a, Message> {
    let state = job.state.as_deref().unwrap_or("unknown");
    let state_style: Style = if job.is_orphaned() {
        theme::text::error
    } else if dim {
        theme::text::tertiary
    } else if job.is_running() {
        theme::text::success
    } else {
        theme::text::secondary
    };

    let title = job
        .task_title
        .as_deref()
        .or(job.task_id.as_deref())
        .unwrap_or(job.id.as_str());

    let mut head: Vec<(String, Style)> = vec![
        (state.to_owned(), state_style),
        (
            title.to_owned(),
            if dim {
                theme::text::tertiary
            } else {
                theme::text::primary
            },
        ),
    ];
    if let Some(began) = job.began_ms().filter(|&at| at <= now) {
        head.push((span(now - began), theme::text::tertiary));
    }
    if let Some(kind) = job.kind.as_deref().filter(|k| *k != "crew") {
        head.push((kind.replace('_', " "), theme::text::tertiary));
    }
    if job.heavy {
        head.push(("heavy".into(), theme::text::tertiary));
    }

    let mut first = row![dotted(head)].spacing(12).align_y(Alignment::Center);
    if job.session.is_some() && !dim {
        first = first.push(space().width(Length::Fill)).push(watch(
            Target::crew(ship, job.id.as_str()),
            format!("{ship} › {title}"),
        ));
    }
    let mut lines = column![first].spacing(2);
    if let Some(doing) = job.doing.as_ref().filter(|d| !d.text.is_empty()) {
        lines = lines.push(text(doing.text.as_str()).style(if dim {
            theme::text::tertiary
        } else {
            theme::text::secondary
        }));
    }
    if job.is_orphaned() {
        lines = lines.push(
            text("Orphaned: no process is running it.")
                .style(theme::text::error),
        );
    }
    if let Some(wait) = &job.wait {
        lines = lines
            .push(text(wait_label(wait, now)).style(theme::text::tertiary));
    }
    lines.into()
}

/// A button that opens a session in Live.
fn watch<'a>(target: Target, label: String) -> Element<'a, Message> {
    button(text("Watch").size(theme::TEXT_SIZE - 1.0))
        .padding([1, 8])
        .style(|theme, status| theme::button::secondary(theme, status, false))
        .on_press(Message::Watch(target, label))
        .into()
}

/// Why a job is not moving, in words: what it waits for, since when, and
/// what it waits behind.
fn wait_label(wait: &Wait, now: i64) -> String {
    let since = wait
        .since_ms
        .filter(|&at| at <= now)
        .map(|at| format!(" for {}", span(now - at)))
        .unwrap_or_default();
    let mut label = match wait.on.as_deref() {
        Some("job") => format!(
            "waiting on {}{since}",
            wait.job_id.as_deref().unwrap_or("another job")
        ),
        Some("capacity") => format!("waiting for capacity{since}"),
        Some("disk") => format!("waiting for disk{since}"),
        _ => format!("waiting{since}"),
    };
    if let Some(park) = &wait.park {
        label.push_str(&format!(" · {park}"));
    }
    let behind: Vec<String> = wait
        .behind
        .iter()
        .map(|b| {
            let mut who = b.job_id.clone().unwrap_or("another job".into());
            if let Some(ship) = &b.ship {
                who.push_str(&format!(" on {ship}"));
            }
            if b.unhealthy {
                who.push_str(" (unhealthy)");
            }
            who
        })
        .collect();
    if !behind.is_empty() {
        label.push_str(&format!(" · behind {}", behind.join(", ")));
    }
    label
}

/// Pieces of a line, each in its style, with dots between.
fn dotted<'a>(parts: Vec<(String, Style)>) -> Element<'a, Message> {
    let mut line = Row::new().spacing(6);
    for (i, (part, style)) in parts.into_iter().enumerate() {
        if i > 0 {
            line = line.push(text("·").style(theme::text::tertiary));
        }
        line = line.push(text(part).style(style));
    }
    line.wrap().into()
}

fn count(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// A length of time, short: 12s, 5m, 3h, 2d.
fn span(ms: i64) -> String {
    let seconds = ms.max(0) / 1000;
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        3600..86_400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

fn ago(ms: i64) -> String {
    format!("{} ago", span(ms))
}
