//! Files the captain sends a ship with a message.
//!
//! Privateer mail carries no files, so a file goes the way the Telegram door
//! sends one: copied into Quarterdeck's data directory, with its path in the
//! message for the ship to open. A path is good only on this machine, so a
//! file goes only to a ship that runs here.

use std::path::{Path, PathBuf};

use crate::environment;
use crate::fleet::Snapshot;

/// The largest file sent, as the copy it is kept as.
pub const MAX_BYTES: u64 = 50 * 1024 * 1024;
/// Files on one message.
pub const MAX_FILES: usize = 10;

const NAME_LIMIT: usize = 80;
const IMAGE_EXTENSIONS: &[&str] =
    &["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "heic"];

/// A file picked or dropped, to send with the next message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attachment {
    pub path: PathBuf,
    pub name: String,
    pub bytes: u64,
}

impl Attachment {
    /// The file at `path`, if it is one that can be sent.
    pub fn at(path: &Path) -> Result<Self, String> {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let metadata = std::fs::metadata(path)
            .map_err(|error| format!("{name}: {error}"))?;
        if !metadata.is_file() {
            return Err(format!("{name} is not a file"));
        }
        if metadata.len() > MAX_BYTES {
            return Err(format!(
                "{name} is {}; a file sent is at most {}",
                size(metadata.len()),
                size(MAX_BYTES)
            ));
        }
        Ok(Attachment {
            path: path.to_owned(),
            name,
            bytes: metadata.len(),
        })
    }

    /// Whether a thumbnail can be drawn for it: the raster images the
    /// image decoder reads.
    pub fn thumbnail(&self) -> bool {
        matches!(
            self.extension().as_str(),
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp"
        )
    }

    fn extension(&self) -> String {
        Path::new(&self.name)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    }

    pub fn is_image(&self) -> bool {
        IMAGE_EXTENSIONS.contains(&self.extension().as_str())
    }
}

/// Whether files can go to `ship`: only one that runs on this machine, by
/// the fleet as last read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reach {
    Here,
    /// The fleet is not read yet.
    Unknown,
    /// On another machine, by its name, or not in the fleet.
    Elsewhere(Option<String>),
}

pub fn reach(ship: &str, fleet: Option<&Snapshot>) -> Reach {
    let Some(fleet) = fleet else {
        return Reach::Unknown;
    };
    match fleet.ship(ship) {
        Some((machine, _)) if machine.link.as_deref() == Some("here") => {
            Reach::Here
        }
        Some((machine, _)) => Reach::Elsewhere(Some(machine.name.clone())),
        None => Reach::Elsewhere(None),
    }
}

impl Reach {
    /// Why the files cannot go to `ship`, if they cannot.
    pub fn problem(&self, ship: &str) -> Option<String> {
        match self {
            Reach::Here => None,
            Reach::Unknown => {
                Some(format!("Reading the fleet to check where {ship} runs…"))
            }
            Reach::Elsewhere(Some(machine)) => Some(format!(
                "{ship} runs on {machine}. Files reach only ships on this machine for now."
            )),
            Reach::Elsewhere(None) => Some(format!(
                "{ship} is not in the fleet as last read, so files can't be sent to it."
            )),
        }
    }
}

/// The folder sent files are kept in, in the data directory.
pub fn dir() -> PathBuf {
    environment::data_dir().join("attachments")
}

/// Copy each file into `dir` under a name of its own that starts with
/// `stamp`, returning the copies' paths. A copy made before a failure is
/// removed.
pub fn keep(
    attachments: &[Attachment],
    dir: &Path,
    stamp: &str,
) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let mut kept = Vec::new();
    for attachment in attachments {
        let name = safe_name(&attachment.name);
        let mut dest = dir.join(format!("{stamp}-{name}"));
        let mut n = 1;
        while dest.exists() {
            n += 1;
            dest = dir.join(format!("{stamp}-{n}-{name}"));
        }
        if let Err(error) = std::fs::copy(&attachment.path, &dest) {
            for copy in &kept {
                let _ = std::fs::remove_file(copy);
            }
            return Err(format!("could not copy {}: {error}", attachment.name));
        }
        kept.push(dest);
    }
    Ok(kept)
}

/// The message with the kept files' paths after it, as the door words it.
pub fn body_with(body: &str, kept: &[PathBuf]) -> String {
    let note = match kept {
        [] => return body.to_owned(),
        [one] => format!("The captain sent a file: {}", one.display()),
        many => {
            let mut note = format!("The captain sent {} files:", many.len());
            for path in many {
                note.push_str(&format!("\n- {}", path.display()));
            }
            note
        }
    };
    if body.trim().is_empty() {
        note
    } else {
        format!("{}\n\n{note}", body.trim())
    }
}

