//! An ask as a decision card, and the captain's answer to it as the
//! `captain.reply` arguments. Every ask can be answered in the captain's own
//! words; a malformed or older ask is shown from its body, never dropped.

use std::collections::HashSet;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::captain::Mail;

const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Card {
    /// The sentence that asks.
    pub question: String,
    /// Why it matters, as Markdown.
    pub why: Option<String>,
    /// Who or what waits on the answer.
    pub blocked: Vec<String>,
    pub options: Vec<Choice>,
    /// The ship especially invites a written answer. One is always allowed.
    pub free_text_ok: bool,
    /// What was wrong with `payload.decision`, when it was there but did not
    /// read as one.
    pub problems: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Choice {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub what_happens: Option<String>,
    #[serde(default)]
    pub cost: Option<String>,
    #[serde(default)]
    pub recommended: bool,
}

#[derive(Debug, Deserialize)]
struct Payload {
    question: String,
    #[serde(default)]
    why: Option<String>,
    #[serde(default)]
    blocked: Vec<String>,
    options: Vec<Choice>,
    #[serde(default)]
    free_text_ok: bool,
}

impl Card {
    /// The ask as a card: `payload.decision` when it reads as one, else
    /// older `payload.choices`, else the body with no options.
    pub fn from_mail(mail: &Mail) -> Self {
        let mut problems = Vec::new();
        if let Some(decision) = mail.payload.get("decision") {
            match serde_json::from_value::<Payload>(decision.clone()) {
                Ok(payload) => {
                    problems = check(&payload);
                    if problems.is_empty() {
                        return Card {
                            question: payload.question,
                            why: payload
                                .why
                                .filter(|why| !why.trim().is_empty()),
                            blocked: payload.blocked,
                            options: payload.options,
                            free_text_ok: payload.free_text_ok,
                            problems,
                        };
                    }
                }
                Err(error) => problems.push(error.to_string()),
            }
        }

        let options: Vec<Choice> = mail
            .payload
            .get("choices")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|choice| !choice.trim().is_empty())
            .enumerate()
            .map(|(index, label)| Choice {
                id: format!("choice-{}", index + 1),
                label: label.to_owned(),
                what_happens: None,
                cost: None,
                recommended: false,
            })
            .collect();
        let (question, why) = split_body(&mail.body);
        Card {
            question,
            why,
            blocked: Vec::new(),
            // With fewer than two choices the ship plainly wants words.
            free_text_ok: options.len() < 2,
            options,
            problems,
        }
    }

    /// Whether the card's options came from older `payload.choices`, whose
    /// ids were made up here and mean nothing to the ship.
    fn legacy(&self) -> bool {
        self.options.iter().all(|o| o.id.starts_with("choice-"))
            && !self.options.is_empty()
    }
}

fn check(payload: &Payload) -> Vec<String> {
    let mut problems = Vec::new();
    if payload.question.trim().is_empty() {
        problems.push("the question is empty".into());
    }
    if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&payload.options.len()) {
        problems.push(format!(
            "it has {} options; a decision has {MIN_OPTIONS} to {MAX_OPTIONS}",
            payload.options.len()
        ));
    }
    let mut seen = HashSet::new();
    for option in &payload.options {
        if option.id.trim().is_empty() || option.label.trim().is_empty() {
            problems.push("an option has no id or label".into());
        } else if !seen.insert(option.id.as_str()) {
            problems.push(format!("option id {:?} is used twice", option.id));
        }
    }
    if payload.options.iter().filter(|o| o.recommended).count() > 1 {
        problems.push("more than one option is recommended".into());
    }
    problems
}

/// Split a body into the sentence that asks and the rest. The last sentence
/// ending in `?` is the question, else the first; a short body is all
/// question.
pub fn split_body(body: &str) -> (String, Option<String>) {
    let text = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return ("A ship is waiting on your answer.".into(), None);
    }
    if text.chars().count() <= 120 {
        return (text, None);
    }
    let sentences = sentences(&text);
    let index = sentences
        .iter()
        .rposition(|s| s.ends_with('?'))
        .unwrap_or(0);
    let question = sentences[index];
    if question.chars().count() > 200 {
        let cut: String = question.chars().take(199).collect();
        return (format!("{cut}…"), Some(body.trim().to_owned()));
    }
    let rest = sentences
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, s)| *s)
        .collect::<Vec<_>>()
        .join(" ");
    (question.to_owned(), (!rest.is_empty()).then_some(rest))
}

