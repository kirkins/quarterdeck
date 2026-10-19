//! What blocks the fleet or waits on an approval, as Privateer's
//! `runtime.needs` returns it. Blockers (jobs, schedules and workspaces that
//! are stuck) and production approvals are not always captain mail, so they
//! come from here; mail asks are also in `captain.waiting`, which wins where
//! both list the same ask. Every field is optional and unknown fields are
//! ignored, so a newer Privateer does not break Quarterdeck.

use serde::Deserialize;
use serde_json::{Value, json};

use crate::captain::{Item, Mail, Waiting};
use crate::triage;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Needs {
    /// False when Privateer could not observe the fleet; `reason` says why.
    pub available: bool,
    pub reason: Option<String>,
    pub items: Vec<Need>,
    /// The cursor for the next page, when there is one.
    pub next_after: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Need {
    pub id: String,
    /// `mail`, `job`, `schedule` or `workspace`.
    pub source: String,
    /// `decision`, `approval` or `blocker`.
    pub kind: String,
    pub ship: String,
    pub task_id: Option<String>,
    /// For mail, the ask's own id; the mail's kind is in `mail_kind`.
    pub mail_id: Option<String>,
    pub correlation: Option<String>,
    pub mail_kind: Option<String>,
    pub question: Option<String>,
    pub choices: Vec<String>,
    pub artifact: Option<String>,
    pub environment: Option<String>,
    pub evidence: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub urgency: Option<String>,
    pub deadline_ms: Option<i64>,
    pub created_ms: Option<i64>,
    pub asked_ms: Option<i64>,
    pub needs_hands: bool,
    pub actions: Vec<String>,
}

/// What a blocker's evidence means, when Privateer gives no summary.
const BLOCKER_SUMMARY: &[(&str, &str)] = &[
    (
        "orphaned_job",
        "A job lost its worker. Recover or cancel it in Privateer.",
    ),
    ("capacity_wait", "A job is waiting for capacity."),
    (
        "stuck_heavy_capacity",
        "A heavy job is stuck behind capacity no live process holds.",
    ),
    ("disk_floor_wait", "A job is waiting for disk space."),
    ("scheduling_fault", "A scheduled task is in a fault state."),
    (
        "workspace_disk_wait",
        "A workspace is waiting for disk space.",
    ),
];

impl Needs {
    pub fn parse(value: Value) -> Result<Self, String> {
        serde_json::from_value(value).map_err(|error| error.to_string())
    }

    /// What to show when the read itself failed.
    pub fn unreadable(reason: String) -> Self {
        Self {
            reason: Some(reason),
            ..Self::default()
        }
    }
}

impl Need {
    /// This need as a Triage item, or None when it has no id to key it by.
    /// Mail asks keep their mail kind, so a request reads as a request. An
    /// approval is a request with the production approval kind, which is
    /// how Triage knows to show it read-only.
    pub fn item(&self, now_ms: i64) -> Option<Item> {
        let created = self.created_ms.unwrap_or(now_ms);
        let asked = self.asked_ms.unwrap_or(created);
        let (id, kind, request_kind, payload, body) = match self.source.as_str()
        {
            "mail" => {
                let id = self
                    .mail_id
                    .clone()
                    .or_else(|| self.correlation.clone())?;
                let approval = self.kind == "approval";
                let kind = match self.mail_kind.as_deref() {
                    Some(kind @ ("request" | "decision")) => kind,
                    _ if approval => "approval",
                    _ => "decision",
                };
                let payload = if approval {
                    json!({"artifact": self.artifact, "environment": self.environment})
                } else if kind == "decision" {
                    json!({"choices": self.choices})
                } else {
                    json!({})
                };
                let request_kind =
                    approval.then(|| "production_approval".to_owned());
                (
                    id,
                    kind.to_owned(),
                    request_kind,
                    payload,
                    self.question.clone(),
                )
            }
            "job" | "schedule" | "workspace" => {
                let evidence = self.evidence.clone().unwrap_or_default();
                let summary = self.summary.clone().or_else(|| {
                    BLOCKER_SUMMARY
                        .iter()
                        .find(|(key, _)| *key == evidence)
                        .map(|(_, text)| text.to_string())
                });
                let payload = json!({
                    "evidence": evidence,
                    "status": self.status,
                    "task_id": self.task_id,
                });
                (
                    self.id.clone(),
                    "blocker".to_owned(),
                    None,
                    payload,
                    Some(summary.unwrap_or_else(|| "Blocked.".into())),
                )
            }
            _ => return None,
        };
        if id.is_empty() {
            return None;
        }
        // A need that wants hands but names no step gets a line that says so.
        let step = self
            .needs_hands
            .then(|| "Needs your hands; see the message.".to_owned());
        Some(Item {
            ship: self.ship.clone(),
            asked_ms: asked,
            age_ms: (now_ms - asked).max(0),
            step,
            attached: 0,
            mail: Mail {
                id,
                from: self.ship.clone(),
                kind,
                request_kind,
                task_id: self.task_id.clone(),
                urgency: self.urgency.clone(),
                deadline_ms: self.deadline_ms,
                created_ms: created,
                body: body.unwrap_or_default(),
                payload,
            },
        })
    }
}

/// Add the needs that `waiting` does not already hold. Where both list an
/// ask, `captain.waiting`'s record wins: it has the kind, payload, urgency
/// and deadline. Asks are keyed by sender and id, as Triage keys them.
pub fn merge(waiting: &mut Waiting, needs: &Needs, now_ms: i64) {
    if !needs.available {
        return;
    }
    let mut known: std::collections::HashSet<String> =
        waiting.waiting.iter().map(triage::key).collect();
    for item in needs.items.iter().filter_map(|need| need.item(now_ms)) {
        if known.insert(triage::key(&item)) {
            waiting.waiting.push(item);
        }
    }
    waiting.waiting.sort_by_key(|item| item.asked_ms);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Value {
        serde_json::from_str(include_str!("../../fixtures/runtime.needs.json"))
            .unwrap()
    }

    fn waiting() -> Waiting {
        Waiting::parse(
            serde_json::from_str(include_str!(
                "../../fixtures/captain.waiting.json"
            ))
            .unwrap(),
        )
        .unwrap()
    }

    fn need(value: Value) -> Need {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn reads_the_fixture_and_tolerates_missing_and_extra_fields() {
        let needs = Needs::parse(fixture()).unwrap();
        assert!(needs.available);
        assert_eq!(needs.items.len(), 7);
        assert_eq!(needs.next_after, None);

        let sparse = Needs::parse(json!({
            "available": true,
            "items": [{"id": "x", "source": "job", "kind": "blocker", "extra": 1}],
            "something_new": true
        }))
        .unwrap();
        assert_eq!(sparse.items[0].ship, "");
        assert!(!sparse.items[0].needs_hands);

        let unavailable =
            Needs::parse(json!({"available": false, "reason": "locked"}))
                .unwrap();
        assert!(!unavailable.available);
        assert_eq!(unavailable.reason.as_deref(), Some("locked"));
    }

    #[test]
    fn every_blocker_kind_reads_as_a_read_only_blocker() {
        let now = 1_792_300_000_000;
        for (evidence, summary) in [
            (
                "orphaned_job",
                "A job lost its worker. Recover or cancel it in Privateer.",
            ),
            ("capacity_wait", "A job is waiting for capacity."),
            (
                "stuck_heavy_capacity",
                "A heavy job is stuck behind capacity no live process holds.",
            ),
            ("disk_floor_wait", "A job is waiting for disk space."),
            ("scheduling_fault", "A scheduled task is in a fault state."),
            (
                "workspace_disk_wait",
                "A workspace is waiting for disk space.",
            ),
        ] {
            let item = need(
                json!({"id": "h:job:j1", "source": "job", "kind": "blocker",
                "ship": "search", "evidence": evidence, "status": "queued"}),
            )
            .item(now)
            .unwrap();
            assert_eq!(item.mail.kind, "blocker", "{evidence}");
            assert_eq!(item.mail.body, summary, "{evidence}");
            assert!(triage::is_read_only(&item), "{evidence}");
            assert_eq!(triage::key(&item), "search/h:job:j1");
        }

        let explicit = need(json!({"id": "h:job:j2", "source": "job", "kind": "blocker",
            "evidence": "capacity_wait", "summary": "Waiting on the GPU host."}))
            .item(now)
            .unwrap();
        assert_eq!(explicit.mail.body, "Waiting on the GPU host.");
    }

    #[test]
    fn approvals_are_read_only_and_carry_what_is_granted() {
        let now = 1_792_300_000_000;
        let approval = need(json!({"id": "h:mail:f14", "source": "mail", "kind": "approval",
            "ship": "billing", "mail_id": "f14", "mail_kind": "request",
            "question": "Deploy?", "artifact": "api 1.2", "environment": "production-eu"}))
            .item(now)
            .unwrap();
        assert!(triage::is_read_only(&approval));
        assert_eq!(approval.mail.payload["artifact"], "api 1.2");
        assert_eq!(approval.mail.payload["environment"], "production-eu");
    }

    #[test]
    fn a_mail_need_keeps_its_mail_kind_and_choices() {
        let now = 1_792_300_000_000;
        let decision = need(
            json!({"id": "h:mail:f1", "source": "mail", "kind": "decision",
            "ship": "billing", "mail_id": "f1", "mail_kind": "decision",
            "choices": ["A", "B"], "needs_hands": true, "asked_ms": 5}),
        )
        .item(now)
        .unwrap();
        assert_eq!(decision.mail.kind, "decision");
        assert_eq!(decision.mail.payload["choices"], json!(["A", "B"]));
        assert_eq!(
            decision.step.as_deref(),
            Some("Needs your hands; see the message.")
        );
        assert!(!triage::is_read_only(&decision));
        assert_eq!(decision.asked_ms, 5);

        let request = need(
            json!({"id": "h:mail:f2", "source": "mail", "kind": "decision",
            "ship": "ops", "mail_id": "f2", "mail_kind": "request"}),
        )
        .item(now)
        .unwrap();
        assert_eq!(request.mail.kind, "request");
    }

    #[test]
    fn captain_waiting_wins_where_both_list_the_same_ask() {
        let now = 1_792_300_000_000;
        let mut merged = waiting();
        let before = merged.waiting.len();
        let needs = Needs::parse(fixture()).unwrap();
        merge(&mut merged, &needs, now);

        // Only the approval and the blockers are new; the billing ask is
        // the one captain.waiting lists, with its own urgency.
        let billing: Vec<&Item> = merged
            .waiting
            .iter()
            .filter(|item| item.mail.id == "f0001-billing-retry")
            .collect();
        assert_eq!(billing.len(), 1);
        assert_eq!(billing[0].mail.urgency.as_deref(), Some("high"));
        assert_eq!(billing[0].mail.kind, "decision");
        assert!(merged.waiting.len() > before);
        assert!(merged.waiting.iter().any(triage::is_read_only));

        let mut sorted = merged
            .waiting
            .iter()
            .map(|item| item.asked_ms)
            .collect::<Vec<_>>();
        let order = sorted.clone();
        sorted.sort();
        assert_eq!(order, sorted);
    }

    #[test]
    fn an_unavailable_answer_leaves_captain_waiting_alone() {
        let mut merged = waiting();
        let before = merged.clone();
        let needs =
            Needs::unreadable("Runtime observation unavailable.".into());
        merge(&mut merged, &needs, 0);
        assert_eq!(merged, before);
    }
}
