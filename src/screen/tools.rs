//! A ship's tools, read only, from `ship.profile`: its model routes,
//! charter, permissions, skills, MCP servers, plugins, and sleep and
//! hosting. A secret shows only whether it is set.

use std::collections::HashSet;

use data::privateer::Error;
use data::profile::{Opt, Profile, Read, Routes, Shown, Sleep};
use iced::widget::{button, column, container, row, scrollable};
use iced::{Alignment, Length};

use crate::appearance::theme;
use crate::connection::Connection;
use crate::font;
use crate::widget::{Column, Element, loading, text};

/// Lists longer than this are folded behind a count.
const FOLD_AFTER: usize = 5;

#[derive(Debug, Clone)]
pub enum Message {
    /// Show all of a list, or fold it again.
    Fold(List),
}

/// The lists that fold.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum List {
    Charter,
    Rules,
    Skills,
    Servers,
    Plugins,
}

#[derive(Default)]
pub struct Tools {
    /// The lists shown in full.
    unfolded: HashSet<List>,
}

impl Tools {
    pub fn update(&mut self, message: Message) {
        match message {
            Message::Fold(list) => {
                if !self.unfolded.remove(&list) {
                    self.unfolded.insert(list);
                }
            }
        }
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
        ship: &str,
    ) -> Element<'a, Message> {
        let tools = &connection.tools;
        let read = tools
            .read
            .as_ref()
            .filter(|_| tools.ship.as_deref() == Some(ship));
        match read {
            None => loading("Reading the ship's tools"),
            Some(Err(error)) => centered(unread(error, ship)),
            Some(Ok(Read::Elsewhere(machine))) => centered(
                text(format!(
                    "This ship runs on {machine}; its tools are read on that \
                     machine"
                ))
                .style(theme::text::secondary)
                .into(),
            ),
            Some(Ok(Read::Profile(profile))) => scrollable(
                self.profile(profile).padding([12, 14]).width(Length::Fill),
            )
            .height(Length::Fill)
            .into(),
        }
    }

    fn profile<'a>(&'a self, profile: &'a Profile) -> Column<'a, Message> {
        let mut page = Column::new().spacing(18);
        if let Some(error) = &profile.bundles_error {
            page = page.push(
                text(format!(
                    "The first mate's tool plan could not be built: {error}"
                ))
                .style(theme::text::error),
            );
        }

        page = page.push(section(
            "Model routes",
            column![
                faint("Which routes each kind of job tries, in order."),
                Column::with_children(profile.routes.iter().map(routes))
                    .spacing(4),
                fact("Harness", profile.harness.as_deref()),
                Column::with_children(profile.options.iter().map(option))
                    .spacing(2),
            ]
            .spacing(8),
        ));

        let mut charter = Column::new().spacing(4);
        if profile.charter.active == Some(false) {
            charter = charter.push(faint("The charter is inactive."));
        }
        charter = charter.push(self.fold(
            List::Charter,
            "actions",
            profile.charter.actions.iter().map(|a| line(a)).collect(),
            "No charter actions.",
        ));
        page = page.push(section("Charter", charter));

        page = page.push(section(
            "Permissions",
            column![
                fact("Fleet mode", profile.fleet_mode.as_deref()),
                text("Fleet rules").style(theme::text::tertiary),
                self.fold(
                    List::Rules,
                    "rules",
                    profile.fleet_rules.iter().map(|r| line(r)).collect(),
                    "None.",
                ),
            ]
            .spacing(4),
        ));

        let unbounded = profile.bounded == Some(false);
        page = page.push(section(
            &count_title("Skills", profile.skills.len()),
            column![
                faint("The first mate's bounded plan only."),
                if unbounded {
                    faint("Not listed: this first mate loads its own skills.")
                } else {
                    self.fold(
                        List::Skills,
                        "skills",
                        profile
                            .skills
                            .iter()
                            .map(|s| tool(&s.name, s.description.as_deref()))
                            .collect(),
                        "No skills.",
                    )
                },
            ]
            .spacing(4),
        ));

        page = page.push(section(
            &count_title("MCP servers", profile.mcp_servers.len()),
            column![
                faint("The first mate's bounded plan only."),
                if unbounded {
                    faint("Not listed: this first mate loads its own servers.")
                } else {
                    self.fold(
                        List::Servers,
                        "servers",
                        profile.mcp_servers.iter().map(server).collect(),
                        "No MCP servers.",
                    )
                },
            ]
            .spacing(4),
        ));

        page = page.push(section(
            &count_title("Plugins", profile.plugins.len()),
            self.fold(
                List::Plugins,
                "plugins",
                profile
                    .plugins
                    .iter()
                    .map(|p| tool(&p.name, p.description.as_deref()))
                    .collect(),
                "No plugins.",
            ),
        ));

        page.push(section(
            "Sleep and hosting",
            column![
                fact("Machine", profile.machine.as_deref()),
                fact(
                    "Hosted",
                    profile.hosted.map(|h| if h { "yes" } else { "no" })
                ),
                fact("Sleep", Some(&sleep(&profile.sleep))),
            ]
            .spacing(4),
        ))
    }

    /// A list, folded behind a count when it is longer than five.
    fn fold<'a>(
        &self,
        list: List,
        noun: &str,
        items: Vec<Element<'a, Message>>,
        empty: &'a str,
    ) -> Element<'a, Message> {
        if items.is_empty() {
            return faint(empty);
        }
        let total = items.len();
        let open = self.unfolded.contains(&list);
        let mut shown = Column::new().spacing(6);
        for item in
            items
                .into_iter()
                .take(if open { total } else { FOLD_AFTER })
        {
            shown = shown.push(item);
        }
        if total > FOLD_AFTER {
            let label = if open {
                "Show fewer".to_owned()
            } else {
                format!("Show all {total} {noun}")
            };
            shown = shown.push(
                button(text(label).style(theme::text::action))
                    .padding(0)
                    .style(theme::button::bare)
                    .on_press(Message::Fold(list)),
            );
        }
        shown.into()
    }
}

