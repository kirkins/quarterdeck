//! Reports a ship hands the captain, and the captain's comments on them.
//!
//! A report rides on mail to the captain as `payload.report`: inline
//! `{title, format, content}`, or a reference `{report_id, title, format,
//! bytes}` to one stored with `report.put`, read with `report.get`. The
//! captain answers with `payload.annotations` on `captain.reply`: each a
//! comment anchored to a block of the report by `{selector, quote}`.
//! The limits are Privateer's, so nothing sent is refused for its size.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::environment;
use crate::feed::Entry;
use crate::fleet::Snapshot;

pub const MAX_ANNOTATIONS: usize = 100;
pub const MAX_COMMENT_CHARS: usize = 4096;
pub const MAX_ANCHOR_CHARS: usize = 2000;

/// The report on a message, as it rides there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attached {
    Inline {
        title: String,
        format: String,
        content: String,
    },
    Stored {
        id: String,
        title: Option<String>,
        format: Option<String>,
    },
}

impl Attached {
    /// The report on a message's payload, if it has one.
    pub fn of(payload: &Value) -> Option<Self> {
        let report = payload.get("report")?;
        let text = |key: &str| {
            report.get(key).and_then(Value::as_str).map(str::to_owned)
        };
        match (text("report_id"), text("content")) {
            (Some(id), _) => Some(Attached::Stored {
                id,
                title: text("title"),
                format: text("format"),
            }),
            (None, Some(content)) => Some(Attached::Inline {
                title: text("title").unwrap_or_else(|| "Report".to_owned()),
                format: text("format").unwrap_or_else(|| "markdown".to_owned()),
                content,
            }),
            (None, None) => None,
        }
    }

    pub fn title(&self) -> &str {
        match self {
            Attached::Inline { title, .. } => title,
            Attached::Stored { title, .. } => {
                title.as_deref().unwrap_or("Report")
            }
        }
    }
}

/// A stored report, as `report.get` returns it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
pub struct Report {
    pub id: String,
    pub ship: String,
    pub title: Option<String>,
    pub format: String,
    pub content: String,
    pub created_ms: i64,
}

impl Report {
    pub fn parse(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }
}

/// One comment on a block of the report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Comment {
    /// Which block, as `block:<index>`.
    pub selector: String,
    /// The block's text, so the ship can find it.
    pub quote: String,
    pub text: String,
}

impl Comment {
    pub fn on_block(index: usize, block_text: &str, text: &str) -> Self {
        Comment {
            selector: format!("block:{index}"),
            quote: cut(block_text.trim(), MAX_ANCHOR_CHARS),
            text: text.to_owned(),
        }
    }
}

/// The `captain.reply` arguments that send `comments` on the report
/// `title` back to the ask `id`, with an optional note.
pub fn reply_args(
    id: &str,
    title: &str,
    comments: &[Comment],
    note: &str,
) -> Result<Value, String> {
    let comments: Vec<&Comment> = comments
        .iter()
        .filter(|c| !c.text.trim().is_empty())
        .collect();
    if comments.is_empty() {
        return Err("write a comment first".into());
    }
    if comments.len() > MAX_ANNOTATIONS {
        return Err(format!(
            "at most {MAX_ANNOTATIONS} comments go in one reply"
        ));
    }
    if let Some(long) = comments
        .iter()
        .find(|c| c.text.trim().chars().count() > MAX_COMMENT_CHARS)
    {
        return Err(format!(
            "a comment on \"{}\" is longer than {MAX_COMMENT_CHARS} characters",
            cut(&long.quote, 40)
        ));
    }

    let annotations: Vec<Value> = comments
        .iter()
        .map(|c| {
            json!({
                "anchor": {"selector": c.selector, "quote": c.quote},
                "comment": c.text.trim(),
            })
        })
        .collect();
    let count = annotations.len();
    let mut body = format!(
        "{count} comment{} on {title}",
        if count == 1 { "" } else { "s" }
    );
    if !note.trim().is_empty() {
        body.push_str("\n\n");
        body.push_str(note.trim());
    }
    Ok(json!({"id": id, "body": body, "payload": {"annotations": annotations}}))
}

/// A comment the captain already sent on a report, as its annotation went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentComment {
    pub sent_ms: i64,
    pub selector: Option<String>,
    pub quote: Option<String>,
    pub text: String,
}

