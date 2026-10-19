//! Spend: the model routes the captain set, from `routes.show`, and the
//! tokens harness jobs used, from `usage.summary`.
//!
//! `routes.show` is the fleet's routes file: named routes, and the lists
//! crew, errands and first mates try them in. `usage.summary` sums what
//! settled jobs reported over a period, grouped by route, ship, UTC day or
//! machine, and lists every machine it read or could not. A harness that
//! reports nothing is named in a group's `gaps`, never counted as zero.
//! Plan allowances left and credit balances are not reported by Privateer:
//! they are said to be not reported, never guessed.

use std::collections::{BTreeMap, BTreeSet};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::fleet::{LiveAllowance, RouteState, Snapshot};

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
/// Privateer's weekdays, Monday first, as `weekly_utc` names them.
const WEEKDAYS: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct",
    "Nov", "Dec",
];

/// The fleet's routes file, as `routes.show` returns it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Routes {
    pub routes: BTreeMap<String, Route>,
    pub crew: Vec<String>,
    pub errand: Vec<String>,
    pub first_mate: Vec<String>,
    /// Ships with lists of their own, and which kinds those replace.
    pub ships: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Route {
    /// `free`, `plan` or `credits`.
    pub cost: Option<String>,
    pub note: Option<String>,
    pub manifest: Option<String>,
    /// 1, the strongest, to 9.
    pub tier: Option<u64>,
    pub uses: Vec<String>,
    /// The older way to state a daily renewal: `HH:MM` in UTC.
    pub allowance_resets_utc: Option<String>,
    pub allowance: Option<Allowance>,
}

/// The shape of a route's allowance, as the captain declared it. How much
/// of it is used is not in the routes file.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Allowance {
    pub daily_utc: Option<String>,
    pub window_hours: Option<u64>,
    pub weekly_utc: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Cost {
    Free,
    Plan,
    Credits,
    Unknown,
}

fn cost_of(cost: Option<&str>) -> Cost {
    match cost {
        Some("free") => Cost::Free,
        Some("plan") => Cost::Plan,
        Some("credits") => Cost::Credits,
        _ => Cost::Unknown,
    }
}

impl Cost {
    pub fn label(self) -> &'static str {
        match self {
            Cost::Free => "free",
            Cost::Plan => "plan",
            Cost::Credits => "credits",
            Cost::Unknown => "cost not reported",
        }
    }

    /// What is left of a plan or credits: Privateer does not report it.
    pub fn budget(self) -> Option<&'static str> {
        match self {
            Cost::Plan => Some("plan allowance left: not reported"),
            Cost::Credits => Some("credit balance: not reported"),
            Cost::Free | Cost::Unknown => None,
        }
    }
}

/// A route as the Spend view lists it: where each kind of launch tries it.
#[derive(Debug, Clone, PartialEq)]
pub struct Listed<'a> {
    pub name: &'a str,
    pub route: &'a Route,
    /// Its place, from 1, in the crew, errand and first-mate lists.
    pub crew: Option<usize>,
    pub errand: Option<usize>,
    pub first_mate: Option<usize>,
}

/// A route as the Spend view lists it: its declared shape from `routes.show`,
/// where crew, errands and first mates try it, and its state on each machine
/// that reports it, from `fleet.snapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row<'a> {
    pub name: &'a str,
    /// From `routes.show`; None for a route only a machine reports.
    pub declared: Option<&'a Route>,
    /// Its place, from 1, in the crew, errand and first-mate lists.
    pub crew: Option<usize>,
    pub errand: Option<usize>,
    pub first_mate: Option<usize>,
    /// Its state on each machine that reports it, in the snapshot's order.
    pub live: Vec<Live<'a>>,
}

/// A route's state on one machine, as `fleet.snapshot` reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Live<'a> {
    pub machine: &'a str,
    pub state: RouteState,
    pub cost: Option<&'a str>,
    /// Its identity: harness, provider and model.
    pub identity: Option<&'a str>,
    pub until_ms: Option<i64>,
    pub error: Option<&'a str>,
    pub allowance: Option<&'a LiveAllowance>,
}

