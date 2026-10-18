use std::path::{Path, PathBuf};

use iced_core::font;
use serde::{Deserialize, Deserializer};
use thiserror::Error;

use crate::appearance::theme::Styles;
use crate::appearance::{self, Appearance};
use crate::{Theme, environment};

const DEFAULT_THEME_NAME: &str = "ferra";

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub appearance: Appearance,
    pub font: Font,
    pub scale_factor: ScaleFactor,
    pub sidebar: Sidebar,
    pub privateer: Privateer,
}

/// How Quarterdeck reaches Privateer.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
pub struct Privateer {
    pub source: Source,
    /// The privateer binary: a path, or a name found on `PATH`.
    pub bin: PathBuf,
    /// The Privateer home the captain's commands run in, such as a ship's
    /// `.privateer` folder. `~` is the home directory.
    pub home: Option<PathBuf>,
    /// How often to ask Privateer what is waiting, in seconds.
    pub poll_seconds: u64,
}

impl Default for Privateer {
    fn default() -> Self {
        Self {
            source: Source::Cli,
            bin: PathBuf::from("privateer"),
            home: None,
            poll_seconds: 15,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Source {
    /// Run the privateer binary.
    #[default]
    Cli,
    /// Invented data bundled with Quarterdeck, for development.
    Fixtures,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Font {
    pub family: Option<String>,
    pub size: Option<u8>,
    pub line_height: Option<f32>,
    #[serde(deserialize_with = "deserialize_weight")]
    pub weight: font::Weight,
    #[serde(deserialize_with = "deserialize_optional_weight")]
    pub bold_weight: Option<font::Weight>,
}

impl Default for Font {
    fn default() -> Self {
        Self {
            family: None,
            size: None,
            line_height: None,
            weight: font::Weight::Normal,
            bold_weight: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(from = "f32")]
pub struct ScaleFactor(f32);

impl Default for ScaleFactor {
    fn default() -> Self {
        Self(1.0)
    }
}

impl From<f32> for ScaleFactor {
    fn from(value: f32) -> Self {
        ScaleFactor(value.clamp(0.1, 3.0))
    }
}

impl From<ScaleFactor> for f32 {
    fn from(value: ScaleFactor) -> Self {
        value.0
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(default)]
pub struct Sidebar {
    pub position: Position,
    pub width: u16,
}

impl Default for Sidebar {
    fn default() -> Self {
        Self {
            position: Position::Left,
            width: 220,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Position {
    #[default]
    Left,
    Right,
}

/// `theme = "name"`, or `theme = { light = "a", dark = "b" }` to follow the
/// system's light or dark preference.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum ThemeKeys {
    Static(String),
    Dynamic { light: String, dark: String },
}

impl Default for ThemeKeys {
    fn default() -> Self {
        Self::Static(DEFAULT_THEME_NAME.to_string())
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct File {
    theme: ThemeKeys,
    font: Font,
    scale_factor: ScaleFactor,
    sidebar: Sidebar,
    privateer: Privateer,
}

impl Config {
    pub fn config_dir() -> PathBuf {
        environment::config_dir()
    }

    pub fn path() -> PathBuf {
        Self::config_dir().join(environment::CONFIG_FILE_NAME)
    }

    /// Load the config and themes. A missing config file is not an error:
    /// every setting has a default.
    pub async fn load() -> Result<Self, Error> {
        Self::load_from(&Self::config_dir()).await
    }

    pub async fn load_from(dir: &Path) -> Result<Self, Error> {
        let path = dir.join(environment::CONFIG_FILE_NAME);
        let file = match tokio::fs::read_to_string(&path).await {
            Ok(content) => toml::from_str(&content)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                File::default()
            }
            Err(error) => return Err(error.into()),
        };

        let appearance =
            load_appearance(&dir.join("themes"), &file.theme).await;

        Ok(Config {
            appearance,
            font: file.font,
            scale_factor: file.scale_factor,
            sidebar: file.sidebar,
            privateer: Privateer {
                bin: expand_home(file.privateer.bin),
                home: file.privateer.home.map(expand_home),
                ..file.privateer
            },
        })
    }
}

/// `~/x` is `x` in the user's home directory.
fn expand_home(path: PathBuf) -> PathBuf {
    match (path.strip_prefix("~"), dirs_next::home_dir()) {
        (Ok(rest), Some(home)) => home.join(rest),
        _ => path,
    }
}

/// One change the settings window makes to `config.toml`.
#[derive(Debug, Clone, PartialEq)]
pub enum Edit {
    Theme(String),
    SidebarPosition(Position),
}

impl Config {
    /// Write one setting into `config.toml`, keeping everything else in the
    /// file, comments included.
    pub async fn apply(edit: Edit) -> Result<(), Error> {
        apply_to(&Self::path(), edit).await
    }
}

pub async fn apply_to(path: &Path, edit: Edit) -> Result<(), Error> {
    let content = match tokio::fs::read_to_string(path).await {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            String::new()
        }
        Err(error) => return Err(error.into()),
    };
    let mut doc: toml_edit::DocumentMut =
        content.parse().map_err(|error: toml_edit::TomlError| {
            Error::Parse(error.to_string())
        })?;

    match edit {
        Edit::Theme(name) => {
            doc["theme"] = toml_edit::value(name);
        }
        Edit::SidebarPosition(position) => {
            let position = match position {
                Position::Left => "left",
                Position::Right => "right",
            };
            if !doc.contains_table("sidebar") {
                doc["sidebar"] = toml_edit::table();
            }
            doc["sidebar"]["position"] = toml_edit::value(position);
        }
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    // Write beside the file, then rename over it, so a crash never leaves
    // half a config.
    let partial = path.with_extension("toml.partial");
    tokio::fs::write(&partial, doc.to_string()).await?;
    tokio::fs::rename(&partial, path).await?;
    Ok(())
}

/// Read every `*.toml` theme in `themes_dir`, plus the built-in Ferra. A
/// theme the config names but that does not exist falls back to Ferra.
async fn load_appearance(themes_dir: &Path, keys: &ThemeKeys) -> Appearance {
    let mut all = vec![Theme::default()];

    if let Ok(mut entries) = tokio::fs::read_dir(themes_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "toml") {
                continue;
            }
            let Some(name) = path.file_stem().map(|s| s.to_string_lossy())
            else {
                continue;
            };
            if name.eq_ignore_ascii_case(DEFAULT_THEME_NAME) {
                continue;
            }
            let Ok(content) = tokio::fs::read_to_string(&path).await else {
                continue;
            };
            match toml::from_str::<Styles>(&content) {
                Ok(styles) => all.push(Theme::new(name.into_owned(), styles)),
                Err(error) => {
                    log::warn!("skipping theme {}: {error}", path.display());
                }
            }
        }
    }

    let find = |name: &str| {
        all.iter()
            .find(|theme| theme.name.eq_ignore_ascii_case(name))
            .cloned()
            .unwrap_or_default()
    };

    let selected = match keys {
        ThemeKeys::Static(name) => appearance::Selected::specific(find(name)),
        ThemeKeys::Dynamic { light, dark } => {
            appearance::Selected::dynamic(find(light), find(dark))
        }
    };

    Appearance { selected, all }
}

fn parse_weight(value: &str) -> Option<font::Weight> {
    Some(
        match value.to_ascii_lowercase().replace('_', "-").as_str() {
            "thin" => font::Weight::Thin,
            "extra-light" => font::Weight::ExtraLight,
            "light" => font::Weight::Light,
            "normal" => font::Weight::Normal,
            "medium" => font::Weight::Medium,
            "semibold" => font::Weight::Semibold,
            "bold" => font::Weight::Bold,
            "extra-bold" => font::Weight::ExtraBold,
            "black" => font::Weight::Black,
            _ => return None,
        },
    )
}

fn deserialize_weight<'de, D>(deserializer: D) -> Result<font::Weight, D::Error>
where
    D: Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    parse_weight(&value).ok_or_else(|| {
        serde::de::Error::custom(format!("unknown font weight {value:?}"))
    })
}

fn deserialize_optional_weight<'de, D>(
    deserializer: D,
) -> Result<Option<font::Weight>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_weight(deserializer).map(Some)
}

#[derive(Debug, Clone, Error)]
pub enum Error {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Parse(String),
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}

impl From<toml::de::Error> for Error {
    fn from(error: toml::de::Error) -> Self {
        Self::Parse(error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-config-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("themes")).unwrap();
        dir
    }

    #[tokio::test]
    async fn missing_file_gives_defaults() {
        let dir = scratch("missing");
        let config = Config::load_from(&dir).await.unwrap();

        let appearance::Selected::Static(theme) = config.appearance.selected
        else {
            panic!("expected a static theme");
        };
        assert_eq!(theme.name, "Ferra");
        assert_eq!(config.sidebar.position, Position::Left);
    }

    #[tokio::test]
    async fn dynamic_theme_reads_user_themes_and_falls_back() {
        let dir = scratch("dynamic");
        std::fs::write(
            dir.join("themes/paper.toml"),
            "[general]\nbackground = \"#ffffff\"\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("config.toml"),
            "theme = { light = \"paper\", dark = \"nope\" }\n\
             [font]\nweight = \"light\"\n[sidebar]\nposition = \"right\"\n",
        )
        .unwrap();

        let config = Config::load_from(&dir).await.unwrap();

        let appearance::Selected::Dynamic { light, dark } =
            config.appearance.selected
        else {
            panic!("expected a dynamic theme");
        };
        assert_eq!(light.name, "paper");
        assert_eq!(dark.name, "Ferra");
        assert_eq!(config.appearance.all.len(), 2);
        assert_eq!(config.font.weight, font::Weight::Light);
        assert_eq!(config.sidebar.position, Position::Right);
    }

    #[tokio::test]
    async fn edits_keep_comments_and_load_back() {
        let dir = scratch("edit");
        let path = dir.join("config.toml");
        std::fs::write(
            &path,
            "# my settings\ntheme = { light = \"a\", dark = \"b\" }\n\
             [font]\nsize = 14 # bigger\n",
        )
        .unwrap();

        apply_to(&path, Edit::Theme("ferra".into())).await.unwrap();
        apply_to(&path, Edit::SidebarPosition(Position::Right))
            .await
            .unwrap();

        let content = std::fs::read_to_string(&path).unwrap();
        assert!(content.contains("# my settings"));
        assert!(content.contains("size = 14 # bigger"));
        let config = Config::load_from(&dir).await.unwrap();
        assert!(!config.appearance.selected.is_dynamic());
        assert_eq!(config.sidebar.position, Position::Right);
        assert_eq!(config.font.size, Some(14));
    }

    #[tokio::test]
    async fn bad_config_is_an_error() {
        let dir = scratch("bad");
        std::fs::write(dir.join("config.toml"), "scale_factor = \"big\"\n")
            .unwrap();

        assert!(matches!(
            Config::load_from(&dir).await,
            Err(Error::Parse(_))
        ));
    }
}
