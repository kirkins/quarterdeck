//! Triage: what waits on the captain, in sections, most pressing first.
//!
//! Order: high urgency, then overdue, then the nearest deadline (none
//! last), then the oldest ask, then the id, so ties never depend on the
//! order Privateer listed them in.

use std::cmp::Reverse;

use serde::{Deserialize, Serialize};

use crate::captain::Item;

pub const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// The ship and kind Triage narrows its list to; none chosen shows all.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Filter {
    pub ship: Option<String>,
    pub kind: Option<String>,
}

impl Filter {
    pub fn matches(&self, item: &Item) -> bool {
        self.ship.as_deref().is_none_or(|ship| item.asker() == ship)
            && self
                .kind
                .as_deref()
                .is_none_or(|kind| kind_of(item) == kind)
    }
}

/// An ask's kind as Triage filters by it: hands-on asks are their own kind,
/// whatever mail they came in.
pub fn kind_of(item: &Item) -> &str {
    if item.step.is_some() {
        "hands-on"
    } else {
        item.mail.kind.as_str()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    /// High urgency, overdue, or due within a day.
    Now,
    Waiting,
    /// Low urgency.
    Later,
}

impl Section {
    pub fn title(self) -> &'static str {
        match self {
            Section::Now => "Needs you now",
            Section::Waiting => "Waiting on you",
            Section::Later => "When you have a moment",
        }
    }
}

pub fn section(item: &Item, now_ms: i64) -> Section {
    let urgency = item.mail.urgency.as_deref().unwrap_or("normal");
    let soon = item
        .mail
        .deadline_ms
        .is_some_and(|deadline| deadline - now_ms <= DAY_MS);
    if urgency == "high" || soon {
        Section::Now
    } else if urgency == "low" {
        Section::Later
    } else {
        Section::Waiting
    }
}

/// Items in their sections, each sorted; empty sections left out.
pub fn sections<'a>(
    items: impl IntoIterator<Item = &'a Item>,
    now_ms: i64,
) -> Vec<(Section, Vec<&'a Item>)> {
    let mut sorted: Vec<&Item> = items.into_iter().collect();
    sorted.sort_by_key(|item| {
        let high = item.mail.urgency.as_deref() == Some("high");
        let overdue = item.mail.deadline_ms.is_some_and(|d| d < now_ms);
        (
            section(item, now_ms),
            Reverse(high),
            Reverse(overdue),
            item.mail.deadline_ms.unwrap_or(i64::MAX),
            asked_ms(item),
            item.mail.id.clone(),
        )
    });

    let mut out: Vec<(Section, Vec<&Item>)> = Vec::new();
    for item in sorted {
        let section = section(item, now_ms);
        match out.last_mut() {
            Some((last, items)) if *last == section => items.push(item),
            _ => out.push((section, vec![item])),
        }
    }
    out
}

/// Blockers and approvals are read here, never answered: Quarterdeck offers
/// nothing on a blocker, and approvals are granted or denied in Privateer.
pub fn is_read_only(item: &Item) -> bool {
    item.mail.kind == "blocker"
        || item.mail.kind == "approval"
        || item.mail.request_kind.as_deref() == Some("production_approval")
}

fn asked_ms(item: &Item) -> i64 {
    if item.asked_ms > 0 {
        item.asked_ms
    } else {
        item.mail.created_ms
    }
}

/// An ask's key. Ships choose their own mail ids, so the sender is part of
/// it: an id two ships both use is two asks.
pub fn key(item: &Item) -> String {
    format!("{}/{}", item.mail.from, item.mail.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::captain::Mail;

    fn item(
        id: &str,
        urgency: &str,
        deadline: Option<i64>,
        asked: i64,
    ) -> Item {
        Item {
            ship: "scout".into(),
            asked_ms: asked,
            mail: Mail {
                id: id.into(),
                from: "scout".into(),
                urgency: Some(urgency.into()),
                deadline_ms: deadline,
                ..Mail::default()
            },
            ..Item::default()
        }
    }

    #[test]
    fn a_filter_narrows_by_asker_and_kind() {
        let mut decision = item("d", "normal", None, 1);
        decision.mail.kind = "decision".into();
        decision.mail.from = "scout".into();
        let mut hands = item("h", "normal", None, 1);
        hands.mail.kind = "request".into();
        hands.mail.from = "scout".into();
        hands.step = Some("log in".into());
        let mut other = item("o", "normal", None, 1);
        other.mail.kind = "decision".into();
        other.mail.from = "relay".into();
        let items = [decision, hands, other];

        let shown = |filter: Filter| -> Vec<String> {
            items
                .iter()
                .filter(|item| filter.matches(item))
                .map(|item| item.mail.id.clone())
                .collect()
        };
        assert_eq!(shown(Filter::default()), ["d", "h", "o"]);
        let scout = Filter {
            ship: Some("scout".into()),
            kind: None,
        };
        assert_eq!(shown(scout.clone()), ["d", "h"]);
        assert_eq!(
            shown(Filter {
                ship: Some("scout".into()),
                kind: Some("hands-on".into()),
            }),
            ["h"]
        );
        assert_eq!(
            shown(Filter {
                ship: None,
                kind: Some("decision".into()),
            }),
            ["d", "o"]
        );
    }

    #[test]
    fn the_most_pressing_comes_first_in_its_section() {
        let now = 10 * DAY_MS;
        let items = [
            item("later", "low", None, 1),
            item("old", "normal", None, 1),
            item("young", "normal", None, 5),
            item("due-soon", "normal", Some(now + DAY_MS / 2), 9),
            item("overdue", "normal", Some(now - 1), 9),
            item("high", "high", None, 9),
            item("due-next-week", "normal", Some(now + 7 * DAY_MS), 9),
        ];

        let ids: Vec<(Section, Vec<&str>)> = sections(&items, now)
            .into_iter()
            .map(|(s, items)| {
                (s, items.iter().map(|i| i.mail.id.as_str()).collect())
            })
            .collect();

        assert_eq!(
            ids,
            [
                (Section::Now, vec!["high", "overdue", "due-soon"]),
                (Section::Waiting, vec!["due-next-week", "old", "young"]),
                (Section::Later, vec!["later"]),
            ]
        );
    }
}