/// A flat, plain name that keeps the suffix: nothing climbs out of the folder.
fn safe_name(name: &str) -> String {
    let base = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut safe = String::new();
    for c in base.chars() {
        if c.is_alphanumeric() || matches!(c, '.' | '-' | '_') {
            safe.push(c);
        } else if !safe.ends_with('_') {
            safe.push('_');
        }
    }
    let safe = safe.trim_matches(|c| c == '.' || c == '_').to_owned();
    if safe.is_empty() {
        return "file".into();
    }
    if safe.chars().count() <= NAME_LIMIT {
        return safe;
    }
    let ext = Path::new(&safe)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .filter(|e| e.chars().count() < 12)
        .unwrap_or_default();
    let stem: String = safe
        .chars()
        .take(NAME_LIMIT - ext.chars().count())
        .collect();
    format!("{stem}{ext}")
}

/// A size as people say it.
pub fn size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    match bytes {
        b if b >= MB => format!("{:.1} MB", b as f64 / MB as f64),
        b if b >= KB => format!("{} KB", b / KB),
        b => format!("{b} bytes"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-attach-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_file_is_read_with_its_name_and_size_and_a_folder_is_not() {
        let dir = scratch("at");
        let path = dir.join("Screen Shot.PNG");
        std::fs::write(&path, b"12345").unwrap();

        let file = Attachment::at(&path).unwrap();
        assert_eq!(file.name, "Screen Shot.PNG");
        assert_eq!(file.bytes, 5);
        assert!(file.is_image());
        assert!(Attachment::at(&dir).is_err());
        assert!(Attachment::at(&dir.join("missing")).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn files_go_only_to_a_ship_on_this_machine() {
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

        assert_eq!(reach("billing", Some(&fleet)), Reach::Here);
        assert_eq!(
            reach("status-page", Some(&fleet)),
            Reach::Elsewhere(Some("laptop".into()))
        );
        assert_eq!(reach("ghost", Some(&fleet)), Reach::Elsewhere(None));
        assert_eq!(reach("billing", None), Reach::Unknown);
        assert!(Reach::Here.problem("billing").is_none());
        assert!(
            reach("status-page", Some(&fleet))
                .problem("status-page")
                .unwrap()
                .contains("laptop")
        );
    }

    #[test]
    fn kept_copies_have_safe_names_of_their_own() {
        let dir = scratch("keep");
        let source = dir.join("source");
        std::fs::create_dir_all(&source).unwrap();
        let one = source.join("a b.png");
        std::fs::write(&one, b"one").unwrap();
        let files =
            [Attachment::at(&one).unwrap(), Attachment::at(&one).unwrap()];
        let out = dir.join("kept");

        let kept = keep(&files, &out, "20261019-090500").unwrap();
        let names: Vec<String> = kept
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            ["20261019-090500-a_b.png", "20261019-090500-2-a_b.png"]
        );
        assert_eq!(std::fs::read(&kept[1]).unwrap(), b"one");

        // A file that went missing leaves no copies behind.
        let gone = Attachment {
            path: source.join("gone"),
            name: "gone".into(),
            bytes: 0,
        };
        assert!(
            keep(&[files[0].clone(), gone], &out, "20261019-090600").is_err()
        );
        assert_eq!(std::fs::read_dir(&out).unwrap().count(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_cannot_climb_out_and_long_ones_keep_their_suffix() {
        assert_eq!(safe_name("../../etc/passwd"), "passwd");
        assert_eq!(safe_name("..."), "file");
        assert_eq!(
            safe_name("ünïcode report (final).pdf"),
            "ünïcode_report_final_.pdf"
        );
        let long = safe_name(&format!("{}.jpeg", "x".repeat(200)));
        assert_eq!(long.chars().count(), NAME_LIMIT);
        assert!(long.ends_with(".jpeg"));
    }

    #[test]
    fn the_message_names_the_files_as_the_door_does() {
        let one = [PathBuf::from("/k/a.png")];
        let two = [PathBuf::from("/k/a.png"), PathBuf::from("/k/b.log")];
        assert_eq!(body_with("Look", &[]), "Look");
        assert_eq!(body_with("", &one), "The captain sent a file: /k/a.png");
        assert_eq!(
            body_with(" Look at this ", &one),
            "Look at this\n\nThe captain sent a file: /k/a.png"
        );
        assert_eq!(
            body_with("", &two),
            "The captain sent 2 files:\n- /k/a.png\n- /k/b.log"
        );
        assert_eq!(size(5), "5 bytes");
        assert_eq!(size(2048), "2 KB");
        assert_eq!(size(MAX_BYTES), "50.0 MB");
    }
}