impl Live<'_> {
    /// "available", "idle (usable)", "backing off, back in 7m" or "capped,
    /// resets in 2h 10m". The time is left off once it has passed.
    pub fn label(&self, now_ms: i64) -> String {
        let until = self.until_ms.filter(|at| *at > now_ms);
        match (self.state, until) {
            (RouteState::Available, _) => "available".into(),
            (RouteState::Idle, _) => "idle (usable)".into(),
            (RouteState::BackingOff, Some(at)) => {
                format!("backing off, back in {}", span(at - now_ms))
            }
            (RouteState::BackingOff, None) => "backing off".into(),
            (RouteState::Capped, Some(at)) => {
                format!("capped, resets in {}", span(at - now_ms))
            }
            (RouteState::Capped, None) => "capped".into(),
            (RouteState::Unknown, _) => "state not reported".into(),
        }
    }
}

impl Row<'_> {
    pub fn cost(&self) -> Cost {
        match self.declared {
            Some(route) => route.cost(),
            None => cost_of(self.live.iter().find_map(|l| l.cost)),
        }
    }

    /// Held off on any machine.
    pub fn throttled(&self) -> bool {
        self.live.iter().any(|l| l.state.is_throttled())
    }
}

impl Routes {
    pub fn parse(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    /// Every route `routes.show` names and every route a machine reports:
    /// the throttled first, then in the order crew try them, then the rest by
    /// name. `routes` is None until it is read; `snapshot` likewise.
    pub fn rows<'a>(
        routes: Option<&'a Routes>,
        snapshot: Option<&'a Snapshot>,
    ) -> Vec<Row<'a>> {
        let place = |list: &[String], name: &str| {
            list.iter().position(|n| n == name).map(|at| at + 1)
        };
        let mut rows: BTreeMap<&'a str, Row<'a>> = BTreeMap::new();
        if let Some(routes) = routes {
            for (name, route) in &routes.routes {
                let name = name.as_str();
                rows.insert(
                    name,
                    Row {
                        name,
                        declared: Some(route),
                        crew: place(&routes.crew, name),
                        errand: place(&routes.errand, name),
                        first_mate: place(&routes.first_mate, name),
                        live: vec![],
                    },
                );
            }
        }
        for machine in snapshot.into_iter().flat_map(|s| &s.machines) {
            for route in &machine.routes {
                // A ledger hold no listed route names has only its identity.
                let Some(name) =
                    route.name.as_deref().or(route.route.as_deref())
                else {
                    continue;
                };
                rows.entry(name)
                    .or_insert_with(|| Row {
                        name,
                        declared: None,
                        crew: None,
                        errand: None,
                        first_mate: None,
                        live: vec![],
                    })
                    .live
                    .push(Live {
                        machine: &machine.name,
                        state: route.state,
                        cost: route.cost.as_deref(),
                        identity: route.route.as_deref(),
                        until_ms: route.until_ms,
                        error: route.error.as_deref(),
                        allowance: route.allowance.as_ref(),
                    });
            }
        }
        let mut rows: Vec<Row<'a>> = rows.into_values().collect();
        rows.sort_by_key(|row| {
            (
                !row.throttled(),
                row.crew.unwrap_or(usize::MAX),
                row.errand.unwrap_or(usize::MAX),
                row.first_mate.unwrap_or(usize::MAX),
                row.name,
            )
        });
        rows
    }

    /// Every route, in the order crew try them; then the ones only errands
    /// or first mates try, in their order; then the rest by name.
    pub fn listed(&self) -> Vec<Listed<'_>> {
        let place = |list: &[String], name: &str| {
            list.iter().position(|n| n == name).map(|at| at + 1)
        };
        let mut listed: Vec<Listed<'_>> = self
            .routes
            .iter()
            .map(|(name, route)| Listed {
                name,
                route,
                crew: place(&self.crew, name),
                errand: place(&self.errand, name),
                first_mate: place(&self.first_mate, name),
            })
            .collect();
        listed.sort_by_key(|l| {
            (
                l.crew.unwrap_or(usize::MAX),
                l.errand.unwrap_or(usize::MAX),
                l.first_mate.unwrap_or(usize::MAX),
            )
        });
        listed
    }

    /// Ships that try routes in lists of their own, A to Z.
    pub fn own_lists(&self) -> Vec<&str> {
        self.ships.keys().map(String::as_str).collect()
    }
}

