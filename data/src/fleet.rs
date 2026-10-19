//! The fleet, as Privateer's `fleet.snapshot` returns it: every machine, the
//! ships on it, their live crew, and what needs the captain. Every field is
//! optional and unknown fields are ignored, so a missing value reads as
//! none, zero or empty.
//!
//! Each machine's `changed_ms` goes back as `since`; Privateer compares it
//! for equality and answers an unchanged machine with `unchanged: true` and
//! no ships, so the ships held for it stand. Needs always come back in
//! full. When an unchanged machine has nothing held, the read is made again
//! in full.

use std::collections::HashMap;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
use serde_json::Value;

/// The fleet as last read, with each machine's ships under it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub generated_ms: Option<i64>,
    pub machines: Vec<Machine>,
    pub needs: Vec<Need>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Machine {
    pub name: String,
    /// `here`, `reaches` or `reached_by`: how it relates to this machine.
    pub link: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub reachable: bool,
    pub error: Option<String>,
    pub via: Option<String>,
    /// When the machine was last read; an unreachable one is shown as of
    /// then.
    pub as_of_ms: Option<i64>,
    /// When its section last changed: the `since` token.
    pub changed_ms: Option<i64>,
    /// This read left out its ships: they have not changed.
    #[serde(deserialize_with = "lenient")]
    pub unchanged: bool,
    /// Some ships, tasks or jobs were dropped to fit: the read is partial.
    #[serde(deserialize_with = "lenient")]
    pub truncated: bool,
    /// The captain's desk, which collects captain mail.
    #[serde(deserialize_with = "lenient")]
    pub desk: bool,
    /// None when Privateer could not read whether it is stowed.
    #[serde(deserialize_with = "lenient")]
    pub stowed: Option<bool>,
    /// What Privateer could not check.
    #[serde(deserialize_with = "lenient")]
    pub unknown: Vec<String>,
    #[serde(skip)]
    pub ships: Vec<Ship>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Ship {
    pub name: String,
    pub machine: Option<String>,
    /// Whether its first mate runs in a terminal host, so has a session.
    #[serde(deserialize_with = "lenient")]
    pub hosted: bool,
    /// The first mate's harness, such as `claude` or `pi`.
    #[serde(deserialize_with = "lenient")]
    pub harness: Option<String>,
    /// Mail the ship has not read yet.
    #[serde(deserialize_with = "lenient")]
    pub unread: u64,
    /// Requests the ship has open with others.
    #[serde(deserialize_with = "lenient")]
    pub open_requests: u64,
    #[serde(deserialize_with = "lenient")]
    pub presence: Presence,
    pub presence_since_ms: Option<i64>,
    #[serde(deserialize_with = "lenient")]
    pub open_tasks: Vec<Task>,
    /// Open tasks in all; `open_tasks` holds at most 20.
    #[serde(deserialize_with = "lenient")]
    pub open_tasks_total: u64,
    /// Live crew and commands, newest first, at most 20.
    #[serde(deserialize_with = "lenient")]
    pub jobs: Vec<Job>,
    #[serde(deserialize_with = "lenient")]
    pub jobs_total: u64,
}

/// Whether a ship is there. Anything Privateer adds later reads as unknown.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    Hosted,
    Asleep,
    Session,
    Absent,
    Unavailable,
    #[default]
    #[serde(other)]
    Unknown,
}

impl Presence {
    /// There and able to work.
    pub fn is_awake(self) -> bool {
        matches!(self, Presence::Hosted | Presence::Session)
    }

