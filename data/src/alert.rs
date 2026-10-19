//! Desktop alerts: what newly needs the captain now, worded for a
//! notification.
//!
//! Only asks in Triage's "Needs you now" are announced, each once, whether it
//! arrived there or moved there (a deadline drew near). The first full read is
//! taken as known, so starting Quarterdeck does not announce everything that
//! already waits.

use std::collections::HashMap;

use crate::captain::Item;
use crate::decision::Card;
use crate::triage::{self, DAY_MS, Section};

/// Cards named in one notification; the rest are counted.
const MAX_LINES: usize = 3;
const LINE_LIMIT: usize = 140;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Alert {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Default)]
pub struct Alerts {
    primed: bool,
    /// Urgent asks announced or already known, by triage key, with when they
    /// were last listed. An ask that drops out of a read and comes back (a
    /// failed `runtime.needs`, say) is not announced again; one unlisted for
    /// a day is forgotten.
    known: HashMap<String, i64>,
}

impl Alerts {
    /// Take a read of what waits and return what to announce, if anything.
    /// `complete` is false until every source has answered once; until then
    /// nothing is learned or announced.
    pub fn observe(
        &mut self,
        items: &[Item],
        now_ms: i64,
        complete: bool,
    ) -> Option<Alert> {
        if !complete {
            return None;
        }
        let urgent: Vec<&Item> = items
            .iter()
            .filter(|item| triage::section(item, now_ms) == Section::Now)
            .collect();
        let fresh: Vec<&Item> = urgent
            .iter()
            .copied()
            .filter(|item| !self.known.contains_key(&triage::key(item)))
            .collect();
        for item in &urgent {
            self.known.insert(triage::key(item), now_ms);
        }
        self.known.retain(|_, seen| now_ms - *seen < DAY_MS);

        if !self.primed {
            self.primed = true;
            return None;
        }
        alert(&fresh, now_ms)
    }
}

/// One notification for the asks given: a card's ship and what it asks, or a
/// count and the first few.
fn alert(items: &[&Item], now_ms: i64) -> Option<Alert> {
    let groups: Vec<_> = triage::sections(items.iter().copied(), now_ms)
        .into_iter()
        .flat_map(|(_, groups)| groups)
        .collect();
    let line = |group: &triage::Group<'_>| {
        let first = group.items[0];
        let more = group.items.len() - 1;
        let headline = headline(first);
        if more == 0 {
            headline
        } else {
            format!("{headline} (+{more} related)")
        }
    };
    match groups.as_slice() {
        [] => None,
        [group] => Some(Alert {
            title: format!("{} needs you", group.items[0].asker()),
            body: line(group),
        }),
        groups => {
            let mut lines: Vec<String> = groups
                .iter()
                .take(MAX_LINES)
                .map(|group| {
                    format!("{}: {}", group.items[0].asker(), line(group))
                })
                .collect();
            if groups.len() > MAX_LINES {
                lines.push(format!("and {} more", groups.len() - MAX_LINES));
            }
            Some(Alert {
                title: format!("{} asks need you", items.len()),
                body: lines.join("\n"),
            })
        }
    }
}

/// What an ask wants in a line, as Triage's collapsed row leads with it: the
/// step for a hands-on ask, the question for a decision, else how it starts.
fn headline(item: &Item) -> String {
    if let Some(step) = &item.step {
        return preview(step);
    }
    let card = Card::from_mail(&item.mail);
    if card.options.is_empty() {
        preview(&item.mail.body)
    } else {
        preview(&card.question)
    }
}

