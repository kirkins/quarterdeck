//! What the captain answered lately: asks closed in the last day, each with
//! what was chosen or written, read from Privateer's `captain.feed`.
//!
//! Two pages make the list. The closed asks come from a read filtered to
//! closed states, so an ask written days ago but answered an hour ago is
//! still found. The captain's replies, which carry the words, have no state
//! to filter by: they come from the newest page of the whole feed, so an
//! answer older than that page says only when it was given. So does one
//! whose reply the feed never holds: a captain's desk keeps the asks it
//! copied, marked answered, but not a reply delivered in the ship's own home.

use std::collections::HashMap;

use serde_json::{Value, json};

use crate::decision::Card;
use crate::feed::{Entry, Page};
use crate::triage::DAY_MS;

/// How far back the list reaches.
pub const WINDOW_MS: i64 = DAY_MS;

/// Entries read per page.
pub const PAGE: u32 = 200;

/// The states a closed ask can be in.
const CLOSED: &[&str] =
    &["answered", "dismissed", "withdrawn", "approved", "denied"];

/// One closed ask.
#[derive(Debug, Clone, PartialEq)]
pub struct Answered {
    /// The ask's triage key: its sender and id.
    pub key: String,
    pub ship: String,
    /// The decision's question, or how the ask starts.
    pub question: String,
    /// What became of it: "You chose …", "You answered: …", "Dismissed"…
    pub outcome: String,
    pub closed_ms: i64,
    /// The answer was relayed for the captain by the operator.
    pub relayed: bool,
    /// The outcome says what the answer was, not only when it came: the
    /// reply was found, or the ask was dismissed or withdrawn.
    pub said: bool,
}

/// The `captain.feed` arguments for the closed asks.
pub fn closed_args(now_ms: i64) -> Value {
    json!({"states": CLOSED, "before": now_ms + 1, "limit": PAGE})
}

/// The `captain.feed` arguments for the newest page, for the replies.
pub fn replies_args(now_ms: i64) -> Value {
    json!({"before": now_ms + 1, "limit": PAGE})
}

/// The asks closed within the window, most recently closed first.
pub fn recent(closed: &Page, newest: &Page, now_ms: i64) -> Vec<Answered> {
    let replies: HashMap<String, &Entry> = closed
        .entries
        .iter()
        .chain(&newest.entries)
        .filter(|entry| entry.from == "captain")
        .filter_map(|entry| {
            let ask = entry.correlation.as_ref()?;
            Some((format!("{}/{ask}", entry.to), entry))
        })
        .collect();

    let mut list: Vec<Answered> = closed
        .entries
        .iter()
        .filter(|entry| matches!(entry.kind.as_str(), "request" | "decision"))
        .filter(|entry| {
            entry.state.as_deref().is_some_and(|s| CLOSED.contains(&s))
        })
        .filter_map(|ask| {
            let closed_ms = ask.closed_ms()?;
            if now_ms - closed_ms > WINDOW_MS {
                return None;
            }
            let key = ask.key();
            let reply = replies.get(&key).copied();
            let said =
                reply.is_some() || ask.state.as_deref() != Some("answered");
            Some(Answered {
                said,
                question: question(ask),
                outcome: outcome(ask, reply, now_ms),
                relayed: reply
                    .is_some_and(|reply| reply.payload["operator"] == true),
                ship: ask.ship().to_owned(),
                closed_ms,
                key,
            })
        })
        .collect();
    list.sort_by(|a, b| b.closed_ms.cmp(&a.closed_ms).then(a.key.cmp(&b.key)));
    list.dedup_by(|a, b| a.key == b.key);
    list
}

fn outcome(ask: &Entry, reply: Option<&Entry>, now_ms: i64) -> String {
    if let Some(words) = ask.outcome(reply, now_ms) {
        return words;
    }
    match ask.state.as_deref() {
        Some("withdrawn") => "Withdrawn by the ship",
        Some("approved") => "Approved",
        Some("denied") => "Denied",
        _ => "Closed",
    }
    .to_owned()
}

/// A decision leads with its question; any other ask with how it starts.
fn question(ask: &Entry) -> String {
    let card = Card::from_mail(&ask.as_mail());
    let text = if card.options.is_empty() || card.question.is_empty() {
        ask.body.as_str()
    } else {
        card.question.as_str()
    };
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_792_400_000_000;
    const HOUR: i64 = 3_600_000;

    fn ask(id: &str, state: &str, closed: i64) -> Entry {
        Entry {
            id: id.into(),
            from: "fitforge".into(),
            to: "captain".into(),
            kind: "request".into(),
            state: Some(state.into()),
            body: format!("Question {id}?"),
            created_ms: NOW - 40 * HOUR,
            answered_ms: Some(closed),
            ..Entry::default()
        }
    }

    fn reply(to_ask: &str, body: &str, payload: Value) -> Entry {
        Entry {
            id: format!("r-{to_ask}"),
            from: "captain".into(),
            to: "fitforge".into(),
            kind: "reply".into(),
            correlation: Some(to_ask.into()),
            body: body.into(),
            payload,
            ..Entry::default()
        }
    }

    #[test]
    fn lists_what_closed_in_the_last_day_with_its_answer_newest_first() {
        let mut decision = ask("d1", "answered", NOW - 2 * HOUR);
        decision.kind = "decision".into();
        decision.payload = json!({"decision": {
            "question": "Which backup?",
            "options": [{"id": "a", "label": "Delete it"},
                        {"id": "b", "label": "Keep it for renewals"}]
        }});
        let mut notice = ask("n1", "answered", NOW - HOUR);
        notice.kind = "notice".into();
        let closed = Page {
            entries: vec![
                decision,
                // Answered elsewhere, its reply older than the newest page.
                ask("e1", "answered", NOW - 3 * HOUR),
                ask("w1", "withdrawn", NOW - 4 * HOUR),
                ask("old", "answered", NOW - 25 * HOUR),
                notice,
            ],
            more: false,
        };
        let newest = Page {
            entries: vec![
                reply(
                    "d1",
                    "Keep it for renewals",
                    json!({"answer": {"option_id": "b"}, "operator": true}),
                ),
                ask("open", "open", 0),
            ],
            more: true,
        };

        let list = recent(&closed, &newest, NOW);
        let rows: Vec<(&str, &str, bool, bool)> = list
            .iter()
            .map(|a| (a.key.as_str(), a.outcome.as_str(), a.relayed, a.said))
            .collect();
        assert_eq!(
            rows,
            [
                ("fitforge/d1", "You chose Keep it for renewals", true, true),
                ("fitforge/e1", "Answered 3h ago", false, false),
                ("fitforge/w1", "Withdrawn by the ship", false, true),
            ]
        );
        assert_eq!(list[0].question, "Which backup?");
        assert_eq!(list[1].question, "Question e1?");
    }
}
