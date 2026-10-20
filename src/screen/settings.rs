use std::path::PathBuf;

use data::config::{Edit, Position, Privateer, Source};
use data::environment;
use iced::widget::{
    button, checkbox, column, container, pick_list, row, scrollable, text_input,
};
use iced::{Alignment, Length};

use crate::appearance::theme;
use crate::font;
use crate::widget::{Column, Element, text};

#[derive(Debug, Clone)]
pub enum Message {
    Edit(Edit),
    Reload,
    Source(Source),
    Binary(String),
    Home(String),
    Poll(String),
    AllowSend(bool),
    SavePrivateer,
    Test,
    Tested(u64, Result<String, String>),
}

pub enum Action {
    Edit(Edit),
    Reload,
    Test(u64, Privateer),
}

#[derive(Clone)]
struct Draft {
    source: Source,
    binary: String,
    home: String,
    poll: String,
    allow_send: bool,
}

impl From<&Privateer> for Draft {
    fn from(config: &Privateer) -> Self {
        Self {
            source: config.source,
            binary: config.bin.to_string_lossy().into_owned(),
            home: config
                .home
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            poll: config.poll_seconds.max(5).to_string(),
            allow_send: config.allow_send,
        }
    }
}

impl Draft {
    fn read(&self) -> Result<Privateer, String> {
        let poll_seconds = self
            .poll
            .trim()
            .parse::<u64>()
            .ok()
            .filter(|n| (5..=i64::MAX as u64).contains(n))
            .ok_or(
                "Check interval must be a whole number of seconds, at least 5.",
            )?;
        let binary = self.binary.trim();
        if binary.is_empty() {
            return Err("Enter the Privateer binary name or path.".into());
        }
        let home = self.home.trim();
        if self.source == Source::Cli && home.is_empty() {
            return Err(
                "Choose a Privateer home, such as a ship's .privateer folder."
                    .into(),
            );
        }
        Ok(Privateer {
            source: self.source,
            bin: PathBuf::from(binary),
            home: (!home.is_empty()).then(|| PathBuf::from(home)),
            poll_seconds,
            allow_send: self.allow_send,
        })
    }
}

/// Connection edits stay local until Save. Config writes are serialized so
/// a theme change cannot overwrite a connection save in flight.
pub struct Settings {
    draft: Draft,
    dirty: bool,
    saving: bool,
    saving_connection: bool,
    reloading: bool,
    revision: u64,
    testing: bool,
    test_result: Option<Result<String, String>>,
    error: Option<String>,
    feedback: Option<&'static str>,
}

impl Settings {
    pub fn new(config: &Privateer) -> Self {
        Self {
            draft: config.into(),
            dirty: false,
            saving: false,
            saving_connection: false,
            reloading: false,
            revision: 0,
            testing: false,
            test_result: None,
            error: None,
            feedback: None,
        }
    }

    pub fn update(&mut self, message: Message) -> Option<Action> {
        if let Message::Tested(revision, result) = message {
            self.testing = false;
            if revision == self.revision {
                self.test_result = Some(result);
            }
            return None;
        }
        if self.saving {
            return None;
        }
        match message {
            Message::Edit(edit) => {
                self.saving = true;
                return Some(Action::Edit(edit));
            }
            Message::Reload => {
                self.saving = true;
                self.reloading = true;
                return Some(Action::Reload);
            }
            Message::SavePrivateer | Message::Test => {
                let config = match self.draft.read() {
                    Ok(config) => config,
                    Err(error) => {
                        self.error = Some(error);
                        return None;
                    }
                };
                self.error = None;
                self.feedback = None;
                if matches!(message, Message::Test) {
                    if self.testing {
                        return None;
                    }
                    self.testing = true;
                    self.test_result = None;
                    return Some(Action::Test(
                        self.revision,
                        config.expanded(),
                    ));
                }
                self.saving = true;
                self.saving_connection = true;
                return Some(Action::Edit(Edit::Privateer(config)));
            }
            Message::Source(source) => self.draft.source = source,
            Message::Binary(binary) => self.draft.binary = binary,
            Message::Home(home) => self.draft.home = home,
            Message::Poll(poll) => self.draft.poll = poll,
            Message::AllowSend(allow_send) => {
                self.draft.allow_send = allow_send
            }
            Message::Tested(..) => unreachable!(),
        }
        self.dirty = true;
        self.revision += 1;
        self.test_result = None;
        self.error = None;
        self.feedback = None;
        None
    }

