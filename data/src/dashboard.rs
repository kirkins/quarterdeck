use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::environment;

const FILE_NAME: &str = "dashboard.json";

/// What a pane shows. Each is one of the captain's views of the fleet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum View {
    Triage,
    Feed,
    Ships,
    Fleet,
    Spend,
    Reports,
    Live,
}

impl View {
    pub const ALL: [View; 7] = [
        View::Triage,
        View::Feed,
        View::Ships,
        View::Fleet,
        View::Spend,
        View::Reports,
        View::Live,
    ];

    pub fn title(self) -> &'static str {
        match self {
            View::Triage => "Triage",
            View::Feed => "Feed",
            View::Ships => "Ships",
            View::Fleet => "Fleet",
            View::Spend => "Spend",
            View::Reports => "Reports",
            View::Live => "Live",
        }
    }

    pub fn summary(self) -> &'static str {
        match self {
            View::Triage => {
                "Everything owed to you: decisions, requests, approvals and \
                 blocked work, most urgent first."
            }
            View::Feed => "One conversation with every ship, across machines.",
            View::Ships => {
                "Each ship's first mate: its conversation, routes and tools."
            }
            View::Fleet => "Machines, ships and crew, and what each is doing.",
            View::Spend => "Model routes and what they have used.",
            View::Reports => "Reports from the ships, to read and annotate.",
            View::Live => {
                "A ship's first mate as it works, to watch and type to."
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Axis {
    Horizontal,
    Vertical,
}

/// The pane layout: a tree of splits with a view in each leaf.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Layout {
    Split {
        axis: Axis,
        ratio: f32,
        a: Box<Layout>,
        b: Box<Layout>,
    },
    Pane {
        view: View,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Dashboard {
    pub layout: Layout,
}

impl Default for Dashboard {
    fn default() -> Self {
        Self {
            layout: Layout::Split {
                axis: Axis::Vertical,
                ratio: 0.5,
                a: Box::new(Layout::Pane { view: View::Triage }),
                b: Box::new(Layout::Pane { view: View::Feed }),
            },
        }
    }
}

impl Dashboard {
    pub fn path() -> PathBuf {
        environment::data_dir().join(FILE_NAME)
    }

    /// The saved layout, or the default one when none was saved or it
    /// cannot be read.
    pub async fn load() -> Self {
        Self::load_from(&Self::path()).await
    }

    pub async fn load_from(path: &Path) -> Self {
        let Ok(bytes) = tokio::fs::read(path).await else {
            return Self::default();
        };
        serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("ignoring saved layout {}: {error}", path.display());
            Self::default()
        })
    }

    pub async fn save(self) -> Result<(), String> {
        self.save_to(&Self::path()).await
    }

    pub async fn save_to(self, path: &Path) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self).map_err(|e| e.to_string())?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| e.to_string())?;
        }
        tokio::fs::write(path, bytes)
            .await
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saved_layout_loads_back_and_bad_files_fall_back() {
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-dashboard-{}", std::process::id()));
        let path = dir.join(FILE_NAME);

        let saved = Dashboard {
            layout: Layout::Split {
                axis: Axis::Horizontal,
                ratio: 0.3,
                a: Box::new(Layout::Pane { view: View::Fleet }),
                b: Box::new(Layout::Pane {
                    view: View::Reports,
                }),
            },
        };
        saved.clone().save_to(&path).await.unwrap();
        assert_eq!(Dashboard::load_from(&path).await, saved);

        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(Dashboard::load_from(&path).await, Dashboard::default());

        let _ = std::fs::remove_dir_all(dir);
    }
}
