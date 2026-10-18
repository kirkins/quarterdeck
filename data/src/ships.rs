//! The fleet's ships, as Privateer's `ship.list` returns them: every ship
//! this home knows, here and on linked machines.

use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Ship {
    pub name: String,
    pub scope: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct List {
    ships: Vec<Ship>,
}

/// The ships by name, A to Z.
pub fn parse(value: Value) -> Result<Vec<Ship>, String> {
    let mut ships = serde_json::from_value::<List>(value)
        .map_err(|error| error.to_string())?
        .ships;
    ships.retain(|ship| !ship.name.is_empty());
    ships.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(ships)
}
