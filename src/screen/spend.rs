//! Spend: the model routes in the order crew try them, and the tokens used
//! over a period, grouped by route, ship, day or machine. It only reads.
//! Cache tokens are shown apart and never as spend; what Privateer does not
//! report is said to be not reported.

use data::privateer::Error;
use data::spend::{
    self, Counted, Grouping, Listed, Period, Query, Routes, Summary,
};
use iced::widget::{
    button, column, container, progress_bar, responsive, row, rule, scrollable,
};
use iced::{Alignment, Length};

use crate::Theme;
use crate::appearance::theme;
use crate::connection::{Connection, now_ms};
use crate::font;
use crate::widget::{Column, Element, Row, text};

/// From this width, the routes and the usage sit side by side.
const WIDE: f32 = 1000.0;

#[derive(Debug, Clone)]
pub enum Message {
    Period(Period),
    Grouping(Grouping),
}

#[derive(Default)]
pub struct Spend {
    query: Query,
}

impl Spend {
    /// The usage the view shows now.
    pub fn query(&self) -> Query {
        self.query
    }

    pub fn update(&mut self, message: Message) {
        match message {
            Message::Period(period) => self.query.period = period,
            Message::Grouping(grouping) => self.query.grouping = grouping,
        }
    }

    pub fn view<'a>(
        &'a self,
        connection: &'a Connection,
    ) -> Element<'a, Message> {
        // A wide pane shows the routes and the usage side by side.
        responsive(move |size| {
            let now = now_ms();
            let spend = &connection.spend;
            let routes =
                column![heading("Routes"), routes(spend.routes.as_ref(), now)]
                    .spacing(12)
                    .padding(12);
            let usage = column![
                heading("Usage"),
                self.switches(),
                usage(
                    self.query,
                    spend.usage.as_ref(),
                    spend.usage_error.as_ref(),
                    now
                ),
            ]
            .spacing(12)
            .padding(12);

            if size.width >= WIDE {
                row![
                    scrollable(routes)
                        .width(Length::FillPortion(1))
                        .height(Length::Fill),
                    rule::vertical(1).style(theme::rule::primary),
                    scrollable(usage)
                        .width(Length::FillPortion(2))
                        .height(Length::Fill),
                ]
                .into()
            } else {
                scrollable(column![
                    routes,
                    rule::horizontal(1).style(theme::rule::primary),
                    usage
                ])
                .height(Length::Fill)
                .into()
            }
        })
        .into()
    }

    fn switches(&self) -> Element<'_, Message> {
        let periods = Period::ALL.into_iter().map(|period| {
            switch(
                period.label(),
                period == self.query.period,
                Message::Period(period),
            )
        });
        let groupings = Grouping::ALL.into_iter().map(|grouping| {
            switch(
                grouping.label(),
                grouping == self.query.grouping,
                Message::Grouping(grouping),
            )
        });
        row![
            Row::with_children(periods).spacing(2),
            text("by").style(theme::text::tertiary),
            Row::with_children(groupings).spacing(2),
        ]
        .spacing(10)
        .align_y(Alignment::Center)
        .into()
    }
}

fn heading(title: &str) -> Element<'_, Message> {
    text(title).size(16).font(font::MONO_BOLD.clone()).into()
}

fn switch(
    label: &str,
    selected: bool,
    message: Message,
) -> Element<'_, Message> {
    button(text(label))
        .padding([3, 10])
        .style(move |theme, status| {
            theme::button::secondary(theme, status, selected)
        })
        .on_press(message)
        .into()
}

fn quiet<'a>(line: impl Into<String>) -> Element<'a, Message> {
    text(line.into()).style(theme::text::secondary).into()
}

fn faint<'a>(line: impl Into<String>) -> Element<'a, Message> {
    text(line.into()).style(theme::text::tertiary).into()
}

/// A failed read, or a Privateer that does not offer the command yet.
fn unread<'a>(error: &Error, what: &str) -> Element<'a, Message> {
    match error {
        Error::Command { error, .. } if error.contains("unknown command") => {
            faint(format!("This Privateer does not report {what} yet."))
        }
        error => text(error.to_string()).style(theme::text::error).into(),
    }
}