/// The comments sent on the report on `ship`'s mail `mail_id`, oldest first:
/// the captain's mail in that thread that carries `payload.annotations`.
pub fn sent_on<'a>(
    entries: impl IntoIterator<Item = &'a Entry>,
    ship: &str,
    mail_id: &str,
) -> Vec<SentComment> {
    let mut sent = Vec::new();
    for entry in entries {
        if entry.from != "captain"
            || entry.to != ship
            || entry.correlation.as_deref() != Some(mail_id)
        {
            continue;
        }
        let Some(annotations) =
            entry.payload.get("annotations").and_then(Value::as_array)
        else {
            continue;
        };
        for annotation in annotations {
            let Some(text) = annotation.get("comment").and_then(Value::as_str)
            else {
                continue;
            };
            let anchor = |key: &str| {
                annotation
                    .get("anchor")
                    .and_then(|a| a.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            };
            sent.push(SentComment {
                sent_ms: entry.created_ms,
                selector: anchor("selector"),
                quote: anchor("quote"),
                text: text.to_owned(),
            });
        }
    }
    sent.sort_by_key(|c| c.sent_ms);
    sent
}

/// The block a sent comment belongs to, among the report's blocks as plain
/// text: its `block:<index>` while that block still reads as quoted, else the
/// first block that holds its quote. Another reader's selector is not read.
pub fn place(comment: &SentComment, blocks: &[String]) -> Option<usize> {
    let quote = comment.quote.as_deref().map(squeeze).unwrap_or_default();
    let index = comment
        .selector
        .as_deref()
        .and_then(|s| s.strip_prefix("block:"))
        .and_then(|n| n.parse::<usize>().ok())
        .filter(|&n| {
            blocks
                .get(n)
                .is_some_and(|block| squeeze(block).starts_with(&quote))
        });
    index.or_else(|| {
        (!quote.is_empty())
            .then(|| blocks.iter().position(|b| squeeze(b).contains(&quote)))
            .flatten()
    })
}

impl SentComment {
    /// A comment as it was just sent, at `sent_ms`.
    pub fn of(comment: &Comment, sent_ms: i64) -> Self {
        SentComment {
            sent_ms,
            selector: Some(comment.selector.clone()),
            quote: Some(comment.quote.clone()),
            text: comment.text.trim().to_owned(),
        }
    }
}

/// The comments kept as sent from here that the feed does not show: just
/// sent, or a reply the captain's desk does not hold.
pub fn missing_from<'a>(
    kept: &'a [SentComment],
    read: &'a [SentComment],
) -> impl Iterator<Item = &'a SentComment> {
    kept.iter().filter(|c| {
        !read
            .iter()
            .any(|r| r.selector == c.selector && r.text == c.text)
    })
}

/// Text with every run of whitespace as one space.
fn squeeze(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The file that holds every report's comment drafts, in the data directory.
const DRAFTS_FILE: &str = "report-drafts.json";

pub fn drafts_path() -> PathBuf {
    environment::data_dir().join(DRAFTS_FILE)
}

/// The drafts kept for a report, by its key. A missing or unreadable file
/// holds none.
pub fn load_drafts(path: &Path, key: &str) -> Vec<Comment> {
    read_map(path).remove(key).unwrap_or_default()
}

/// Keep `comments` as the drafts of a report, or none once it is empty.
pub fn save_drafts(
    path: &Path,
    key: &str,
    comments: &[Comment],
) -> Result<(), String> {
    let mut all = read_map(path);
    if comments.is_empty() {
        all.remove(key);
    } else {
        all.insert(key.to_owned(), comments.to_vec());
    }
    write_map(path, &all)
}

/// The file that holds the comments sent from here, in the data directory:
/// the captain's desk does not always hold the reply that carried them.
const SENT_FILE: &str = "report-sent.json";
/// Reports whose sent comments are kept; those last sent to longest ago go.
const KEEP_SENT: usize = 500;

pub fn sent_path() -> PathBuf {
    environment::data_dir().join(SENT_FILE)
}

/// The comments sent from here on a report, by its key, oldest first.
pub fn load_sent(path: &Path, key: &str) -> Vec<SentComment> {
    read_map(path).remove(key).unwrap_or_default()
}

/// Add `comments` to those sent from here on a report.
pub fn keep_sent(
    path: &Path,
    key: &str,
    comments: &[SentComment],
) -> Result<(), String> {
    let mut all: BTreeMap<String, Vec<SentComment>> = read_map(path);
    all.entry(key.to_owned())
        .or_default()
        .extend_from_slice(comments);
    while all.len() > KEEP_SENT {
        let oldest = all
            .iter()
            .min_by_key(|(_, c)| c.iter().map(|c| c.sent_ms).max())
            .map(|(key, _)| key.clone());
        all.remove(&oldest.unwrap_or_default());
    }
    write_map(path, &all)
}

/// A file of lists by report key. A missing or unreadable file holds none.
fn read_map<T: serde::de::DeserializeOwned>(
    path: &Path,
) -> BTreeMap<String, Vec<T>> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        log::warn!("ignoring {}: {error}", path.display());
        BTreeMap::new()
    })
}