/// A live allowance's shares as percents, and when each window resets:
/// "allowance: window 40% used, resets in 2h · week 87% used". None when
/// the machine reports no share.
pub fn live_allowance(
    allowance: &LiveAllowance,
    now_ms: i64,
) -> Option<String> {
    let windows = [
        ("window", allowance.window_used, allowance.window_ends_ms),
        ("week", allowance.week_used, allowance.weekly_ends_ms),
    ];
    let parts: Vec<String> = windows
        .into_iter()
        .filter_map(|(window, used, ends)| {
            let used = used.filter(|share| share.is_finite())?;
            let reset = ends
                .filter(|at| *at > now_ms)
                .map(|at| format!(", resets in {}", span(at - now_ms)))
                .unwrap_or_default();
            Some(format!("{window} {:.0}% used{reset}", used * 100.0))
        })
        .collect();
    (!parts.is_empty()).then(|| format!("allowance: {}", parts.join(" · ")))
}

impl Route {
    pub fn cost(&self) -> Cost {
        cost_of(self.cost.as_deref())
    }

    /// What is left of a plan or credits: Privateer does not report it.
    pub fn budget(&self) -> Option<&'static str> {
        self.cost().budget()
    }

    /// The declared allowance, with when it next resets: "renews daily at
    /// 00:00 UTC, in 5h 10m". None when the route declares none.
    pub fn allowance(&self, now_ms: i64) -> Option<String> {
        let daily = self
            .allowance
            .as_ref()
            .and_then(|a| a.daily_utc.as_deref())
            .or(self.allowance_resets_utc.as_deref());
        if let Some(at) = daily {
            return Some(match next_daily(at, now_ms) {
                Some(next) => format!(
                    "allowance renews daily at {at} UTC, in {}",
                    span(next - now_ms)
                ),
                None => format!("allowance renews daily at {at} UTC"),
            });
        }
        let allowance = self.allowance.as_ref()?;
        let mut parts = Vec::new();
        if let Some(hours) = allowance.window_hours {
            parts.push(format!("allowance: a {hours} h rolling window"));
        }
        if let Some(at) = allowance.weekly_utc.as_deref() {
            parts.push(match next_weekly(at, now_ms) {
                Some(next) => format!(
                    "weekly cap resets {at} UTC, in {}",
                    span(next - now_ms)
                ),
                None => format!("weekly cap resets {at} UTC"),
            });
        }
        (!parts.is_empty()).then(|| parts.join("; "))
    }
}

/// `HH:MM` as minutes into the day.
fn minute_of_day(at: &str) -> Option<i64> {
    let (hours, minutes) = at.split_once(':')?;
    let (hours, minutes): (i64, i64) =
        (hours.parse().ok()?, minutes.parse().ok()?);
    ((0..24).contains(&hours) && (0..60).contains(&minutes))
        .then_some(hours * 60 + minutes)
}

/// The next time of day `HH:MM` UTC after `now_ms`.
pub fn next_daily(at: &str, now_ms: i64) -> Option<i64> {
    let at = minute_of_day(at)? * MINUTE;
    let today = now_ms.div_euclid(DAY) * DAY + at;
    Some(if today > now_ms { today } else { today + DAY })
}

/// The next `Mon 07:00` UTC after `now_ms`.
pub fn next_weekly(at: &str, now_ms: i64) -> Option<i64> {
    let (day, time) = at.split_once(' ')?;
    let day = WEEKDAYS.iter().position(|d| *d == day)? as i64;
    let at = minute_of_day(time)? * MINUTE;
    let days = now_ms.div_euclid(DAY);
    // 1 January 1970 was a Thursday.
    let monday = (days - (days + 3).rem_euclid(7)) * DAY;
    let this_week = monday + day * DAY + at;
    Some(if this_week > now_ms {
        this_week
    } else {
        this_week + 7 * DAY
    })
}

/// A span of time: "2d 3h", "5h 10m", "7m", "under a minute".
pub fn span(ms: i64) -> String {
    let minutes = ms.max(0) / MINUTE;
    let (days, hours, minutes) =
        (minutes / 1440, minutes / 60 % 24, minutes % 60);
    match (days, hours, minutes) {
        (0, 0, 0) => "under a minute".into(),
        (0, 0, m) => format!("{m}m"),
        (0, h, 0) => format!("{h}h"),
        (0, h, m) => format!("{h}h {m}m"),
        (d, 0, _) => format!("{d}d"),
        (d, h, _) => format!("{d}d {h}h"),
    }
}

