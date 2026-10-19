//! The Feed: every message to and from the captain, as Privateer's
//! `captain.feed` returns it, kept as one conversation.
//!
//! Pages move only by cursor, never by time: the newest page is read
//! `before` just past now, new mail `after` the newest cursor read, older
//! pages `before` the oldest cursor read. A message is drawn by its time,
//! so a copy collected late from another machine lands where it was
//! written. It is keyed by sender and id, so it is never shown twice and
//! the later version wins.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Page {
    pub entries: Vec<Entry>,
    /// More entries lie further in the direction read.
    pub more: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Entry {
    pub cursor: String,
    pub id: String,
    /// The ship the captain is talking with.
    pub ship: Option<String>,
    pub from: String,
    pub to: String,
    /// `request`, `decision`, `notice` or `reply`.
    pub kind: String,
    /// `open`, `answered`, `dismissed`… for asks; none for notices.
    pub state: Option<String>,
    pub body: String,
    pub payload: Value,
    pub created_ms: i64,
    pub correlation: Option<String>,
    pub urgency: Option<String>,
    pub deadline_ms: Option<i64>,
    pub end_reason: Option<String>,
    pub answered_ms: Option<i64>,
    pub ended_ms: Option<i64>,
}

impl Entry {
    pub fn key(&self) -> String {
        format!("{}/{}", self.from, self.id)
    }

    /// The ship this message is with: as Privateer names it, else the side
    /// that is not the captain.
    pub fn ship(&self) -> &str {
        match &self.ship {
            Some(ship) if !ship.is_empty() => ship,
            _ if self.from == "captain" => &self.to,
            _ => &self.from,
        }
    }

    /// A notice the captain has not marked read: a report on it still takes
    /// comments.
    pub fn is_unread_notice(&self) -> bool {
        self.kind == "notice"
            && matches!(self.state.as_deref(), None | Some("open"))
    }

    pub fn is_open_ask(&self) -> bool {
        matches!(self.kind.as_str(), "request" | "decision")
            && self.state.as_deref() == Some("open")
    }
}

impl Page {
    pub fn parse(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }
}

/// One ship's part of the history: its mail with the captain, and with
/// `ship_mail` its other mail too (ship to ship, crew and runtime notices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub ship: String,
    pub ship_mail: bool,
}

impl Scope {
    /// Narrow a `captain.feed` read to this ship.
    pub fn narrow(&self, mut args: Value) -> Value {
        args["ship"] = Value::from(self.ship.as_str());
        if self.ship_mail {
            args["include_ship_mail"] = Value::Bool(true);
        }
        args
    }
}

/// The conversation read so far.
#[derive(Debug, Clone, Default)]
pub struct Thread {
    entries: HashMap<String, Entry>,
    /// Keys in drawing order: by time, then cursor.
    order: Vec<String>,
    /// Where new mail is read from: the newest cursor read.
    newest: Option<String>,
    /// Where older pages are read from, and whether there are any.
    oldest: Option<String>,
    pub more_older: bool,
}

impl Thread {
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry> {
        self.order.iter().filter_map(|key| self.entries.get(key))
    }

    pub fn get(&self, key: &str) -> Option<&Entry> {
        self.entries.get(key)
    }

    /// The arguments for the next read of new mail, or of the newest page
    /// when nothing is read yet. `now_ms` is only used for that first read.
    pub fn newer_args(&self, limit: u32, now_ms: i64) -> Value {
        match &self.newest {
            Some(cursor) => {
                serde_json::json!({"after": cursor, "limit": limit})
            }
            None => serde_json::json!({"before": now_ms + 1, "limit": limit}),
        }
    }

    pub fn older_args(&self, limit: u32) -> Option<Value> {
        let cursor = self.oldest.as_ref()?;
        self.more_older
            .then(|| serde_json::json!({"before": cursor, "limit": limit}))
    }

    /// Add the newest page, or new mail read after the newest cursor.
    pub fn add_newer(&mut self, page: Page) {
        let first_read = self.newest.is_none();
        if let Some(last) = page.entries.last() {
            self.newest = Some(last.cursor.clone());
        }
        if first_read {
            self.oldest = page.entries.first().map(|e| e.cursor.clone());
            self.more_older = page.more;
        }
        self.merge(page.entries);
    }

