use data::config::{Edit, Position};
use data::environment;
use iced::widget::{button, column, container, row, scrollable};
use iced::{Alignment, Length};

use crate::appearance::theme;
use crate::font;
use crate::widget::{Column, Element, text};

#[derive(Debug, Clone)]
pub enum Message {
    Edit(Edit),
}

/// The settings window. It holds no state of its own: it shows the config
/// and asks the app to apply each change.
pub fn view(config: &data::Config) -> Element<'_, Message> {
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
        .on_press(Message::Edit(Edit::Theme(candidate.name.clone())))
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
            .on_press(Message::Edit(Edit::SidebarPosition(value)))
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
