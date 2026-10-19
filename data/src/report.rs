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

/// The file that holds every report's comment drafts, in the data directory.
const DRAFTS_FILE: &str = "report-drafts.json";

pub fn drafts_path() -> PathBuf {
    environment::data_dir().join(DRAFTS_FILE)
}

/// The drafts kept for a report, by its key. A missing or unreadable file
/// holds none.
pub fn load_drafts(path: &Path, key: &str) -> Vec<Comment> {
    read_drafts(path).remove(key).unwrap_or_default()
}

/// Keep `comments` as the drafts of a report, or none once it is empty.
pub fn save_drafts(
    path: &Path,
    key: &str,
    comments: &[Comment],
) -> Result<(), String> {
    let mut all = read_drafts(path);
    if comments.is_empty() {
        all.remove(key);
    } else {
        all.insert(key.to_owned(), comments.to_vec());
    }
    let bytes = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

fn read_drafts(path: &Path) -> BTreeMap<String, Vec<Comment>> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        log::warn!("ignoring report drafts {}: {error}", path.display());
        BTreeMap::new()
    })
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