    /// Add a page read before the oldest cursor.
    pub fn add_older(&mut self, page: Page) {
        if let Some(first) = page.entries.first() {
            self.oldest = Some(first.cursor.clone());
        }
        self.more_older = page.more;
        self.merge(page.entries);
    }

    fn merge(&mut self, entries: Vec<Entry>) {
        for entry in entries {
            self.entries.insert(entry.key(), entry);
        }
        let mut order: Vec<(i64, String, String)> = self
            .entries
            .iter()
            .map(|(key, e)| (e.created_ms, e.cursor.clone(), key.clone()))
            .collect();
        order.sort();
        self.order = order.into_iter().map(|(_, _, key)| key).collect();
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn entry(from: &str, id: &str, created: i64, cursor: &str) -> Entry {
        Entry {
            from: from.into(),
            id: id.into(),
            created_ms: created,
            cursor: cursor.into(),
            ..Entry::default()
        }
    }

    fn ids(thread: &Thread) -> Vec<&str> {
        thread.entries().map(|e| e.id.as_str()).collect()
    }

    #[test]
    fn pages_move_by_cursor_and_messages_sit_by_time() {
        let mut thread = Thread::default();
        assert_eq!(
            thread.newer_args(15, 1000),
            json!({"before": 1001, "limit": 15})
        );

        thread.add_newer(Page {
            entries: vec![
                entry("a", "m2", 20, "c2"),
                entry("b", "m3", 30, "c3"),
            ],
            more: true,
        });
        assert_eq!(
            thread.newer_args(15, 9999),
            json!({"after": "c3", "limit": 15})
        );
        assert_eq!(
            thread.older_args(15),
            Some(json!({"before": "c2", "limit": 15}))
        );

        // New mail, including a copy collected late that was written earlier.
        thread.add_newer(Page {
            entries: vec![
                entry("c", "late", 25, "c4"),
                entry("a", "m5", 50, "c5"),
            ],
            more: false,
        });
        assert_eq!(ids(&thread), ["m2", "late", "m3", "m5"]);
        assert_eq!(thread.newer_args(15, 9999)["after"], "c5");

        thread.add_older(Page {
            entries: vec![entry("a", "m1", 10, "c1")],
            more: false,
        });
        assert_eq!(ids(&thread), ["m1", "m2", "late", "m3", "m5"]);
        assert_eq!(thread.older_args(15), None);
    }

    #[test]
    fn reads_privateers_feed_shape() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/captain.feed.json"
        ))
        .unwrap();
        let page = Page::parse(fixture).unwrap();
        // The fixture predates cursors; Privateer sends one per entry.
        assert!(page.entries.len() > 5);
        assert!(page.entries.iter().any(Entry::is_open_ask));
    }

    #[test]
    fn a_message_is_its_sender_and_id_and_the_later_version_wins() {
        let mut thread = Thread::default();
        let mut open = entry("scout", "x1", 10, "c1");
        open.state = Some("open".into());
        let other_ship = entry("fitforge", "x1", 11, "c2");
        thread.add_newer(Page {
            entries: vec![open.clone(), other_ship],
            more: false,
        });
        assert_eq!(ids(&thread), ["x1", "x1"]);

        let mut answered = open;
        answered.state = Some("answered".into());
        thread.add_newer(Page {
            entries: vec![answered],
            more: false,
        });
        assert_eq!(thread.entries().count(), 2);
        assert_eq!(
            thread.get("scout/x1").unwrap().state.as_deref(),
            Some("answered")
        );
    }

    #[test]
    fn a_ships_conversation_reads_only_that_ship_and_names_it() {
        let thread = Thread::default();
        let scope = Scope {
            ship: "billing".into(),
            ship_mail: true,
        };
        let args = scope.narrow(thread.newer_args(30, 1000));
        assert_eq!(
            args,
            json!({"before": 1001, "limit": 30, "ship": "billing",
                   "include_ship_mail": true})
        );

        let mut mine = entry("captain", "m1", 1, "c1");
        mine.to = "billing".into();
        assert_eq!(mine.ship(), "billing");
        let mut between = entry("ops", "m2", 2, "c2");
        between.ship = Some("billing".into());
        assert_eq!(between.ship(), "billing");
    }

}
