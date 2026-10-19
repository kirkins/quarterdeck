//! Which live session the captain watches: a ship's first mate, or one of
//! its crew by job, as `session.read` and `session.send` take them.

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    pub ship: String,
    /// A crew's job; none for the first mate.
    pub job: Option<String>,
}

impl Target {
    pub fn first_mate(ship: impl Into<String>) -> Self {
        Target {
            ship: ship.into(),
            job: None,
        }
    }

    pub fn crew(ship: impl Into<String>, job: impl Into<String>) -> Self {
        Target {
            ship: ship.into(),
            job: Some(job.into()),
        }
    }

    /// `{ship}` or `{ship, job}`, to which a command adds its own.
    pub fn args(&self) -> Value {
        match &self.job {
            Some(job) => json!({"ship": self.ship, "job": job}),
            None => json!({"ship": self.ship}),
        }
    }
}