fn centered(content: Element<'_, Message>) -> Element<'_, Message> {
    container(content).padding(16).center(Length::Fill).into()
}

/// A read that failed, a ship Privateer has no profile for, or a Privateer
/// without `ship.profile`.
fn unread<'a>(error: &Error, ship: &str) -> Element<'a, Message> {
    let message = error.to_string();
    if message.contains("unknown command") {
        faint("This Privateer does not report a ship's tools yet.")
    } else if message.contains(&format!("unknown ship {ship}")) {
        faint(format!("Privateer has no tools for {ship}."))
    } else {
        text(message).style(theme::text::error).into()
    }
}

fn section<'a>(
    title: &str,
    body: impl Into<Element<'a, Message>>,
) -> Element<'a, Message> {
    column![
        text(title.to_owned())
            .size(16)
            .font(font::MONO_BOLD.clone()),
        body.into(),
    ]
    .spacing(6)
    .into()
}

fn count_title(title: &str, count: usize) -> String {
    format!("{title} ({count})")
}

fn faint<'a>(line: impl Into<String>) -> Element<'a, Message> {
    text(line.into()).style(theme::text::tertiary).into()
}

fn line(item: &str) -> Element<'_, Message> {
    text(format!("· {item}")).style(theme::text::primary).into()
}

/// A labelled value, or "not reported".
fn fact<'a>(label: &'a str, value: Option<&str>) -> Element<'a, Message> {
    row![
        text(label).style(theme::text::tertiary).width(110),
        match value {
            Some(value) => text(value.to_owned()).style(theme::text::primary),
            None => text("not reported").style(theme::text::tertiary),
        },
    ]
    .spacing(8)
    .into()
}

fn routes(routes: &Routes) -> Element<'_, Message> {
    let kind = match routes.kind.as_str() {
        "first_mate" => "First mate".to_owned(),
        "crew" => "Crew".to_owned(),
        "errand" => "Errands".to_owned(),
        other => other.replace('_', " "),
    };
    let list = match routes.list.as_deref() {
        Some("ship") => "this ship's list",
        Some("fleet") => "fleet default",
        Some("none") => "no routes",
        _ => "list not reported",
    };
    let names: Vec<String> = routes
        .names
        .iter()
        .map(|route| {
            let mut facts = Vec::new();
            facts.extend(route.cost.clone());
            facts.extend(route.tier.map(|tier| format!("tier {tier}")));
            if !route.uses.is_empty() {
                facts.push(format!("uses {}", route.uses.join("/")));
            }
            if facts.is_empty() {
                route.name.clone()
            } else {
                format!("{} ({})", route.name, facts.join(", "))
            }
        })
        .collect();
    let mut line = row![
        text(kind).style(theme::text::tertiary).width(110),
        text(list).style(theme::text::secondary),
    ]
    .spacing(8);
    if !names.is_empty() {
        line = line.push(text(names.join(" › ")).style(theme::text::primary));
    }
    line.into()
}

/// A first-mate option: a secret says only whether it is set.
fn option(option: &Opt) -> Element<'_, Message> {
    let value = match &option.value {
        Shown::Secret { set: true } => {
            text("secret, set").style(theme::text::secondary)
        }
        Shown::Secret { set: false } => {
            text("secret, not set").style(theme::text::tertiary)
        }
        Shown::Value(value) => text(value.as_str()).style(theme::text::primary),
        Shown::NotSet => text("not set").style(theme::text::tertiary),
    };
    row![
        text(option.name.as_str())
            .style(theme::text::tertiary)
            .width(110),
        value,
    ]
    .spacing(8)
    .into()
}

fn tool<'a>(
    name: &'a str,
    description: Option<&'a str>,
) -> Element<'a, Message> {
    let mut item = column![text(name).font(font::MONO.clone())].spacing(1);
    if let Some(description) = description {
        item = item.push(text(description).style(theme::text::secondary));
    }
    item.into()
}

fn server(server: &data::profile::Server) -> Element<'_, Message> {
    let mut item =
        column![text(server.name.as_str()).font(font::MONO.clone())].spacing(1);
    if let Some(description) = &server.description {
        item =
            item.push(text(description.as_str()).style(theme::text::secondary));
    }
    if let Some(url) = &server.url {
        item = item.push(text(url.as_str()).style(theme::text::tertiary));
    }
    if !server.credentials.is_empty() {
        item = item.push(
            text(format!("Credentials: {}", server.credentials.join(", ")))
                .style(theme::text::tertiary),
        );
    }
    item.align_x(Alignment::Start).into()
}

fn sleep(sleep: &Sleep) -> String {
    match (sleep.policy.as_deref(), sleep.idle_minutes) {
        (Some("after_idle"), Some(minutes)) => {
            format!("after {minutes} min idle")
        }
        (Some("after_idle"), None) => "when idle".to_owned(),
        (Some("never"), _) => "never: stays awake".to_owned(),
        (Some("not_hosted"), _) => "not hosted: woken for each turn".to_owned(),
        (Some(other), _) => other.to_owned(),
        (None, _) => "not reported".to_owned(),
    }
}