/// The periods the usage switch offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Period {
    /// The last 24 hours as they run.
    Day,
    /// 7 whole UTC days, ending with today.
    #[default]
    Week,
    /// 30 whole UTC days, ending with today.
    Month,
}

impl Period {
    pub const ALL: [Period; 3] = [Period::Day, Period::Week, Period::Month];

    pub fn label(self) -> &'static str {
        match self {
            Period::Day => "24 h",
            Period::Week => "7 days",
            Period::Month => "30 days",
        }
    }

    fn whole_days(self) -> Option<i64> {
        match self {
            Period::Day => None,
            Period::Week => Some(7),
            Period::Month => Some(30),
        }
    }

    /// Where the period starts: 24 hours back, or the UTC midnight opening
    /// its first day, so the day groups and the query agree.
    pub fn since_ms(self, now_ms: i64) -> i64 {
        match self.whole_days() {
            None => now_ms - DAY,
            Some(days) => now_ms.div_euclid(DAY) * DAY - (days - 1) * DAY,
        }
    }

    /// Where a period of whole days ends, exclusive: the midnight after
    /// today. None for the last 24 hours.
    pub fn until_ms(self, now_ms: i64) -> Option<i64> {
        self.whole_days()
            .map(|_| now_ms.div_euclid(DAY) * DAY + DAY)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Grouping {
    #[default]
    Route,
    Ship,
    Day,
    Machine,
}

impl Grouping {
    pub const ALL: [Grouping; 4] = [
        Grouping::Route,
        Grouping::Ship,
        Grouping::Day,
        Grouping::Machine,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Grouping::Route => "route",
            Grouping::Ship => "ship",
            Grouping::Day => "day",
            Grouping::Machine => "machine",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Grouping::Route => "Route",
            Grouping::Ship => "Ship",
            Grouping::Day => "Day",
            Grouping::Machine => "Machine",
        }
    }
}

/// What the usage section asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Query {
    pub period: Period,
    pub grouping: Grouping,
}

impl Query {
    pub fn args(self, now_ms: i64) -> Value {
        json!({
            "since_ms": self.period.since_ms(now_ms),
            "until_ms": self.period.until_ms(now_ms),
            "group_by": self.grouping.as_str(),
        })
    }
}

