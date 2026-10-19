//! Where the captain last read in the Feed, kept per Feed in the data
//! directory beside the saved layout. The mark is the time of the newest
//! message seen while the Feed was at its bottom; the Unread divider sits
//! above the first message newer than it, and the "N new messages" pill
//! counts the messages newer than the newest seen before the captain
//! scrolled up.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::environment;
use crate::feed::Scope;

/// The file that holds every Feed's mark.
const FILE_NAME: &str = "feed-read.json";

pub fn path() -> PathBuf {
    environment::data_dir().join(FILE_NAME)
}

/// The key a Feed's mark is kept under: every ship's, or one ship's, with
/// its ship-to-ship mail when that is shown.
pub fn key(scope: &Scope) -> String {
    let base = match &scope.ship {
        Some(ship) => format!("ship:{ship}"),
        None => "all".to_owned(),
    };
    if scope.ship_mail {
        format!("{base}+mail")
    } else {
        base
    }
}

/// The mark kept for a Feed, or None when it has none yet. A missing or
/// unreadable file holds none.
pub fn load(path: &Path, key: &str) -> Option<i64> {
    read(path).remove(key)
}

/// Keep `at` as the mark of a Feed.
pub fn save(path: &Path, key: &str, at: i64) -> Result<(), String> {
    let mut all = read(path);
    all.insert(key.to_owned(), at);
    let bytes = serde_json::to_vec_pretty(&all).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

fn read(path: &Path) -> BTreeMap<String, i64> {
    let Ok(bytes) = std::fs::read(path) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&bytes).unwrap_or_else(|error| {
        log::warn!("ignoring feed marks {}: {error}", path.display());
        BTreeMap::new()
    })
}

/// Where the Unread divider goes: above the first message in drawing order
/// newer than the mark. None when nothing is newer, or no mark is set.
pub fn divider(created: &[i64], mark: Option<i64>) -> Option<usize> {
    let mark = mark?;
    created.iter().position(|&at| at > mark)
}

/// How many messages are newer than the mark: the pill's count.
pub fn newer(created: impl IntoIterator<Item = i64>, mark: i64) -> usize {
    created.into_iter().filter(|&at| at > mark).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope(ship: Option<&str>, ship_mail: bool) -> Scope {
        Scope {
            ship: ship.map(str::to_owned),
            ship_mail,
        }
    }

    #[test]
    fn keys_tell_the_feeds_apart() {
        assert_eq!(key(&scope(None, false)), "all");
        assert_eq!(key(&scope(None, true)), "all+mail");
        assert_eq!(key(&scope(Some("sea"), false)), "ship:sea");
        assert_eq!(key(&scope(Some("sea"), true)), "ship:sea+mail");
    }

    #[test]
    fn a_saved_mark_loads_back_per_feed() {
        let dir = std::env::temp_dir()
            .join(format!("qd-feed-mark-{}", std::process::id()));
        let file = dir.join(FILE_NAME);
        assert_eq!(load(&file, "all"), None);

        save(&file, "all", 500).unwrap();
        save(&file, "ship:sea", 900).unwrap();
        save(&file, "all", 700).unwrap();

        assert_eq!(load(&file, "all"), Some(700));
        assert_eq!(load(&file, "ship:sea"), Some(900));
        assert_eq!(load(&file, "all+mail"), None);

        std::fs::write(&file, b"not json").unwrap();
        assert_eq!(load(&file, "all"), None);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_divider_sits_above_the_first_newer_message() {
        let created = [10, 20, 30, 40];
        assert_eq!(divider(&created, Some(20)), Some(2));
        assert_eq!(divider(&created, Some(5)), Some(0));
        // Nothing newer than the mark: no divider.
        assert_eq!(divider(&created, Some(40)), None);
        // No mark yet: no divider.
        assert_eq!(divider(&created, None), None);
        assert_eq!(divider(&[], Some(0)), None);
    }

    #[test]
    fn the_pill_counts_only_what_is_newer() {
        let created = [10, 20, 30, 40];
        assert_eq!(newer(created, 20), 2);
        assert_eq!(newer(created, 40), 0);
        assert_eq!(newer(created, 0), 4);
        assert_eq!(newer([], 0), 0);
    }
}