    /// Not an all-clear: Privateer does not know, or could not read the
    /// ship's home.
    pub fn is_unsure(self) -> bool {
        matches!(self, Presence::Unknown | Presence::Unavailable)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Presence::Hosted => "hosted",
            Presence::Asleep => "asleep",
            Presence::Session => "session",
            Presence::Absent => "absent",
            Presence::Unavailable => "unavailable",
            Presence::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Task {
    pub id: String,
    pub title: Option<String>,
    pub status: Option<String>,
}

/// A live job: `starting`, `queued`, `launching`, `running`, `parked` or
/// `orphaned`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Job {
    pub id: String,
    pub task_id: Option<String>,
    pub task_title: Option<String>,
    /// `crew`, `first_mate`, `errand` or `command`.
    pub kind: Option<String>,
    pub state: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub heavy: bool,
    pub created_ms: Option<i64>,
    pub spawned_ms: Option<i64>,
    pub started_ms: Option<i64>,
    /// The last progress report, or the next step of a park.
    #[serde(deserialize_with = "lenient")]
    pub doing: Option<Doing>,
    #[serde(deserialize_with = "lenient")]
    pub wait: Option<Wait>,
    /// `live` for a hosted crew's own session, `viewer` for the view of a
    /// headless one; none when it has no session to watch.
    #[serde(deserialize_with = "lenient")]
    pub session: Option<String>,
}

impl Job {
    /// Starting, launching or running. Queued and parked wait; orphaned is
    /// a problem.
    pub fn is_running(&self) -> bool {
        matches!(
            self.state.as_deref(),
            Some("starting" | "launching" | "running")
        )
    }

    pub fn is_waiting(&self) -> bool {
        matches!(self.state.as_deref(), Some("queued" | "parked"))
    }

    pub fn is_orphaned(&self) -> bool {
        self.state.as_deref() == Some("orphaned")
    }

    /// When it began, as best known: started, spawned or created.
    pub fn began_ms(&self) -> Option<i64> {
        self.started_ms.or(self.spawned_ms).or(self.created_ms)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Doing {
    pub text: String,
    pub at_ms: Option<i64>,
}

/// Why a job is not moving.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Wait {
    /// `capacity`, `disk`, or `job` for a parked crew.
    #[serde(rename = "for")]
    pub on: Option<String>,
    pub since_ms: Option<i64>,
    pub job_id: Option<String>,
    /// How many times the crew has parked, as `park 1 of 8`.
    pub park: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub behind: Vec<Behind>,
}

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Behind {
    pub job_id: Option<String>,
    pub ship: Option<String>,
    #[serde(deserialize_with = "lenient")]
    pub unhealthy: bool,
}

/// Something that needs the captain, with the machine it came from.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Need {
    pub id: String,
    pub ship: String,
    pub machine: Option<String>,
    pub kind: Option<String>,
    pub question: Option<String>,
    pub mail_id: Option<String>,
    /// Set when it is cached from an unreachable machine.
    pub as_of_ms: Option<i64>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct Wire {
    generated_ms: Option<i64>,
    machines: Option<Vec<Value>>,
    ships: Vec<Value>,
    needs: Vec<Value>,
}

/// The `since` argument: each machine's `changed_ms`.
pub type Since = HashMap<String, i64>;

impl Snapshot {
    /// A ship by name, with the machine it is on.
    pub fn ship(&self, name: &str) -> Option<(&Machine, &Ship)> {
        self.machines.iter().find_map(|machine| {
            machine
                .ships
                .iter()
                .find(|ship| ship.name == name)
                .map(|ship| (machine, ship))
        })
    }

    /// Read a snapshot. Entries without a name, or that cannot be read, are
    /// left out; an answer with no machines list is refused.
    pub fn parse(value: Value) -> Result<Self, String> {
        let wire: Wire =
            serde_json::from_value(value).map_err(|error| error.to_string())?;
        let machines = wire.machines.ok_or("no machines in the answer")?;
        let mut ships: Vec<Ship> =
            entries(wire.ships, |s: &Ship| !s.name.is_empty());
        let machines = entries(machines, |m: &Machine| !m.name.is_empty())
            .into_iter()
            .map(|mut machine: Machine| {
                let (here, rest): (Vec<Ship>, Vec<Ship>) =
                    ships.drain(..).partition(|ship| {
                        ship.machine.as_deref() == Some(machine.name.as_str())
                    });
                machine.ships = here;
                ships = rest;
                machine
            })
            .collect();
        Ok(Self {
            generated_ms: wire.generated_ms,
            machines,
            needs: entries(wire.needs, |n: &Need| !n.id.is_empty()),
        })
    }

