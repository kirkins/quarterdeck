//! Triage: what waits on the captain, in sections, most pressing first.
//!
//! Order: high urgency, then overdue, then the nearest deadline (none
//! last), then the oldest ask, then the id, so ties never depend on the
//! order Privateer listed them in.

use std::cmp::Reverse;
use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::captain::Item;
use crate::decision;

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

/// Asks that share a decision group from one sender, shown as one card. An
/// ask outside any group is a card of one.
#[derive(Debug, Clone, PartialEq)]
pub struct Group<'a> {
    /// The sender and group, as [`group_key`] has them; None for a card of one.
    pub key: Option<String>,
    /// The open asks, most pressing first.
    pub items: Vec<&'a Item>,
}

impl Group<'_> {
    /// The earliest deadline of any of its asks.
    pub fn deadline_ms(&self) -> Option<i64> {
        self.items.iter().filter_map(|i| i.mail.deadline_ms).min()
    }

    /// The most pressing section any of its asks is in.
    fn section(&self, now_ms: i64) -> Section {
        self.items
            .iter()
            .map(|item| section(item, now_ms))
            .min()
            .unwrap_or(Section::Later)
    }
}

/// The key a card groups its asks by: the sender and the group, so two ships
/// that name the same group have two cards.
pub fn group_key(item: &Item) -> Option<String> {
    decision::group_of(&item.mail)
        .map(|group| format!("{}\u{0}{group}", item.asker()))
}

/// An ask's place among the others: most pressing first.
fn rank(item: &Item, now_ms: i64) -> impl Ord + use<> {
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
}

/// A card's place: judged by its most pressing ask, its earliest open
/// deadline and its oldest ask, so one question's deadline sorts the card.
fn group_rank(group: &Group<'_>, now_ms: i64) -> impl Ord + use<> {
    let high = group
        .items
        .iter()
        .any(|item| item.mail.urgency.as_deref() == Some("high"));
    let overdue = group
        .items
        .iter()
        .any(|item| item.mail.deadline_ms.is_some_and(|d| d < now_ms));
    let asked = group.items.iter().map(|item| asked_ms(item)).min();
    (
        group.section(now_ms),
        Reverse(high),
        Reverse(overdue),
        group.deadline_ms().unwrap_or(i64::MAX),
        asked,
        group.items.first().map(|item| key(item)),
    )
}