fn write_map<T: Serialize>(
    path: &Path,
    all: &BTreeMap<String, Vec<T>>,
) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(all).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

/// Whether a refused `report.get` is for a report held on another machine:
/// Privateer says it is not in the fleet, and the ship that sent it is placed
/// on another machine by the fleet as last read.
pub fn held_elsewhere(
    error: &str,
    ship: &str,
    fleet: Option<&Snapshot>,
) -> bool {
    if !(error.contains("no report") && error.contains("in the fleet")) {
        return false;
    }
    fleet
        .and_then(|fleet| fleet.ship(ship))
        .is_some_and(|(machine, _)| {
            matches!(machine.link.as_deref(), Some("reaches" | "reached_by"))
        })
}

/// At most `limit` characters, cut by character, never inside one.
fn cut(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_an_inline_or_stored_report_off_a_message() {
        assert_eq!(
            Attached::of(
                &json!({"report": {"title": "Audit", "format": "markdown", "content": "# A"}})
            ),
            Some(Attached::Inline {
                title: "Audit".into(),
                format: "markdown".into(),
                content: "# A".into(),
            })
        );
        let stored = Attached::of(&json!({"report": {"report_id": "report-1", "title": "Plan", "bytes": 9}}))
            .unwrap();
        assert_eq!(stored.title(), "Plan");
        assert!(
            matches!(stored, Attached::Stored { ref id, .. } if id == "report-1")
        );
        assert_eq!(Attached::of(&json!({"decision": {}})), None);
    }

    #[test]
    fn sent_comments_are_read_from_the_thread_and_placed_by_block() {
        let reply =
            |id: &str, to: &str, correlation: &str, at: i64, payload| Entry {
                id: id.into(),
                from: "captain".into(),
                to: to.into(),
                kind: "reply".into(),
                correlation: Some(correlation.into()),
                created_ms: at,
                payload,
                ..Entry::default()
            };
        let entries = [
            reply(
                "c2",
                "docs",
                "d1",
                20,
                json!({"annotations": [
                    {"anchor": {"selector": "block:2", "quote": "the Feed"},
                     "comment": "Second round."},
                ]}),
            ),
            reply(
                "c1",
                "docs",
                "d1",
                10,
                json!({"annotations": [
                    {"anchor": {"quote": "reads three   things"},
                     "comment": "Say who."},
                    {"anchor": {"selector": "1/0", "quote": "the Decisions page"},
                     "comment": "Keep the order."},
                    {"anchor": {"quote": "Gone from the report"},
                     "comment": "Unplaced."},
                ]}),
            ),
            reply("c3", "docs", "d9", 30, json!({"annotations": []})),
            reply("c4", "other", "d1", 40, json!({"annotations": []})),
            reply("c5", "docs", "d1", 50, json!({"answer": {"text": "ok"}})),
        ];

        let sent = sent_on(&entries, "docs", "d1");
        let texts: Vec<&str> = sent.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(
            texts,
            ["Say who.", "Keep the order.", "Unplaced.", "Second round."]
        );
        assert_eq!(sent[0].sent_ms, 10);

        let blocks = [
            "Onboarding".to_owned(),
            "A new captain reads three things first:".to_owned(),
            "the Decisions page\nthe Feed\nthe Fleet map".to_owned(),
        ];
        let placed: Vec<Option<usize>> =
            sent.iter().map(|c| place(c, &blocks)).collect();
        assert_eq!(placed, [Some(1), Some(2), None, Some(2)]);

        // A block selector whose block no longer reads as quoted is placed
        // by its quote instead.
        let moved = SentComment {
            sent_ms: 0,
            selector: Some("block:0".into()),
            quote: Some("A new captain".into()),
            text: "x".into(),
        };
        assert_eq!(place(&moved, &blocks), Some(1));
    }

    #[test]
    fn sent_comments_kept_here_show_where_the_feed_lacks_them() {
        let just_sent = [
            SentComment::of(&Comment::on_block(2, "the Feed", " Again. "), 5),
            SentComment::of(&Comment::on_block(0, "Title", "New"), 5),
        ];
        let read = |text: &str| SentComment {
            sent_ms: 9,
            selector: Some("block:2".into()),
            quote: None,
            text: text.into(),
        };
        assert_eq!(just_sent[0].text, "Again.");
        assert_eq!(missing_from(&just_sent, &[]).count(), 2);
        let read = [read("Again.")];
        let left: Vec<&str> = missing_from(&just_sent, &read)
            .map(|c| c.text.as_str())
            .collect();
        assert_eq!(left, ["New"]);
    }

    #[test]
    fn drafts_are_kept_per_report_until_cleared() {
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-drafts-{}", std::process::id()));
        let path = dir.join(DRAFTS_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        let one = [Comment::on_block(0, "Exports omit photos.", "Fix this")];

        assert!(load_drafts(&path, "ship/a1").is_empty());
        save_drafts(&path, "ship/a1", &one).unwrap();
        save_drafts(&path, "ship/b2", &one[..0]).unwrap();
        assert_eq!(load_drafts(&path, "ship/a1"), one.to_vec());

        save_drafts(&path, "ship/a1", &[]).unwrap();
        assert!(load_drafts(&path, "ship/a1").is_empty());
        std::fs::write(&path, b"not json").unwrap();
        assert!(load_drafts(&path, "ship/a1").is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sent_comments_are_kept_per_report_and_added_to() {
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-sent-{}", std::process::id()));
        let path = dir.join(SENT_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        let first = SentComment::of(&Comment::on_block(0, "A", "One"), 1);
        let second = SentComment::of(&Comment::on_block(1, "B", "Two"), 2);

        assert!(load_sent(&path, "ship/a1").is_empty());
        keep_sent(&path, "ship/a1", std::slice::from_ref(&first)).unwrap();
        keep_sent(&path, "ship/a1", std::slice::from_ref(&second)).unwrap();
        assert_eq!(load_sent(&path, "ship/a1"), [first, second]);
        assert!(load_sent(&path, "ship/b2").is_empty());

        for n in 0..KEEP_SENT {
            let comment =
                SentComment::of(&Comment::on_block(0, "A", "x"), 10 + n as i64);
            keep_sent(&path, &format!("ship/n{n}"), &[comment]).unwrap();
        }
        assert!(load_sent(&path, "ship/a1").is_empty());
        assert_eq!(load_sent(&path, "ship/n0").len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_report_on_another_machine_is_told_apart() {
        let fleet = Snapshot::parse(serde_json::json!({
            "machines": [
                {"name": "here", "link": "here"},
                {"name": "laptop", "link": "reaches"},
            ],
            "ships": [
                {"name": "billing", "machine": "here"},
                {"name": "status-page", "machine": "laptop"},
            ]
        }))
        .unwrap();
        let refused =
            r#"{"ok":false,"error":"no report report-1 in the fleet"}"#;

        assert!(held_elsewhere(refused, "status-page", Some(&fleet)));
        assert!(!held_elsewhere(refused, "billing", Some(&fleet)));
        assert!(!held_elsewhere(refused, "unknown", Some(&fleet)));
        assert!(!held_elsewhere(refused, "status-page", None));
        assert!(!held_elsewhere(
            "permission denied",
            "status-page",
            Some(&fleet)
        ));
    }

    #[test]
    fn comments_go_back_as_one_reply_within_privateers_limits() {
        let long_block = "é".repeat(MAX_ANCHOR_CHARS + 10);
        let comments = [
            Comment::on_block(0, "Exports omit photos.", " Fix this first. "),
            Comment::on_block(3, &long_block, "Too long to quote whole"),
            Comment::on_block(4, "Unused", "   "),
        ];

        let args =
            reply_args("a1", "Backup audit", &comments, "Thanks").unwrap();

        assert_eq!(args["id"], "a1");
        assert_eq!(args["body"], "2 comments on Backup audit\n\nThanks");
        let annotations = args["payload"]["annotations"].as_array().unwrap();
        assert_eq!(annotations.len(), 2);
        assert_eq!(
            annotations[0],
            json!({"anchor": {"selector": "block:0", "quote": "Exports omit photos."},
                   "comment": "Fix this first."})
        );
        let quote = annotations[1]["anchor"]["quote"].as_str().unwrap();
        assert_eq!(quote.chars().count(), MAX_ANCHOR_CHARS);

        assert!(reply_args("a1", "x", &comments[2..], "").is_err());
        let too_long = [Comment::on_block(
            0,
            "b",
            &"x".repeat(MAX_COMMENT_CHARS + 1),
        )];
        assert!(reply_args("a1", "x", &too_long, "").is_err());
    }
}