    /// The token for the next read, or none when no machine has a change
    /// time to send.
    pub fn since(&self) -> Option<Since> {
        let since: Since = self
            .machines
            .iter()
            .filter_map(|m| Some((m.name.clone(), m.changed_ms?)))
            .collect();
        (!since.is_empty()).then_some(since)
    }

    /// Join a read onto the snapshot held before it. An unchanged machine
    /// keeps its held ships, and a truncated machine read with no ships
    /// keeps them too. None when an unchanged machine has nothing held:
    /// then read in full.
    pub fn merge(held: Option<&Snapshot>, mut next: Snapshot) -> Option<Self> {
        for machine in &mut next.machines {
            let before = held.and_then(|held| {
                held.machines.iter().find(|m| m.name == machine.name)
            });
            if machine.unchanged {
                machine.ships = before?.ships.clone();
            } else if machine.truncated
                && machine.ships.is_empty()
                && let Some(before) = before
            {
                machine.ships = before.ships.clone();
            }
        }
        Some(next)
    }
}

/// Read each entry on its own, so one bad entry does not lose the rest;
/// keep those that are named.
fn entries<T: DeserializeOwned>(
    values: Vec<Value>,
    named: impl Fn(&T) -> bool,
) -> Vec<T> {
    values
        .into_iter()
        .filter_map(|value| serde_json::from_value::<T>(value).ok())
        .filter(named)
        .collect()
}

/// A value of the wrong type, or null, reads as the default.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let value = Value::deserialize(deserializer)?;
    Ok(serde_json::from_value(value).unwrap_or_default())
}

/// The fleet counted and sorted for drawing.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Board {
    pub summary: Summary,
    pub machines: Vec<MachineRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Summary {
    pub machines_reachable: usize,
    pub machines_total: usize,
    pub ships_awake: usize,
    /// Ships on reachable machines whose presence is unknown or
    /// unavailable.
    pub ships_unsure: usize,
    pub crew_running: usize,
    pub crew_waiting: usize,
    pub crew_orphaned: usize,
    /// Everything that needs the captain, cached ones included.
    pub needs: usize,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MachineRow {
    /// The machine's place in the snapshot.
    pub index: usize,
    pub needs: usize,
    pub running: usize,
    pub ships: Vec<ShipRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ShipRow {
    /// The ship's place in its machine.
    pub index: usize,
    /// Needs naming this ship: counted even when its machine is
    /// unreachable.
    pub needs: usize,
    /// Live counts: zero on an unreachable machine, whose crew is as last
    /// known.
    pub running: usize,
    pub waiting: usize,
    pub orphaned: usize,
    pub awake: bool,
    pub unsure: bool,
}

impl ShipRow {
    /// Needs or a problem first, then crew running, then waiting, then
    /// awake, then unsure, then asleep, then the rest.
    fn rank(&self, presence: Presence) -> u8 {
        if self.needs > 0 || self.orphaned > 0 {
            0
        } else if self.running > 0 {
            1
        } else if self.waiting > 0 {
            2
        } else if self.awake {
            3
        } else if self.unsure {
            4
        } else if presence == Presence::Asleep {
            5
        } else {
            6
        }
    }
}

impl Board {
    pub fn build(snapshot: &Snapshot) -> Self {
        let mut summary = Summary {
            machines_total: snapshot.machines.len(),
            needs: snapshot.needs.len(),
            ..Summary::default()
        };
        let mut machines: Vec<(u8, MachineRow)> = snapshot
            .machines
            .iter()
            .enumerate()
            .map(|(index, machine)| {
                let live = machine.reachable;
                let mut ships: Vec<(u8, ShipRow)> = machine
                    .ships
                    .iter()
                    .enumerate()
                    .map(|(index, ship)| {
                        let count = |test: fn(&Job) -> bool| {
                            if live {
                                ship.jobs.iter().filter(|j| test(j)).count()
                            } else {
                                0
                            }
                        };
                        let row = ShipRow {
                            index,
                            needs: snapshot
                                .needs
                                .iter()
                                .filter(|need| {
                                    need.ship == ship.name
                                        && need
                                            .machine
                                            .as_ref()
                                            .is_none_or(|m| *m == machine.name)
                                })
                                .count(),
                            running: count(Job::is_running),
                            waiting: count(Job::is_waiting),
                            orphaned: count(Job::is_orphaned),
                            awake: live && ship.presence.is_awake(),
                            unsure: live && ship.presence.is_unsure(),
                        };
                        (row.rank(ship.presence), row)
                    })
                    .collect();
                ships.sort_by(|(a_rank, a), (b_rank, b)| {
                    a_rank.cmp(b_rank).then_with(|| {
                        machine.ships[a.index]
                            .name
                            .cmp(&machine.ships[b.index].name)
                    })
                });
                let ships: Vec<ShipRow> =
                    ships.into_iter().map(|(_, row)| row).collect();

                if live {
                    summary.machines_reachable += 1;
                }
                summary.ships_awake += ships.iter().filter(|s| s.awake).count();
                summary.ships_unsure +=
                    ships.iter().filter(|s| s.unsure).count();
                let running = ships.iter().map(|s| s.running).sum();
                let orphaned: usize = ships.iter().map(|s| s.orphaned).sum();
                summary.crew_running += running;
                summary.crew_waiting +=
                    ships.iter().map(|s| s.waiting).sum::<usize>();
                summary.crew_orphaned += orphaned;
                let needs = ships.iter().map(|s| s.needs).sum();

                let rank = if !live {
                    2
                } else if needs > 0 || running > 0 || orphaned > 0 {
                    0
                } else {
                    1
                };
                (
                    rank,
                    MachineRow {
                        index,
                        needs,
                        running,
                        ships,
                    },
                )
            })
            .collect();
        machines.sort_by(|(a_rank, a), (b_rank, b)| {
            a_rank.cmp(b_rank).then_with(|| {
                snapshot.machines[a.index]
                    .name
                    .cmp(&snapshot.machines[b.index].name)
            })
        });
        Self {
            summary,
            machines: machines.into_iter().map(|(_, row)| row).collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn fixture() -> Snapshot {
        let value: Value = serde_json::from_str(include_str!(
            "../../fixtures/fleet.snapshot.json"
        ))
        .unwrap();
        Snapshot::parse(value).unwrap()
    }

    fn names(snapshot: &Snapshot, row: &MachineRow) -> Vec<String> {
        let machine = &snapshot.machines[row.index];
        row.ships
            .iter()
            .map(|s| machine.ships[s.index].name.clone())
            .collect()
    }

    #[test]
    fn reads_the_fixture_with_each_ship_under_its_machine() {
        let snapshot = fixture();
        let names: Vec<_> =
            snapshot.machines.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, ["atlas", "boreas", "calypso"]);
        let atlas = &snapshot.machines[0];
        assert!(atlas.desk && atlas.reachable);
        assert_eq!(atlas.stowed, Some(false));
        assert_eq!(snapshot.machines[2].stowed, None);
        assert_eq!(atlas.ships.len(), 3);
        let billing = &atlas.ships[0];
        assert_eq!(billing.presence, Presence::Hosted);
        let queued = &billing.jobs[0];
        assert_eq!(
            queued.wait.as_ref().unwrap().on.as_deref(),
            Some("capacity")
        );
        assert!(queued.is_waiting() && !queued.is_running());
        // A hosted first mate, and a crew with a session of its own, can be
        // watched live.
        assert!(billing.hosted);
        assert_eq!(queued.session, None);
        assert_eq!(billing.jobs[1].session.as_deref(), Some("live"));
        assert_eq!(snapshot.needs.len(), 3);
    }

    #[test]
    fn tolerates_missing_odd_and_extra_fields() {
        let snapshot = Snapshot::parse(json!({
            "machines": [
                {"name": "here", "reachable": true, "desk": null, "new": 1},
                {"reachable": true}
            ],
            "ships": [
                {"name": "a", "machine": "here", "presence": "drifting",
                 "jobs": [{"id": "j", "state": "orphaned", "wait": "odd",
                           "session": 3}]},
                {"name": "b", "machine": "here", "presence": null},
                {"name": "lost", "machine": "elsewhere"}
            ]
        }))
        .unwrap();
        assert_eq!(snapshot.machines.len(), 1);
        let ships = &snapshot.machines[0].ships;
        assert_eq!(ships.len(), 2);
        assert_eq!(ships[0].presence, Presence::Unknown);
        assert_eq!(ships[1].presence, Presence::Unknown);
        assert!(ships[0].jobs[0].is_orphaned());
        assert_eq!(ships[0].jobs[0].wait, None);
        assert_eq!(ships[0].jobs[0].session, None);

        assert!(Snapshot::parse(json!({"ships": []})).is_err());
    }

    #[test]
    fn an_unchanged_machine_keeps_its_held_ships_or_asks_for_a_full_read() {
        let held = fixture();
        let since = held.since().unwrap();
        assert_eq!(since["atlas"], 1_792_299_996_000);

        let next = Snapshot::parse(json!({
            "machines": [
                {"name": "atlas", "reachable": true, "unchanged": true},
                {"name": "boreas", "reachable": true, "truncated": true},
                {"name": "calypso", "reachable": true,
                 "changed_ms": 5}
            ],
            "ships": [{"name": "fresh", "machine": "calypso"}],
            "needs": []
        }))
        .unwrap();
        let merged = Snapshot::merge(Some(&held), next.clone()).unwrap();
        assert_eq!(merged.machines[0].ships, held.machines[0].ships);
        // Truncated with no ships: the held ones stand, and it says so.
        assert_eq!(merged.machines[1].ships, held.machines[1].ships);
        assert!(merged.machines[1].truncated);
        assert_eq!(merged.machines[2].ships[0].name, "fresh");
        assert!(merged.needs.is_empty());

        assert_eq!(Snapshot::merge(None, next), None);
    }

    #[test]
    fn counts_only_live_crew_and_sorts_what_needs_attention_first() {
        let snapshot = fixture();
        let board = Board::build(&snapshot);
        let summary = &board.summary;
        assert_eq!(
            (summary.machines_reachable, summary.machines_total),
            (2, 3)
        );
        // calypso is unreachable: its hosted ship and running crew are as
        // last known, not counted.
        assert_eq!(summary.ships_awake, 4);
        assert_eq!(summary.ships_unsure, 1);
        assert_eq!(summary.crew_running, 4);
        assert_eq!(summary.crew_waiting, 2);
        assert_eq!(summary.crew_orphaned, 1);
        assert_eq!(summary.needs, 3);

        let order: Vec<_> = board
            .machines
            .iter()
            .map(|m| snapshot.machines[m.index].name.as_str())
            .collect();
        assert_eq!(order, ["atlas", "boreas", "calypso"]);
        assert_eq!(
            names(&snapshot, &board.machines[1]),
            ["analytics", "search-index", "ledger", "previews"]
        );
        assert_eq!(
            names(&snapshot, &board.machines[0]),
            ["billing", "chandlery", "docs-site"]
        );
    }
}