/// Asks in their sections, grouped into cards and sorted; empty sections left
/// out. A card's section is its most pressing ask's.
pub fn sections<'a>(
    items: impl IntoIterator<Item = &'a Item>,
    now_ms: i64,
) -> Vec<(Section, Vec<Group<'a>>)> {
    let mut groups: Vec<Group<'a>> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for item in items {
        match group_key(item) {
            Some(group) => match at.get(&group) {
                Some(&index) => groups[index].items.push(item),
                None => {
                    at.insert(group.clone(), groups.len());
                    groups.push(Group {
                        key: Some(group),
                        items: vec![item],
                    });
                }
            },
            None => groups.push(Group {
                key: None,
                items: vec![item],
            }),
        }
    }
    for group in &mut groups {
        group.items.sort_by_cached_key(|item| rank(item, now_ms));
    }
    groups.sort_by_cached_key(|group| group_rank(group, now_ms));

    let mut out: Vec<(Section, Vec<Group<'a>>)> = Vec::new();
    for group in groups {
        let section = group.section(now_ms);
        match out.last_mut() {
            Some((last, groups)) if *last == section => groups.push(group),
            _ => out.push((section, vec![group])),
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

        let ids = ids(sections(&items, now));

        assert_eq!(
            ids,
            [
                (Section::Now, vec!["high", "overdue", "due-soon"]),
                (Section::Waiting, vec!["due-next-week", "old", "young"]),
                (Section::Later, vec!["later"]),
            ]
        );
    }

    /// Each section's asks by id, cards flattened in order.
    fn ids(
        sections: Vec<(Section, Vec<Group<'_>>)>,
    ) -> Vec<(Section, Vec<&str>)> {
        sections
            .into_iter()
            .map(|(section, groups)| {
                let ids = groups
                    .iter()
                    .flat_map(|g| g.items.iter().map(|i| i.mail.id.as_str()))
                    .collect();
                (section, ids)
            })
            .collect()
    }

    fn asked_by(
        from: &str,
        id: &str,
        group: Option<&str>,
        deadline: Option<i64>,
    ) -> Item {
        let mut item = item(id, "normal", deadline, 1);
        item.mail.from = from.into();
        item.mail.kind = "decision".into();
        if let Some(group) = group {
            item.mail.payload =
                serde_json::json!({"decision": {"group": group}});
        }
        item
    }

    #[test]
    fn asks_from_one_sender_in_one_group_are_one_card() {
        let items = [
            asked_by("analytics", "a", Some("setup"), None),
            asked_by("analytics", "b", Some("setup"), Some(5)),
            asked_by("analytics", "c", Some("other"), None),
            asked_by("billing", "d", Some("setup"), None),
            asked_by("analytics", "e", None, None),
        ];

        let cards: Vec<Group<'_>> = sections(&items, 0)
            .into_iter()
            .flat_map(|(_, groups)| groups)
            .collect();
        let shape: Vec<(Option<&str>, Vec<&str>)> = cards
            .iter()
            .map(|g| {
                (
                    g.key.as_deref().map(|k| k.rsplit('\0').next().unwrap()),
                    g.items.iter().map(|i| i.mail.id.as_str()).collect(),
                )
            })
            .collect();

        // The analytics pair is one card; the other sender, the other group
        // and the ungrouped ask each stand alone.
        assert_eq!(cards.len(), 4);
        assert!(shape.contains(&(Some("setup"), vec!["b", "a"])));
        assert!(shape.contains(&(Some("setup"), vec!["d"])));
        assert!(shape.contains(&(Some("other"), vec!["c"])));
        assert!(shape.contains(&(None, vec!["e"])));
        // Within the card the dated question leads.
        assert_eq!(cards[0].items[0].mail.id, "b");
    }

    #[test]
    fn a_card_sorts_by_its_earliest_open_deadline() {
        let now = 10 * DAY_MS;
        let items = [
            asked_by("ops", "solo", None, Some(now + 5 * DAY_MS)),
            asked_by(
                "analytics",
                "late",
                Some("setup"),
                Some(now + 6 * DAY_MS),
            ),
            asked_by(
                "analytics",
                "soon",
                Some("setup"),
                Some(now + 4 * DAY_MS),
            ),
            asked_by("billing", "none", None, None),
        ];

        assert_eq!(
            ids(sections(&items, now)),
            [(Section::Waiting, vec!["soon", "late", "solo", "none"],)]
        );
        let card = sections(&items, now)
            .into_iter()
            .flat_map(|(_, groups)| groups)
            .next()
            .unwrap();
        assert_eq!(card.deadline_ms(), Some(now + 4 * DAY_MS));
    }

    #[test]
    fn a_card_is_in_its_most_pressing_section() {
        let now = 10 * DAY_MS;
        let mut high = asked_by("ops", "urgent", Some("setup"), None);
        high.mail.urgency = Some("high".into());
        let items = [
            asked_by("ops", "calm", Some("setup"), None),
            high,
            asked_by("ops", "later", None, None),
        ];
        let [calm, _, _] = &items;
        assert_eq!(section(calm, now), Section::Waiting);

        let shown = sections(&items, now);
        assert_eq!(
            ids(shown),
            [
                (Section::Now, vec!["urgent", "calm"]),
                (Section::Waiting, vec!["later"]),
            ]
        );
    }

    #[test]
    fn the_analytics_pair_in_the_fixture_is_one_card() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../fixtures/captain.waiting.json"
        ))
        .unwrap();
        let waiting = crate::captain::Waiting::parse(fixture).unwrap();
        let shown = sections(&waiting.waiting, waiting.now_ms);

        let card = shown
            .iter()
            .flat_map(|(_, groups)| groups)
            .find(|g| g.items.len() > 1)
            .unwrap();
        assert!(card.key.is_some());
        let asks: Vec<&str> =
            card.items.iter().map(|i| i.mail.id.as_str()).collect();
        assert_eq!(asks, ["f0006-churn-owner", "f0005-click-retention"]);
        assert_eq!(card.deadline_ms(), Some(1792732000000));
    }
}