fn routes<'a>(
    read: Option<&'a Result<Routes, Error>>,
    now: i64,
) -> Element<'a, Message> {
    let routes = match read {
        None => return faint("Reading the routes..."),
        // Without a routes file, routes.show answers null.
        Some(Err(Error::Parse { .. })) => {
            return quiet(
                "No routes file: crew keep their first mate's route and \
                 errands the ship's own.",
            );
        }
        Some(Err(error)) => return unread(error, "routes"),
        Some(Ok(routes)) => routes,
    };

    let mut list = Column::new().spacing(10).push(faint(
        "In the order crew try them. Whether a route is backing off or \
         capped is not shown here yet.",
    ));
    for listed in routes.listed() {
        list = list.push(route(listed, now));
    }
    let own = routes.own_lists();
    if !own.is_empty() {
        let mut ships = row![faint("Ships with route lists of their own:")]
            .spacing(6)
            .align_y(Alignment::Center);
        for ship in own {
            ships = ships.push(
                text(ship).style(move |theme| theme::text::seeded(theme, ship)),
            );
        }
        list = list.push(ships.wrap());
    }
    list.into()
}

fn route<'a>(listed: Listed<'a>, now: i64) -> Element<'a, Message> {
    let route = listed.route;
    let mut header = row![text(listed.name).font(font::MONO_BOLD.clone())]
        .spacing(10)
        .align_y(Alignment::Center);
    header = header.push(text(route.cost().label()).style(theme::text::action));
    if let Some(tier) = route.tier {
        header = header.push(faint(format!("tier {tier}")));
    }
    let places: Vec<String> = [
        ("crew", listed.crew),
        ("errand", listed.errand),
        ("first mate", listed.first_mate),
    ]
    .into_iter()
    .filter_map(|(kind, at)| at.map(|at| format!("{kind} {at}")))
    .collect();
    header = header.push(faint(if places.is_empty() {
        "in no list".to_owned()
    } else {
        places.join(" · ")
    }));

    let mut lines = column![header].spacing(2);
    if let Some(note) = &route.note {
        lines = lines.push(quiet(note.as_str()));
    }
    let mut facts = Vec::new();
    if let Some(allowance) = route.allowance(now) {
        facts.push(allowance);
    }
    if let Some(budget) = route.budget() {
        facts.push(budget.to_owned());
    }
    if !facts.is_empty() {
        lines = lines.push(faint(facts.join("; ")));
    }
    lines.into()
}

fn usage<'a>(
    query: Query,
    read: Option<&'a (Query, Summary)>,
    error: Option<&'a Error>,
    now: i64,
) -> Element<'a, Message> {
    let summary = match (read, error) {
        (Some((asked, summary)), _) if *asked == query => summary,
        (_, Some(error)) => return unread(error, "usage"),
        _ => return faint("Reading usage..."),
    };

    let mut section = Column::new().spacing(8);
    if let Some(error) = error {
        section = section.push(
            text(format!("Showing what was read before: {error}"))
                .style(theme::text::error),
        );
    }

    let missing = summary.missing();
    let period = match query.period {
        Period::Day => "the last 24 hours",
        Period::Week => "the last 7 days (UTC)",
        Period::Month => "the last 30 days (UTC)",
    };
    section = section.push(quiet(if missing.is_empty() {
        format!("Totals for {period}, from every machine.")
    } else {
        format!(
            "Partial totals for {period}, from the machines reached; not \
             fleet-wide."
        )
    }));
    section = section.push(totals(summary));
    section = section.push(machines(summary, now));

    let gaps = summary.gaps();
    if !gaps.is_empty() {
        let names: Vec<String> = gaps
            .iter()
            .map(|harness| format!("{harness} reports no usage"))
            .collect();
        section = section.push(faint(format!(
            "Not counted: {}, for some jobs (jobs from before usage was \
             recorded count here too).",
            names.join("; ")
        )));
    }
    let trimmed = summary.partial_jobs();
    if trimmed > 0 {
        section = section.push(faint(format!(
            "Some logs were trimmed; totals may be low ({trimmed} {}).",
            if trimmed == 1 { "job" } else { "jobs" }
        )));
    }
    section = section.push(table(summary, query.grouping));
    section.into()
}

fn count(n: Option<u64>) -> String {
    n.map_or_else(|| "not reported".to_owned(), spend::tokens)
}

fn totals(summary: &Summary) -> Element<'_, Message> {
    let Some(sum) = summary.totals() else {
        return faint(format!("{} jobs; none reported usage.", summary.jobs()));
    };
    column![
        row![
            text(count(sum.total()))
                .size(18)
                .font(font::MONO_BOLD.clone()),
            quiet(format!(
                "tokens in {} jobs: input {}, output {}",
                summary.jobs(),
                count(sum.input),
                count(sum.output)
            )),
        ]
        .spacing(10)
        .align_y(Alignment::Center),
        faint(format!(
            "Cache, not spend: read {}, written {}",
            count(sum.cache_read),
            count(sum.cache_write)
        )),
        faint(
            "Plan allowance left and credit balances: not reported by \
             Privateer."
        ),
    ]
    .spacing(2)
    .into()
}