fn preview(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= LINE_LIMIT {
        return flat;
    }
    let cut: String = flat.chars().take(LINE_LIMIT).collect();
    let cut = cut.rsplit_once(' ').map_or(cut.as_str(), |(head, _)| head);
    format!("{cut}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::captain::Mail;
    use serde_json::json;

    const NOW: i64 = 100 * DAY_MS;

    fn ask(from: &str, id: &str, urgency: &str, body: &str) -> Item {
        Item {
            ship: from.into(),
            mail: Mail {
                id: id.into(),
                from: from.into(),
                kind: "request".into(),
                urgency: Some(urgency.into()),
                body: body.into(),
                ..Mail::default()
            },
            ..Item::default()
        }
    }

    fn primed(items: &[Item]) -> Alerts {
        let mut alerts = Alerts::default();
        assert_eq!(alerts.observe(items, NOW, true), None);
        alerts
    }

    #[test]
    fn what_waits_at_startup_is_not_announced() {
        let mut alerts = Alerts::default();
        let items = [ask("billing", "a", "high", "Refund the order?")];
        // Not every source has answered: nothing is learned yet.
        assert_eq!(alerts.observe(&items, NOW, false), None);
        assert_eq!(alerts.observe(&items, NOW, true), None);
        assert_eq!(alerts.observe(&items, NOW + 1, true), None);
    }

    #[test]
    fn a_new_urgent_ask_is_announced_once() {
        let mut alerts = primed(&[]);
        let items = [ask("billing", "a", "high", "Refund the order?")];
        assert_eq!(
            alerts.observe(&items, NOW, true),
            Some(Alert {
                title: "billing needs you".into(),
                body: "Refund the order?".into(),
            })
        );
        assert_eq!(alerts.observe(&items, NOW + 1, true), None);
    }

    #[test]
    fn asks_that_can_wait_are_not_announced() {
        let mut alerts = primed(&[]);
        let items = [
            ask("billing", "a", "normal", "Which plan?"),
            ask("billing", "b", "low", "Tidy the README?"),
        ];
        assert_eq!(alerts.observe(&items, NOW, true), None);
    }

    #[test]
    fn an_ask_is_announced_when_its_deadline_draws_near() {
        let mut due = ask("billing", "a", "normal", "Renew the domain?");
        due.mail.deadline_ms = Some(NOW + 2 * DAY_MS);
        let mut alerts = primed(std::slice::from_ref(&due));
        assert_eq!(alerts.observe(std::slice::from_ref(&due), NOW, true), None);
        let alert = alerts
            .observe(std::slice::from_ref(&due), NOW + DAY_MS + 1, true)
            .unwrap();
        assert_eq!(alert.title, "billing needs you");
    }

    #[test]
    fn an_ask_that_drops_out_and_returns_is_not_announced_again() {
        let items = [ask("billing", "a", "high", "Refund?")];
        let mut alerts = primed(&[]);
        assert!(alerts.observe(&items, NOW, true).is_some());
        assert_eq!(alerts.observe(&[], NOW + 1, true), None);
        assert_eq!(alerts.observe(&items, NOW + 2, true), None);
    }

    #[test]
    fn the_same_id_from_two_ships_is_two_asks() {
        let mut alerts = primed(&[ask("billing", "a", "high", "Refund?")]);
        let items = [
            ask("billing", "a", "high", "Refund?"),
            ask("relay", "a", "high", "Restart the relay?"),
        ];
        let alert = alerts.observe(&items, NOW, true).unwrap();
        assert_eq!(alert.title, "relay needs you");
    }

    #[test]
    fn several_asks_are_one_notification_naming_the_first_few() {
        let mut alerts = primed(&[]);
        let items: Vec<Item> = ["a", "b", "c", "d", "e"]
            .iter()
            .enumerate()
            .map(|(i, id)| {
                let mut item = ask(&format!("ship{i}"), id, "high", "Go?");
                item.asked_ms = i as i64;
                item
            })
            .collect();
        let alert = alerts.observe(&items, NOW, true).unwrap();
        assert_eq!(alert.title, "5 asks need you");
        assert_eq!(
            alert.body,
            "ship0: Go?\nship1: Go?\nship2: Go?\nand 2 more"
        );
    }

    #[test]
    fn related_asks_are_one_line() {
        let mut alerts = primed(&[]);
        let grouped = |id: &str, question: &str| {
            let mut item = ask("billing", id, "high", question);
            item.mail.payload = json!({"decision": {
                "group": "refunds",
                "question": question,
                "options": [
                    {"id": "yes", "label": "Yes"},
                    {"id": "no", "label": "No"},
                ],
            }});
            item
        };
        let items = [
            grouped("a", "Refund order 1?"),
            grouped("b", "Refund order 2?"),
        ];
        let alert = alerts.observe(&items, NOW, true).unwrap();
        assert_eq!(alert.title, "billing needs you");
        assert!(alert.body.ends_with("(+1 related)"), "{}", alert.body);
    }

    #[test]
    fn a_hands_on_ask_leads_with_its_step_and_long_text_is_cut() {
        let mut hands = ask("status-page", "h", "high", "I am stuck.");
        hands.step =
            Some("Approve the two-factor prompt on your phone.".into());
        assert_eq!(
            headline(&hands),
            "Approve the two-factor prompt on your phone."
        );

        let long = ask("billing", "l", "high", &"word ".repeat(60));
        let line = headline(&long);
        assert!(line.ends_with('…'));
        assert!(line.chars().count() <= LINE_LIMIT + 1);
    }
}
