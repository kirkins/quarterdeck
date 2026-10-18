//! Choices a ship wrote into a plain request ("A – …", "B – …", or
//! "1) … 2) …"), so the captain can tick them instead of typing a letter.
//!
//! Only a run of two or more choices whose markers follow on (A, B, C or 1,
//! 2, 3) counts, so a stray "A." or a list of steps is left alone.

use crate::markdown::{Document, Node, Span};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// The marker as the ship wrote it: "A", "1".
    pub marker: String,
    pub text: String,
}

/// A request read around its choices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Split {
    pub before: Document,
    pub choices: Vec<Choice>,
    pub after: Document,
}

/// The request's choices, if it lists some.
pub fn split(document: &Document) -> Option<Split> {
    let asks = document.plain_text().contains('?');

    for (index, node) in document.nodes.iter().enumerate() {
        // Choices as paragraphs, one after another.
        if let Node::Paragraph(spans) = node
            && let Some(first) = leading_marker(&plain(spans))
        {
            let mut choices = vec![first];
            let mut end = index + 1;
            while let Some(Node::Paragraph(spans)) = document.nodes.get(end)
                && let Some(next) = leading_marker(&plain(spans))
                && follows(&choices[choices.len() - 1].marker, &next.marker)
            {
                choices.push(next);
                end += 1;
            }
            if choices.len() >= 2 && starts(&choices[0].marker) {
                return Some(around(document, index, end, choices, None));
            }
        }

        // Choices inline in one paragraph: "… 1) one? 2) two?".
        if let Node::Paragraph(spans) = node
            && let Some((intro, choices)) = inline(&plain(spans))
        {
            let intro = (!intro.is_empty()).then(|| {
                Node::Paragraph(vec![Span {
                    text: intro,
                    ..Span::default()
                }])
            });
            return Some(around(document, index, index + 1, choices, intro));
        }

        // A numbered list, when the message asks something.
        if let Node::List {
            ordered: true,
            start,
            items,
        } = node
            && asks
            && items.len() >= 2
        {
            let choices = items
                .iter()
                .enumerate()
                .map(|(i, item)| Choice {
                    marker: (start + i).to_string(),
                    text: plain(item),
                })
                .collect();
            return Some(around(document, index, index + 1, choices, None));
        }
    }
    None
}

fn around(
    document: &Document,
    from: usize,
    to: usize,
    choices: Vec<Choice>,
    intro: Option<Node>,
) -> Split {
    let mut before = document.nodes[..from].to_vec();
    before.extend(intro);
    Split {
        before: Document { nodes: before },
        choices,
        after: Document {
            nodes: document.nodes[to..].to_vec(),
        },
    }
}

fn plain(spans: &[Span]) -> String {
    spans.iter().map(|span| span.text.as_str()).collect()
}

/// "A – text", "A) text", "A. text", "A: text", "(a) text", "1) text",
/// "1. text", "Option B: text".
fn leading_marker(text: &str) -> Option<Choice> {
    let text = text.trim_start();
    let text = text
        .strip_prefix("Option ")
        .or_else(|| text.strip_prefix("option "))
        .unwrap_or(text);
    let (marker, rest) = marker_at(text)?;
    let rest = rest.trim_start();
    let rest = rest
        .strip_prefix('–')
        .or_else(|| rest.strip_prefix('—'))
        .or_else(|| rest.strip_prefix("- "))
        .unwrap_or(rest)
        .trim_start();
    (!rest.is_empty()).then(|| Choice {
        marker,
        text: rest.to_owned(),
    })
}

/// A marker at the start of `text` and what follows it. A letter needs a
/// delimiter or a dash after it, so a sentence starting "A new…" is not one.
fn marker_at(text: &str) -> Option<(String, &str)> {
    let (open, text) = match text.strip_prefix('(') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    let first = text.chars().next()?;
    let (marker, rest) = if first.is_ascii_digit() {
        let digits = text.chars().take_while(char::is_ascii_digit).count();
        if digits > 2 {
            return None;
        }
        (text[..digits].to_owned(), &text[digits..])
    } else if first.is_ascii_alphabetic()
        && text[1..]
            .chars()
            .next()
            .is_some_and(|c| !c.is_alphanumeric())
        && ('A'..='H').contains(&first.to_ascii_uppercase())
    {
        (first.to_ascii_uppercase().to_string(), &text[1..])
    } else {
        return None;
    };

    let rest = if open {
        rest.strip_prefix(')')?
    } else if let Some(rest) = rest
        .strip_prefix(')')
        .or_else(|| rest.strip_prefix('.'))
        .or_else(|| rest.strip_prefix(':'))
    {
        rest
    } else {
        // Without a delimiter, only a dash makes it a marker: "A – text".
        let trimmed = rest.trim_start();
        if !(trimmed.starts_with('–')
            || trimmed.starts_with('—')
            || trimmed.starts_with("- "))
        {
            return None;
        }
        rest
    };
    rest.starts_with(char::is_whitespace)
        .then_some((marker, rest))
}

