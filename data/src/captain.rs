//! What waits on the captain, as Privateer's `captain.waiting` returns it.
//! Every field is optional and unknown fields are ignored, so a newer
//! Privateer that adds to its answer does not break Quarterdeck.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Waiting {
    pub now_ms: i64,
    /// Every open ask, oldest first.
    pub waiting: Vec<Item>,
    /// Asks only the captain's hands can do; each is also in `waiting`.
    pub hands_on: Vec<Item>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Item {
    pub ship: String,
    pub asked_ms: i64,
    pub age_ms: i64,
    /// For a hands-on ask, the exact step the captain must take.
    pub step: Option<String>,
    /// How many later asks were attached to this one.
    pub attached: u64,
    pub mail: Mail,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Mail {
    pub id: String,
    pub from: String,
    /// `request`, `decision` or `notice`.
    pub kind: String,
    pub request_kind: Option<String>,
    pub task_id: Option<String>,
    pub urgency: Option<String>,
    pub deadline_ms: Option<i64>,
    pub created_ms: i64,
    pub body: String,
    pub payload: Value,
}

impl Waiting {
    pub fn parse(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_fixture_and_tolerates_missing_and_extra_fields() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/captain.waiting.json"
        ))
        .unwrap();
        let waiting = Waiting::parse(fixture).unwrap();
        assert_eq!(waiting.waiting.len(), 15);
        let hands = &waiting.hands_on[0];
        assert_eq!(hands.ship, "status-page");
        assert!(hands.step.as_deref().unwrap().contains("two-factor"));
        assert!(
            waiting
                .waiting
                .iter()
                .any(|item| item.mail.id == hands.mail.id)
        );

        let sparse = Waiting::parse(serde_json::json!({
            "waiting": [{"ship": "scout", "mail": {"id": "a1", "new": 1}}],
            "something_new": true
        }))
        .unwrap();
        assert_eq!(sparse.waiting[0].mail.id, "a1");
        assert!(sparse.hands_on.is_empty());
    }
}