fn sentences(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes = text.as_bytes();
    for (i, c) in text.char_indices() {
        if matches!(c, '.' | '!' | '?') && bytes.get(i + 1) == Some(&b' ') {
            out.push(&text[start..=i]);
            start = i + 2;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

const MAX_GROUP: usize = 64;

/// The decision group an ask names: `payload.decision.group`, letters, digits,
/// `-` and `_`, at most 64 characters, as Privateer checks it. Asks from one
/// sender that name the same group are answered as one card.
pub fn group_of(mail: &Mail) -> Option<&str> {
    let group = mail.payload.get("decision")?.get("group")?.as_str()?;
    let well_formed = !group.is_empty()
        && group.len() <= MAX_GROUP
        && group
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    well_formed.then_some(group)
}

/// What the captain answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// An option, with an optional note under it.
    Option { id: String, note: String },
    /// The captain's own words.
    Words(String),
}

/// The `captain.reply` arguments for an answer to `id`. An option is
/// `{option_id}`, with a note `{option_id, text}`; own words are `{text}`.
/// An older ask's made-up option ids are not sent: its chosen words are.
pub fn reply_args(
    id: &str,
    card: &Card,
    answer: &Answer,
) -> Result<Value, String> {
    let (body, answer) = match answer {
        Answer::Option { id: option, note } => {
            let choice = card
                .options
                .iter()
                .find(|choice| &choice.id == option)
                .ok_or_else(|| format!("no option {option} on this ask"))?;
            let note = note.trim();
            let body = if note.is_empty() {
                choice.label.clone()
            } else {
                format!("{} — {note}", choice.label)
            };
            let answer = match (card.legacy(), note.is_empty()) {
                (true, true) => json!({"text": choice.label}),
                (true, false) => json!({"text": body}),
                (false, true) => json!({"option_id": choice.id}),
                (false, false) => json!({"option_id": choice.id, "text": note}),
            };
            (body, answer)
        }
        Answer::Words(words) => {
            let words = words.trim();
            if words.is_empty() {
                return Err("write an answer first".into());
            }
            (words.to_owned(), json!({"text": words}))
        }
    };
    Ok(json!({"id": id, "body": body, "payload": {"answer": answer}}))
}

/// A plain reply to a request, such as "Done." for a hands-on step.
pub fn plain_reply_args(id: &str, body: &str) -> Result<Value, String> {
    let body = body.trim();
    if body.is_empty() {
        return Err("write a reply first".into());
    }
    Ok(json!({"id": id, "body": body}))
}

/// The `captain.dismiss` arguments: the ask, and a note when there is one.
pub fn dismiss_args(id: &str, note: &str) -> Value {
    let note = note.trim();
    if note.is_empty() {
        json!({"id": id})
    } else {
        json!({"id": id, "note": note})
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mail(body: &str, payload: Value) -> Mail {
        Mail {
            id: "a1".into(),
            body: body.into(),
            payload,
            ..Mail::default()
        }
    }

    fn decision() -> Card {
        Card::from_mail(&mail(
            "Which retry policy?",
            json!({"decision": {
                "question": "Which retry policy?",
                "why": "Renewals fail.",
                "options": [
                    {"id": "smart", "label": "Smart retries", "cost": "~$40/mo", "recommended": true},
                    {"id": "none", "label": "No retries"}
                ]
            }}),
        ))
    }

    #[test]
    fn answers_take_the_agreed_reply_shapes() {
        let card = decision();
        assert!(card.problems.is_empty());
        let option = |note: &str| Answer::Option {
            id: "smart".into(),
            note: note.into(),
        };

        assert_eq!(
            reply_args("a1", &card, &option("")).unwrap(),
            json!({"id": "a1", "body": "Smart retries",
                   "payload": {"answer": {"option_id": "smart"}}})
        );
        assert_eq!(
            reply_args("a1", &card, &option(" start Monday ")).unwrap(),
            json!({"id": "a1", "body": "Smart retries — start Monday",
                   "payload": {"answer": {"option_id": "smart", "text": "start Monday"}}})
        );
        assert_eq!(
            reply_args("a1", &card, &Answer::Words("Wait a week".into()))
                .unwrap(),
            json!({"id": "a1", "body": "Wait a week",
                   "payload": {"answer": {"text": "Wait a week"}}})
        );
        assert!(reply_args("a1", &card, &Answer::Words("  ".into())).is_err());
        assert_eq!(dismiss_args("a1", " "), json!({"id": "a1"}));
    }

    #[test]
    fn older_and_malformed_asks_still_read_and_answer_in_words() {
        let legacy = Card::from_mail(&mail(
            "Ship build 14 today, or wait for the fix?",
            json!({"choices": ["Ship today", "Wait"]}),
        ));
        assert_eq!(legacy.options.len(), 2);
        assert_eq!(
            reply_args(
                "a1",
                &legacy,
                &Answer::Option {
                    id: "choice-1".into(),
                    note: String::new()
                }
            )
            .unwrap()["payload"],
            json!({"answer": {"text": "Ship today"}})
        );

        let broken = Card::from_mail(&mail(
            "Pick one?",
            json!({"decision": {"question": "Pick one?", "options": [{"id": "x", "label": "Only"}]}}),
        ));
        assert!(broken.options.is_empty());
        assert_eq!(broken.question, "Pick one?");
        assert!(broken.problems[0].contains("1 options"));
        assert!(broken.free_text_ok);
    }

    #[test]
    fn a_group_is_read_only_when_well_formed() {
        let grouped = |group: Value| {
            mail("Which?", json!({"decision": {"group": group}}))
        };
        assert_eq!(
            group_of(&grouped(json!("analytics-setup"))),
            Some("analytics-setup")
        );
        assert_eq!(group_of(&grouped(json!("a_1"))), Some("a_1"));
        assert_eq!(group_of(&grouped(json!("two words"))), None);
        assert_eq!(group_of(&grouped(json!("dots.here"))), None);
        assert_eq!(group_of(&grouped(json!(""))), None);
        assert_eq!(group_of(&grouped(json!(7))), None);
        assert_eq!(group_of(&grouped(json!("x".repeat(65)))), None);
        assert_eq!(
            group_of(&grouped(json!("x".repeat(64)))).map(str::len),
            Some(64)
        );
        assert_eq!(group_of(&mail("Which?", json!({"choices": ["a"]}))), None);
    }

    #[test]
    fn a_long_body_leads_with_the_sentence_that_asks() {
        let (question, why) = split_body(
            "Billing has failed renewals for a week. About 1 in 30 fail on the \
             first try. Should billing retry failed cards over seven days? \
             The pricing launch waits on this.",
        );
        assert_eq!(
            question,
            "Should billing retry failed cards over seven days?"
        );
        assert!(why.unwrap().starts_with("Billing has failed"));
    }
}