/// Whether `next` follows `marker`: B after A, 2 after 1.
fn follows(marker: &str, next: &str) -> bool {
    match (marker.parse::<u32>(), next.parse::<u32>()) {
        (Ok(a), Ok(b)) => b == a + 1,
        (Err(_), Err(_)) => {
            let (a, b) = (marker.chars().next(), next.chars().next());
            matches!((a, b), (Some(a), Some(b)) if b as u32 == a as u32 + 1)
        }
        _ => false,
    }
}

fn starts(marker: &str) -> bool {
    marker == "A" || marker == "1"
}

/// Choices written inline, "intro 1) one 2) two": the intro and the choices.
fn inline(text: &str) -> Option<(String, Vec<Choice>)> {
    for markers in [
        &["1)", "2)", "3)", "4)", "5)", "6)"][..],
        &["A)", "B)", "C)", "D)", "E)", "F)"][..],
    ] {
        let mut positions = Vec::new();
        let mut from = 0;
        for marker in markers {
            let found = text[from..].match_indices(marker).find(|(i, _)| {
                let at = from + i;
                (at == 0 || text[..at].ends_with(char::is_whitespace))
                    && text[at + marker.len()..].starts_with(' ')
            });
            match found {
                Some((i, _)) => {
                    positions.push((from + i, *marker));
                    from += i + marker.len();
                }
                None => break,
            }
        }
        if positions.len() < 2 {
            continue;
        }
        let intro = text[..positions[0].0].trim().to_owned();
        let choices = positions
            .iter()
            .enumerate()
            .map(|(n, (at, marker))| {
                let end =
                    positions.get(n + 1).map_or(text.len(), |(next, _)| *next);
                Choice {
                    marker: marker.trim_end_matches(')').to_owned(),
                    text: text[at + marker.len()..end].trim().to_owned(),
                }
            })
            .collect();
        return Some((intro, choices));
    }
    None
}

/// The reply for the ticked choices and a note: "A", "1 and 3", with the
/// note after a dash.
pub fn reply(ticked: &[&Choice], note: &str) -> Option<String> {
    let markers: Vec<&str> = ticked.iter().map(|c| c.marker.as_str()).collect();
    let picked = match markers.as_slice() {
        [] => String::new(),
        [one] => (*one).to_owned(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    let note = note.trim();
    match (picked.is_empty(), note.is_empty()) {
        (true, true) => None,
        (true, false) => Some(note.to_owned()),
        (false, true) => Some(picked),
        (false, false) => Some(format!("{picked} — {note}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::markdown::parse;

    fn markers(split: &Split) -> Vec<&str> {
        split.choices.iter().map(|c| c.marker.as_str()).collect()
    }

    #[test]
    fn lettered_paragraphs_become_choices_and_the_rest_stays() {
        let doc = parse(
            "Improve the backup first (my recommendation), or Health recovery?\n\n\
             A – Improve existing backup: 1-2 weeks.\n\n\
             B - Health recovery: 2-3 weeks.\n\n\
             C — CloudKit: 4-8 weeks if permitted.\n\n\
             Nothing is built without your choice.",
            None,
        );

        let split = split(&doc).unwrap();
        assert_eq!(markers(&split), ["A", "B", "C"]);
        assert_eq!(
            split.choices[0].text,
            "Improve existing backup: 1-2 weeks."
        );
        assert_eq!(split.before.nodes.len(), 1);
        assert_eq!(split.after.nodes.len(), 1);
    }

    #[test]
    fn numbered_questions_inline_in_one_paragraph() {
        let doc = parse(
            "Crew-role enforcement, two choices for you. 1) Should crews get no \
             credentials? I recommend yes. 2) Should crews be allowed gh \
             commands (pr view), or none?",
            None,
        );

        let split = split(&doc).unwrap();
        assert_eq!(markers(&split), ["1", "2"]);
        assert!(
            split.choices[1]
                .text
                .starts_with("Should crews be allowed gh")
        );
        assert_eq!(
            split.before.plain_text(),
            "Crew-role enforcement, two choices for you."
        );
    }

    #[test]
    fn steps_and_stray_letters_are_not_choices() {
        // A numbered list in a message that asks nothing is a list of steps.
        assert!(
            split(&parse("Done:\n\n1. built\n2. deployed\n", None)).is_none()
        );
        // One lettered line, or letters out of order, are not a choice.
        assert!(
            split(&parse("A new build is up.\n\nB. nothing\n", None)).is_none()
        );
        assert!(split(&parse("Pick?\n\nA) one\n\nC) three\n", None)).is_none());
        // A numbered list in a message that asks is.
        let asked =
            split(&parse("Which first?\n\n1. billing\n2. search\n", None));
        assert_eq!(markers(&asked.unwrap()), ["1", "2"]);
    }

    #[test]
    fn the_reply_names_what_was_ticked() {
        let choice = |m: &str| Choice {
            marker: m.into(),
            text: String::new(),
        };
        let (a, b, c) = (choice("A"), choice("B"), choice("C"));
        assert_eq!(reply(&[&a], ""), Some("A".into()));
        assert_eq!(
            reply(&[&a, &c], " start Monday "),
            Some("A and C — start Monday".into())
        );
        assert_eq!(reply(&[&a, &b, &c], ""), Some("A, B and C".into()));
        assert_eq!(reply(&[], "  "), None);
    }
}