    pub fn loaded(&mut self, config: &Privateer) {
        if self.saving_connection || self.reloading || !self.dirty {
            self.draft = config.into();
            self.dirty = false;
            self.revision += 1;
            self.test_result = None;
        }
        self.feedback = Some(if self.reloading {
            "Reloaded."
        } else {
            "Saved."
        });
        self.saving = false;
        self.saving_connection = false;
        self.reloading = false;
        self.error = None;
    }

    pub fn failed(&mut self, error: String) {
        self.saving = false;
        self.saving_connection = false;
        self.reloading = false;
        self.error = Some(error);
    }
}

/// Test the draft with read commands only, through the same bounded runner
/// as the app. This never applies settings or invokes the write path.
pub async fn test_connection(config: Privateer) -> Result<String, String> {
    if config.source == Source::Cli {
        let home = config.home.as_ref().ok_or("Choose a Privateer home.")?;
        if !tokio::fs::metadata(home)
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false)
        {
            return Err(format!(
                "Privateer home is not a readable directory: {}",
                home.display()
            ));
        }
    }
    let fixtures = config.source == Source::Fixtures;
    let client = data::privateer::Client::new(&config);
    let waiting = client
        .run("captain.waiting", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;
    let waiting = data::captain::Waiting::parse(waiting)?;
    let ships = client
        .run("ship.list", serde_json::json!({}))
        .await
        .map_err(|e| e.to_string())?;
    let ships = data::ships::parse(ships)?;
    Ok(format!(
        "{}: {} ships, {} waiting. Nothing sent.",
        if fixtures {
            "Fixtures read successfully"
        } else {
            "Connected"
        },
        ships.len(),
        waiting.waiting.len()
    ))
}

pub fn view<'a>(
    config: &'a data::Config,
    settings: &'a Settings,
) -> Element<'a, Message> {
    let selected = match &config.appearance.selected {
        data::appearance::Selected::Static(theme) => Some(theme.name.as_str()),
        // Following the system: no single theme is picked here.
        data::appearance::Selected::Dynamic { .. } => None,
    };

    let themes = config.appearance.all.iter().map(|candidate| {
        let is_selected = selected == Some(candidate.name.as_str());
        let swatch = container(text(" ")).width(14).height(14).style(
            move |_: &crate::Theme| container::Style {
                background: Some(candidate.styles.general.background.into()),
                border: iced::Border {
                    radius: 3.0.into(),
                    width: 1.0,
                    color: candidate.styles.general.border,
                },
                ..Default::default()
            },
        );

        button(
            row![swatch, text(candidate.name.as_str())]
                .spacing(8)
                .align_y(Alignment::Center),
        )
        .width(Length::Fill)
        .padding([5, 8])
        .style(move |theme, status| {
            theme::button::secondary(theme, status, is_selected)
        })
        .on_press_maybe(
            (!settings.saving)
                .then(|| Message::Edit(Edit::Theme(candidate.name.clone()))),
        )
        .into()
    });

    let mut appearance = Column::new()
        .spacing(4)
        .push(Column::with_children(themes).spacing(4));
    if selected.is_none() {
        appearance = appearance.push(
            text(
                "Your config follows the system's light and dark themes. \
                 Picking one here sets a single theme.",
            )
            .style(theme::text::tertiary),
        );
    }
    appearance = appearance.push(
        text(format!(
            "Add themes as .toml files in {}",
            data::Config::config_dir().join("themes").display()
        ))
        .style(theme::text::tertiary),
    );

    let position = |label, value| {
        let is_selected = config.sidebar.position == value;
        button(text(label))
            .padding([5, 12])
            .style(move |theme, status| {
                theme::button::secondary(theme, status, is_selected)
            })
            .on_press_maybe(
                (!settings.saving)
                    .then_some(Message::Edit(Edit::SidebarPosition(value))),
            )
    };

    let content = column![
        text("Settings").size(18).font(font::MONO_BOLD.clone()),
        section("Theme", appearance.into()),
        section(
            "Sidebar",
            row![
                position("Left", Position::Left),
                position("Right", Position::Right)
            ]
            .spacing(4)
            .into(),
        ),
        section("Privateer", privateer(&config.privateer, settings)),
        text(format!(
            "{} {} · config {}",
            environment::APP_NAME,
            environment::VERSION,
            data::Config::path().display()
        ))
        .style(theme::text::tertiary),
    ]
    .spacing(20)
    .max_width(560);

    container(scrollable(container(content).padding(20)))
        .width(Length::Fill)
        .height(Length::Fill)
        .style(theme::container::general)
        .into()
}

fn section<'a>(
    title: &'a str,
    body: Element<'a, Message>,
) -> Element<'a, Message> {
    column![
        text(title)
            .font(font::MONO_BOLD.clone())
            .style(theme::text::secondary),
        body,
    ]
    .spacing(8)
    .into()
}