/// Each machine the summary read, and how much of it the totals count.
fn machines(summary: &Summary, now: i64) -> Element<'_, Message> {
    let ago = |at: i64| format!("as of {} ago", spend::span(now - at));
    let mut list = Column::new().spacing(2);
    for machine in &summary.machines {
        let (line, style): (String, fn(&Theme) -> _) = match machine.counted() {
            Counted::Fully { as_of_ms: None } => {
                ("included".into(), theme::text::tertiary)
            }
            Counted::Fully { as_of_ms: Some(at) } => {
                (format!("included, {}", ago(at)), theme::text::tertiary)
            }
            Counted::NotUpToDate { as_of_ms, why } => (
                format!("not up to date ({}): {why}", ago(as_of_ms)),
                theme::text::error,
            ),
            Counted::Partly(why) => {
                (format!("partly included: {why}"), theme::text::error)
            }
            Counted::NotIncluded(why) => {
                (format!("not included: {why}"), theme::text::error)
            }
        };
        list = list.push(
            row![
                text(machine.name.as_str()).font(font::MONO_BOLD.clone()),
                text(line).style(style),
            ]
            .spacing(8),
        );
    }
    list.into()
}

const NUMBER: f32 = 64.0;

fn cells<'a>(
    label: Element<'a, Message>,
    values: [String; 6],
    bar: Element<'a, Message>,
    style: fn(&Theme) -> iced::widget::text::Style,
) -> Element<'a, Message> {
    let mut line = row![container(label).width(Length::FillPortion(3))]
        .spacing(8)
        .align_y(Alignment::Center);
    for value in values {
        line = line.push(
            text(value)
                .style(style)
                .width(NUMBER)
                .align_x(iced::alignment::Horizontal::Right),
        );
    }
    line.push(container(bar).width(Length::FillPortion(2)))
        .into()
}

fn table(summary: &Summary, grouping: Grouping) -> Element<'_, Message> {
    let groups = summary.sorted();
    let most = groups
        .iter()
        .filter_map(|g| g.usage.and_then(|u| u.total()))
        .max()
        .unwrap_or(0);

    let mut table = Column::new().spacing(4).push(cells(
        faint(grouping.label()),
        ["jobs", "total", "input", "output", "cache rd", "cache wr"]
            .map(str::to_owned),
        faint(""),
        theme::text::tertiary,
    ));
    for group in groups {
        let usage = group.usage.unwrap_or_default();
        let reported = group.usage.is_some();
        let value = |n: Option<u64>| {
            if reported { count(n) } else { "-".to_owned() }
        };
        let key = group.key.as_str();
        let label: Element<'_, Message> = match grouping {
            Grouping::Day => text(spend::day_label(key)).into(),
            Grouping::Ship => text(key)
                .style(move |theme| theme::text::seeded(theme, key))
                .into(),
            Grouping::Route | Grouping::Machine => text(key).into(),
        };
        let total = usage.total().unwrap_or(0);
        table = table.push(cells(
            label,
            [
                group.jobs.to_string(),
                value(usage.total()),
                value(usage.input),
                value(usage.output),
                value(usage.cache_read),
                value(usage.cache_write),
            ],
            bar(total, most),
            theme::text::primary,
        ));
    }
    // By machine, a machine whose usage is missing is listed without numbers.
    if grouping == Grouping::Machine {
        for machine in &summary.machines {
            if matches!(machine.counted(), Counted::NotIncluded(_))
                && !summary.groups.iter().any(|g| g.key == machine.name)
            {
                table = table.push(cells(
                    text(machine.name.as_str()).into(),
                    std::array::from_fn(|_| "-".to_owned()),
                    faint("not included"),
                    theme::text::tertiary,
                ));
            }
        }
    }
    if summary.groups.is_empty() {
        table = table.push(faint("No harness jobs settled in this period."));
    }
    table.into()
}

fn bar<'a>(total: u64, most: u64) -> Element<'a, Message> {
    if most == 0 || total == 0 {
        return faint("");
    }
    progress_bar(0.0..=most as f32, total as f32)
        .girth(6)
        .style(theme::progress_bar::primary)
        .into()
}