/// `usage.summary`'s answer.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Summary {
    pub since_ms: Option<i64>,
    /// Exclusive.
    pub until_ms: Option<i64>,
    pub group_by: Option<String>,
    pub groups: Vec<Group>,
    pub machines: Vec<Machine>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Group {
    pub key: String,
    pub jobs: u64,
    /// None when no job in the group reported usage.
    pub usage: Option<Usage>,
    /// Harnesses of jobs that reported nothing, including jobs that settled
    /// before usage was recorded.
    pub gaps: Vec<String>,
    /// Jobs whose log was trimmed, so their usage may be low.
    pub partial_jobs: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Usage {
    pub input: Option<u64>,
    pub output: Option<u64>,
    pub cache_read: Option<u64>,
    pub cache_write: Option<u64>,
    pub total_tokens: Option<u64>,
}

impl Usage {
    /// The total as reported, or the sum of the parts when none is.
    pub fn total(&self) -> Option<u64> {
        self.total_tokens.or_else(|| {
            let parts =
                [self.input, self.output, self.cache_read, self.cache_write];
            parts
                .iter()
                .any(Option::is_some)
                .then(|| parts.iter().flatten().sum::<u64>())
        })
    }

    fn add(self, other: Usage) -> Usage {
        let add = |a: Option<u64>, b: Option<u64>| match (a, b) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or(0) + b.unwrap_or(0)),
        };
        Usage {
            input: add(self.input, other.input),
            output: add(self.output, other.output),
            cache_read: add(self.cache_read, other.cache_read),
            cache_write: add(self.cache_write, other.cache_write),
            total_tokens: add(self.total(), other.total()),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Machine {
    pub name: String,
    pub reached: bool,
    /// `collect` for a machine that carries its usage on `fleet.collect`.
    pub via: Option<String>,
    /// When a collected machine's carried usage was read.
    pub as_of_ms: Option<i64>,
    /// Homes on it that were not read.
    pub unknown: Vec<String>,
    pub error: Option<String>,
}

/// Whether a machine's usage is in the totals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Counted {
    /// All of it; for a collected machine, as of a while ago.
    Fully { as_of_ms: Option<i64> },
    /// What it carried is in, but it has not been heard from lately.
    NotUpToDate { as_of_ms: i64, why: String },
    /// Some homes on it were not read.
    Partly(String),
    /// None of it.
    NotIncluded(String),
}

impl Counted {
    /// Whether the totals miss some of this machine's usage.
    pub fn is_partial(&self) -> bool {
        !matches!(self, Counted::Fully { .. })
    }
}

impl Machine {
    pub fn counted(&self) -> Counted {
        let as_of_ms = self
            .as_of_ms
            .filter(|_| self.via.as_deref() == Some("collect"));
        let why = || self.error.clone();
        match (self.reached, as_of_ms) {
            (false, None) => {
                Counted::NotIncluded(why().unwrap_or("not reached".into()))
            }
            (false, Some(as_of_ms)) => Counted::NotUpToDate {
                as_of_ms,
                why: why().unwrap_or("not up to date".into()),
            },
            (true, _) if !self.unknown.is_empty() => Counted::Partly(format!(
                "homes not read: {}",
                self.unknown
                    .iter()
                    .map(|home| home.strip_prefix("home:").unwrap_or(home))
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
            (true, _) => match why() {
                Some(error) => Counted::Partly(error),
                None => Counted::Fully { as_of_ms },
            },
        }
    }
}

impl Summary {
    pub fn parse(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    /// The groups to list: by day oldest first, otherwise most tokens first.
    pub fn sorted(&self) -> Vec<&Group> {
        let mut groups: Vec<&Group> = self.groups.iter().collect();
        if self.group_by.as_deref() == Some("day") {
            groups.sort_by(|a, b| a.key.cmp(&b.key));
        } else {
            groups.sort_by(|a, b| {
                let total = |g: &Group| g.usage.and_then(|u| u.total());
                total(b).cmp(&total(a)).then_with(|| a.key.cmp(&b.key))
            });
        }
        groups
    }

    /// Every group's usage summed; None when no group reported any.
    pub fn totals(&self) -> Option<Usage> {
        self.groups
            .iter()
            .filter_map(|g| g.usage)
            .reduce(Usage::add)
    }

    pub fn jobs(&self) -> u64 {
        self.groups.iter().map(|g| g.jobs).sum()
    }

    pub fn partial_jobs(&self) -> u64 {
        self.groups.iter().map(|g| g.partial_jobs).sum()
    }

    /// Every harness that reported no usage for some job, A to Z.
    pub fn gaps(&self) -> Vec<&str> {
        let gaps: BTreeSet<&str> = self
            .groups
            .iter()
            .flat_map(|g| g.gaps.iter().map(String::as_str))
            .collect();
        gaps.into_iter().collect()
    }

    /// Machines whose usage the totals miss, wholly or in part.
    pub fn missing(&self) -> Vec<(&Machine, Counted)> {
        self.machines
            .iter()
            .map(|m| (m, m.counted()))
            .filter(|(_, counted)| counted.is_partial())
            .collect()
    }
}

/// A token count, short: "912", "8.4k", "31M", "1.2B".
pub fn tokens(n: u64) -> String {
    for (unit, size) in [("B", 1e9), ("M", 1e6), ("k", 1e3)] {
        let scaled = n as f64 / size;
        if scaled >= 1.0 {
            return if scaled < 10.0 {
                format!("{scaled:.1}{unit}")
            } else {
                format!("{}{unit}", scaled.round())
            };
        }
    }
    n.to_string()
}

/// A day group's key, `2026-10-16`, as "16 Oct"; anything else as it is.
pub fn day_label(key: &str) -> String {
    let mut parts = key.split('-');
    let (Some(_), Some(month), Some(day), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return key.to_owned();
    };
    match (month.parse::<usize>(), day.parse::<u32>()) {
        (Ok(month @ 1..=12), Ok(day)) => format!("{day} {}", MONTHS[month - 1]),
        _ => key.to_owned(),
    }
}

/// The UTC date of a time, `2026-10-16`.
fn utc_date(ms: i64) -> String {
    // Howard Hinnant's days-to-civil.
    let z = ms.div_euclid(DAY) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// One job record in the fixtures, which stand in for Privateer.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Record {
    ts_ms: i64,
    machine: String,
    ship: String,
    route: String,
    harness: String,
    jobs: u64,
    usage: Option<Usage>,
    partial: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
struct Records {
    fixture_now_ms: i64,
    machines: Vec<Value>,
    records: Vec<Record>,
}

/// What `usage.summary` would answer over the fixture's job records, with
/// their times moved so the newest is recent.
pub fn fixture_summary(
    records: &str,
    args: &Value,
    now_ms: i64,
) -> Result<Value, String> {
    let fixture: Records =
        serde_json::from_str(records).map_err(|e| e.to_string())?;
    let shift = now_ms - fixture.fixture_now_ms;
    let since = args["since_ms"].as_i64().ok_or("since_ms is required")?;
    let until = args["until_ms"].as_i64().unwrap_or(i64::MAX);
    let by = args["group_by"].as_str().unwrap_or("route");

    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for record in &fixture.records {
        let at = record.ts_ms + shift;
        if at < since || at >= until {
            continue;
        }
        let key = match by {
            "ship" => record.ship.clone(),
            "day" => utc_date(at),
            "machine" => record.machine.clone(),
            _ => record.route.clone(),
        };
        let group = groups.entry(key.clone()).or_insert_with(|| Group {
            key,
            ..Group::default()
        });
        group.jobs += record.jobs;
        if record.partial {
            group.partial_jobs += record.jobs;
        }
        match record.usage {
            Some(usage) => {
                group.usage = Some(match group.usage {
                    Some(sum) => sum.add(usage),
                    None => usage.add(Usage::default()),
                });
            }
            None if !group.gaps.contains(&record.harness) => {
                group.gaps.push(record.harness.clone());
            }
            None => {}
        }
    }

    let machines: Vec<Value> = fixture
        .machines
        .into_iter()
        .map(|mut machine| {
            if let Some(at) = machine["as_of_ms"].as_i64() {
                machine["as_of_ms"] = json!(at + shift);
            }
            machine
        })
        .collect();
    let groups: Vec<Value> = groups
        .into_values()
        .map(|group| {
            json!({
                "key": group.key,
                "jobs": group.jobs,
                "usage": group.usage.map(|u| json!({
                    "input": u.input,
                    "output": u.output,
                    "cacheRead": u.cache_read,
                    "cacheWrite": u.cache_write,
                    "totalTokens": u.total(),
                })),
                "gaps": group.gaps,
                "partial_jobs": group.partial_jobs,
            })
        })
        .collect();
    Ok(json!({
        "since_ms": since,
        "until_ms": args["until_ms"],
        "group_by": by,
        "groups": groups,
        "machines": machines,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROUTES: &str = include_str!("../../fixtures/routes.show.json");
    const RECORDS: &str = include_str!("../../fixtures/usage.records.json");
    /// Sunday 18 October 2026, 05:06:40 UTC: the fixtures' own now.
    const NOW: i64 = 1_792_300_000_000;

    #[test]
    fn routes_are_listed_in_the_order_crew_try_them_with_no_invented_budget() {
        let routes =
            Routes::parse(serde_json::from_str(ROUTES).unwrap()).unwrap();
        let listed = routes.listed();
        let names: Vec<&str> = listed.iter().map(|l| l.name).collect();
        assert_eq!(names, ["free-pool", "plan-main", "credits-reserve"]);
        assert_eq!(listed[1].first_mate, Some(1));
        assert_eq!(listed[2].errand, Some(2));

        let budgets: Vec<_> = listed.iter().map(|l| l.route.budget()).collect();
        assert_eq!(
            budgets,
            [
                None,
                Some("plan allowance left: not reported"),
                Some("credit balance: not reported"),
            ]
        );
        assert_eq!(routes.own_lists(), ["billing"]);
    }

    #[test]
    fn a_route_says_when_its_allowance_next_resets() {
        let routes =
            Routes::parse(serde_json::from_str(ROUTES).unwrap()).unwrap();
        assert_eq!(
            routes.routes["free-pool"].allowance(NOW).unwrap(),
            "allowance renews daily at 00:00 UTC, in 18h 53m"
        );
        // Monday 19 October, 00:00 UTC.
        assert_eq!(
            routes.routes["plan-main"].allowance(NOW).unwrap(),
            "allowance: a 5 h rolling window; weekly cap resets Mon 00:00 \
             UTC, in 18h 53m"
        );
        assert_eq!(routes.routes["credits-reserve"].allowance(NOW), None);
        assert_eq!(
            next_weekly("Sat 18:00", NOW),
            Some(NOW + 7 * DAY - 40_000_000)
        );
    }

    #[test]
    fn whole_day_periods_run_from_midnight_utc_to_the_midnight_after_today() {
        let midnight = NOW.div_euclid(DAY) * DAY;
        let week = Query {
            period: Period::Week,
            grouping: Grouping::Day,
        };
        assert_eq!(
            week.args(NOW),
            json!({
                "since_ms": midnight - 6 * DAY,
                "until_ms": midnight + DAY,
                "group_by": "day",
            })
        );
        assert_eq!(Period::Day.since_ms(NOW), NOW - DAY);
        assert_eq!(Period::Day.until_ms(NOW), None);
    }

    #[test]
    fn reads_privateers_usage_summary_shape() {
        // As Privateer's usage.rs writes it: gaps and partial_jobs only when
        // there are some, and machines sorted by name.
        let summary = Summary::parse(json!({
            "since_ms": 1, "until_ms": 2, "group_by": "route",
            "groups": [
                {"key": "agy/-/flash", "jobs": 1, "usage": null, "gaps": ["agy"]},
                {"key": "claude/-/haiku", "jobs": 3, "partial_jobs": 1,
                 "usage": {"input": 10, "output": 20, "cacheRead": 300,
                           "cacheWrite": 40, "totalTokens": 370}},
                {"key": "pi/zai/glm", "jobs": 2,
                 "usage": {"input": 1000, "output": 200, "cacheRead": 0,
                           "cacheWrite": 0, "totalTokens": 1200}},
            ],
            "machines": [
                {"name": "laptop", "reached": true, "unknown": []},
                {"name": "mac", "reached": false, "via": "collect",
                 "as_of_ms": 5, "error": "nothing carried from mac lately"},
                {"name": "server", "reached": false, "error": "timed out"},
                {"name": "spare", "reached": true, "unknown": ["home:ops"]},
            ],
        }))
        .unwrap();

        let keys: Vec<&str> =
            summary.sorted().iter().map(|g| g.key.as_str()).collect();
        assert_eq!(keys, ["pi/zai/glm", "claude/-/haiku", "agy/-/flash"]);
        let totals = summary.totals().unwrap();
        assert_eq!(
            (totals.input, totals.total_tokens),
            (Some(1010), Some(1570))
        );
        assert_eq!(totals.cache_read, Some(300));
        assert_eq!(summary.jobs(), 6);
        assert_eq!(summary.partial_jobs(), 1);
        assert_eq!(summary.gaps(), ["agy"]);

        let missing: Vec<(&str, Counted)> = summary
            .missing()
            .into_iter()
            .map(|(m, c)| (m.name.as_str(), c))
            .collect();
        assert_eq!(
            missing,
            [
                (
                    "mac",
                    Counted::NotUpToDate {
                        as_of_ms: 5,
                        why: "nothing carried from mac lately".into()
                    }
                ),
                ("server", Counted::NotIncluded("timed out".into())),
                ("spare", Counted::Partly("homes not read: ops".into())),
            ]
        );
    }

    #[test]
    fn a_collected_machine_heard_from_lately_counts_fully() {
        let machine = Machine {
            name: "mac".into(),
            reached: true,
            via: Some("collect".into()),
            as_of_ms: Some(7),
            ..Machine::default()
        };
        assert_eq!(machine.counted(), Counted::Fully { as_of_ms: Some(7) });
    }

    #[test]
    fn the_fixtures_group_as_usage_summary_would() {
        let week = Query {
            period: Period::Week,
            grouping: Grouping::Day,
        };
        let summary = Summary::parse(
            fixture_summary(RECORDS, &week.args(NOW), NOW).unwrap(),
        )
        .unwrap();
        assert_eq!(summary.groups.len(), 7);
        assert!(summary.sorted().windows(2).all(|w| w[0].key < w[1].key));
        assert_eq!(day_label(&summary.sorted()[6].key), "18 Oct");
        assert!(summary.gaps().contains(&"ferry"));
        assert!(!summary.missing().is_empty());

        let by_ship = Query {
            period: Period::Month,
            grouping: Grouping::Ship,
        };
        let month = Summary::parse(
            fixture_summary(RECORDS, &by_ship.args(NOW), NOW).unwrap(),
        )
        .unwrap();
        assert!(month.jobs() > summary.jobs());
        assert!(month.groups.iter().any(|g| g.key == "billing"));
    }

    #[test]
    fn token_counts_and_days_read_short() {
        assert_eq!(tokens(912), "912");
        assert_eq!(tokens(8_400), "8.4k");
        assert_eq!(tokens(31_401_032), "31M");
        assert_eq!(tokens(1_200_000_000), "1.2B");
        assert_eq!(utc_date(NOW), "2026-10-18");
        assert_eq!(day_label("2026-10-16"), "16 Oct");
        assert_eq!(day_label("laptop"), "laptop");
        assert_eq!(span(5 * HOUR + 46 * MINUTE), "5h 46m");
    }

    const SNAPSHOT: &str = include_str!("../../fixtures/fleet.snapshot.json");

    #[test]
    fn live_routes_keep_the_try_order_with_the_throttled_first() {
        let routes =
            Routes::parse(serde_json::from_str(ROUTES).unwrap()).unwrap();
        let snapshot =
            Snapshot::parse(serde_json::from_str(SNAPSHOT).unwrap()).unwrap();
        let rows = Routes::rows(Some(&routes), Some(&snapshot));
        let names: Vec<&str> = rows.iter().map(|row| row.name).collect();
        assert_eq!(names, ["free-pool", "plan-main", "credits-reserve"]);

        fn states<'a>(row: &Row<'a>) -> Vec<(&'a str, RouteState)> {
            row.live.iter().map(|l| (l.machine, l.state)).collect()
        }
        assert_eq!(
            states(&rows[0]),
            [
                ("atlas", RouteState::BackingOff),
                ("boreas", RouteState::Idle)
            ]
        );
        assert_eq!(
            states(&rows[1]),
            [
                ("atlas", RouteState::Available),
                ("boreas", RouteState::Capped)
            ]
        );
        assert!(rows[0].throttled() && rows[1].throttled());
        assert!(!rows[2].throttled());
        assert_eq!(rows[1].crew, Some(2));
    }

    #[test]
    fn a_route_only_a_machine_reports_is_listed_without_a_declaration() {
        let snapshot =
            Snapshot::parse(serde_json::from_str(SNAPSHOT).unwrap()).unwrap();
        let rows = Routes::rows(None, Some(&snapshot));
        let names: Vec<&str> = rows.iter().map(|row| row.name).collect();
        assert_eq!(names, ["free-pool", "plan-main", "credits-reserve"]);
        assert!(rows.iter().all(|row| row.declared.is_none()));
        assert_eq!(rows[1].cost(), Cost::Plan);
        assert_eq!(
            rows[1].cost().budget(),
            Some("plan allowance left: not reported")
        );
    }

    #[test]
    fn a_live_state_says_when_it_clears_and_when_it_has_passed() {
        let snapshot =
            Snapshot::parse(serde_json::from_str(SNAPSHOT).unwrap()).unwrap();
        let rows = Routes::rows(None, Some(&snapshot));
        let free = &rows[0].live[0];
        assert_eq!(free.label(NOW), "backing off, back in 9m");
        assert_eq!(free.label(1_792_300_540_000), "backing off");
        let capped =
            rows[1].live.iter().find(|l| l.machine == "boreas").unwrap();
        assert_eq!(
            capped.label(1_792_307_800_000 - (2 * HOUR + 10 * MINUTE)),
            "capped, resets in 2h 10m"
        );
        assert_eq!(rows[1].live[0].label(NOW), "available");
    }

    #[test]
    fn a_live_allowance_reads_its_shares_as_percents_with_resets() {
        let snapshot =
            Snapshot::parse(serde_json::from_str(SNAPSHOT).unwrap()).unwrap();
        let rows = Routes::rows(None, Some(&snapshot));
        let boreas =
            rows[1].live.iter().find(|l| l.machine == "boreas").unwrap();
        let allowance = boreas.allowance.unwrap();
        assert_eq!(
            live_allowance(allowance, NOW).as_deref(),
            Some(
                "allowance: window 40% used, resets in 1h · week 87% used, resets in 3d"
            )
        );
        assert_eq!(rows[1].live[0].allowance, None);
    }
}