fn privateer<'a>(
    config: &Privateer,
    settings: &'a Settings,
) -> Element<'a, Message> {
    let draft = &settings.draft;
    let enabled = !settings.saving;
    let field = |label: &'static str, input: Element<'a, Message>| {
        column![text(label).style(theme::text::secondary), input].spacing(4)
    };
    let input = |placeholder: &'static str,
                 value: &'a str,
                 message: fn(String) -> Message|
     -> Element<'a, Message> {
        text_input(placeholder, value)
            .padding([5, 8])
            .on_input_maybe(enabled.then_some(message))
            .into()
    };
    let mut source = pick_list(
        Some(draft.source),
        [Source::Cli, Source::Fixtures],
        |source| match source {
            Source::Cli => "Privateer binary".to_owned(),
            Source::Fixtures => "Fixtures (invented data)".to_owned(),
        },
    );
    if enabled {
        source = source.on_select(Message::Source);
    }
    let button = |label: &'static str, message: Message, enabled: bool| {
        button(text(label))
            .padding([5, 12])
            .style(|theme, status| {
                theme::button::secondary(theme, status, false)
            })
            .on_press_maybe(enabled.then_some(message))
    };
    let sending = if config.source == Source::Fixtures {
        "Sending is off: fixtures never send."
    } else if config.allow_send {
        "Sending is on."
    } else {
        "Sending is off."
    };
    let mut body = column![
        text(sending).style(theme::text::secondary),
        field("Source", source.into()),
        field(
            "Binary name or path",
            input("privateer", &draft.binary, Message::Binary)
        ),
        field(
            "Privateer home",
            input("~/ships/workstation/.privateer", &draft.home, Message::Home)
        ),
        field(
            "Check interval (seconds, at least 5)",
            input("15", &draft.poll, Message::Poll)
        ),
        checkbox(draft.allow_send)
            .label("Allow sending answers, messages and terminal input")
            .on_toggle_maybe(enabled.then_some(Message::AllowSend))
            .style(theme::checkbox::primary),
        text("Changes take effect when saved. Testing only reads the fleet.")
            .style(theme::text::tertiary),
        row![
            button(
                if settings.testing {
                    "Testing…"
                } else {
                    "Test connection"
                },
                Message::Test,
                enabled && !settings.testing
            ),
            button(
                if settings.saving {
                    "Saving…"
                } else {
                    "Save connection"
                },
                Message::SavePrivateer,
                enabled && settings.dirty
            ),
        ]
        .spacing(8),
    ]
    .spacing(10);
    if let Some(result) = &settings.test_result {
        body = body.push(match result {
            Ok(line) => text(line.clone()).style(theme::text::success),
            Err(line) => text(format!("Connection test failed: {line}"))
                .style(theme::text::error),
        });
    }
    if let Some(error) = &settings.error {
        body = body.push(text(error.as_str()).style(theme::text::error));
    } else if let Some(feedback) = settings.feedback {
        body = body.push(text(feedback).style(theme::text::success));
    } else if settings.dirty {
        body = body.push(
            text("Unsaved connection changes.").style(theme::text::tertiary),
        );
    }
    body.push(button(
        "Reload config.toml (discard connection edits)",
        Message::Reload,
        enabled,
    ))
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured() -> Privateer {
        Privateer {
            home: Some("/fleet/.privateer".into()),
            ..Privateer::default()
        }
    }

    #[test]
    fn edits_are_drafts_and_save_validates_before_applying() {
        let mut settings = Settings::new(&Privateer::default());
        assert!(settings.update(Message::SavePrivateer).is_none());
        assert!(settings.error.as_ref().unwrap().contains("home"));
        assert!(!settings.saving);
        assert!(
            settings
                .update(Message::Home(" ~/ships/desk/.privateer ".into()))
                .is_none()
        );
        assert!(settings.update(Message::Poll("4".into())).is_none());
        assert!(settings.update(Message::SavePrivateer).is_none());
        assert!(settings.error.as_ref().unwrap().contains("at least 5"));
        settings.update(Message::Poll("30".into()));
        settings.update(Message::AllowSend(true));
        let Some(Action::Edit(Edit::Privateer(config))) =
            settings.update(Message::SavePrivateer)
        else {
            panic!("expected a connection save");
        };
        assert_eq!(config.home, Some("~/ships/desk/.privateer".into()));
        assert_eq!(config.poll_seconds, 30);
        assert!(config.allow_send);
        assert!(settings.saving);
        // No second config writer or field edit can race this write.
        assert!(
            settings
                .update(Message::Edit(Edit::Theme("ferra".into())))
                .is_none()
        );
        settings.update(Message::Home("/racing".into()));
        assert_eq!(settings.draft.home.trim(), "~/ships/desk/.privateer");
    }

    #[test]
    fn invalid_fields_are_rejected() {
        let mut draft = Draft::from(&configured());
        for poll in ["", "five", "0", "-1", "5.5", "18446744073709551615"] {
            draft.poll = poll.into();
            assert!(draft.read().is_err(), "accepted {poll}");
        }
        draft.poll = "5".into();
        assert!(draft.read().is_ok());
        draft.binary = "  ".into();
        assert!(draft.read().is_err());
    }

    #[test]
    fn appearance_saves_keep_connection_drafts_and_failed_saves_allow_retry() {
        let config = configured();
        let mut settings = Settings::new(&config);
        settings.update(Message::Home("/unsaved".into()));
        assert!(matches!(
            settings
                .update(Message::Edit(Edit::SidebarPosition(Position::Right))),
            Some(Action::Edit(_))
        ));
        settings.loaded(&config);
        assert_eq!(settings.draft.home, "/unsaved");
        assert!(settings.dirty);
        settings.update(Message::SavePrivateer);
        settings.failed("disk full".into());
        assert_eq!(settings.draft.home, "/unsaved");
        assert!(!settings.saving);
        assert!(matches!(
            settings.update(Message::SavePrivateer),
            Some(Action::Edit(Edit::Privateer(_)))
        ));
    }

    #[test]
    fn connection_save_and_explicit_reload_replace_the_draft() {
        let config = configured();
        let mut settings = Settings::new(&config);
        settings.update(Message::Home("/new".into()));
        settings.update(Message::SavePrivateer);
        let new_config = Privateer {
            home: Some("/new".into()),
            ..config.clone()
        };
        settings.loaded(&new_config);
        assert!(!settings.dirty);
        assert_eq!(settings.draft.home, "/new");
        settings.update(Message::Home("/discard".into()));
        assert!(matches!(
            settings.update(Message::Reload),
            Some(Action::Reload)
        ));
        settings.loaded(&config);
        assert_eq!(settings.draft.home, "/fleet/.privateer");
        assert!(!settings.dirty);
    }

    #[test]
    fn connection_tests_do_not_save_and_ignore_results_after_an_edit() {
        let mut settings = Settings::new(&configured());
        let Some(Action::Test(revision, _)) = settings.update(Message::Test)
        else {
            panic!("expected read-only test")
        };
        assert!(!settings.saving);
        assert!(settings.testing);
        assert!(settings.update(Message::Test).is_none());
        settings.update(Message::Home("/new".into()));
        settings.update(Message::Tested(
            revision,
            Ok("old connection worked".into()),
        ));
        assert!(settings.test_result.is_none());
        assert!(!settings.testing);
        let Some(Action::Test(revision, _)) = settings.update(Message::Test)
        else {
            panic!("expected test")
        };
        settings.update(Message::Tested(revision, Err("offline".into())));
        assert_eq!(settings.test_result, Some(Err("offline".into())));
    }

    #[tokio::test]
    async fn test_reads_fixtures_without_a_home_or_sending() {
        let result = test_connection(Privateer {
            source: Source::Fixtures,
            allow_send: true,
            ..Privateer::default()
        })
        .await
        .unwrap();
        assert!(result.starts_with("Fixtures read successfully"));
        assert!(result.ends_with("Nothing sent."));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn test_uses_only_read_commands_even_when_sending_is_enabled() {
        use std::io::Write;
        let dir = std::env::temp_dir()
            .join(format!("quarterdeck-settings-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("privateer");
        let log = dir.join("commands");
        let _ = std::fs::remove_file(&log);
        // Write from a child to avoid an inherited write handle preventing
        // exec when other subprocess tests are running concurrently.
        let mut child = std::process::Command::new("sh")
            .args(["-c", "cat > \"$1\" && chmod 755 \"$1\"", "sh"])
            .arg(&bin)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(
                br##"#!/bin/sh
printf '%s\n' "$3" >> "$2/commands"
case "$3" in
  captain.waiting) printf '%s\n' '{"waiting":[]}' ;;
  ship.list) printf '%s\n' '{"ships":[{"name":"test"}]}' ;;
  *) exit 91 ;;
esac
"##,
            )
            .unwrap();
        assert!(child.wait().unwrap().success());
        let config = Privateer {
            bin,
            home: Some(dir.clone()),
            allow_send: true,
            ..Privateer::default()
        };
        let result = test_connection(config).await.unwrap();
        assert_eq!(result, "Connected: 1 ships, 0 waiting. Nothing sent.");
        assert_eq!(
            std::fs::read_to_string(log).unwrap(),
            "captain.waiting\nship.list\n"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
