// The icon font's glyphs: not every one is used yet.
#![allow(dead_code)]
use iced::widget::text;
use iced::widget::text::LineHeight;

use crate::widget::Text;
use crate::{font, theme};

pub fn dot<'a>() -> Text<'a> {
    to_text('\u{F111}')
}

pub fn globe<'a>() -> Text<'a> {
    to_text('\u{E800}')
}

pub fn error<'a>() -> Text<'a> {
    to_text('\u{E80D}')
}

pub fn connected<'a>() -> Text<'a> {
    to_text('\u{E800}')
}

pub fn link<'a>() -> Text<'a> {
    to_text('\u{E814}')
}

pub fn cancel<'a>() -> Text<'a> {
    to_text('\u{E80F}')
}

pub fn maximize<'a>() -> Text<'a> {
    to_text('\u{E801}')
}

pub fn restore<'a>() -> Text<'a> {
    to_text('\u{E805}')
}

pub fn people<'a>() -> Text<'a> {
    to_text('\u{E804}')
}

pub fn users<'a>() -> Text<'a> {
    to_text('\u{E804}')
}

pub fn topic<'a>() -> Text<'a> {
    to_text('\u{E803}')
}

pub fn search<'a>() -> Text<'a> {
    to_text('\u{E808}')
}

pub fn checkmark<'a>() -> Text<'a> {
    to_text('\u{E806}')
}

pub fn file_transfer<'a>() -> Text<'a> {
    to_text('\u{E802}')
}

pub fn download<'a>() -> Text<'a> {
    to_text('\u{E802}')
}

pub fn megaphone<'a>() -> Text<'a> {
    to_text('\u{E809}')
}

pub fn palette<'a>() -> Text<'a> {
    to_text('\u{E80A}')
}

pub fn undo<'a>() -> Text<'a> {
    to_text('\u{E80B}')
}

pub fn trash<'a>() -> Text<'a> {
    to_text('\u{E80C}')
}

pub fn copy<'a>() -> Text<'a> {
    to_text('\u{F0C5}')
}

pub fn popout<'a>() -> Text<'a> {
    to_text('\u{E80E}')
}

pub fn logs<'a>() -> Text<'a> {
    to_text('\u{E810}')
}

pub fn menu<'a>() -> Text<'a> {
    to_text('\u{E81E}')
}

pub fn documentation<'a>() -> Text<'a> {
    to_text('\u{E812}')
}

pub fn book<'a>() -> Text<'a> {
    to_text('\u{E812}')
}

pub fn highlights<'a>() -> Text<'a> {
    to_text('\u{E811}')
}

pub fn scroll_to_bottom<'a>() -> Text<'a> {
    to_text('\u{F103}')
}

pub fn share<'a>() -> Text<'a> {
    to_text('\u{E813}')
}

pub fn docs<'a>() -> Text<'a> {
    to_text('\u{F0C5}')
}

pub fn mark_as_read<'a>() -> Text<'a> {
    to_text('\u{E817}')
}

pub fn bell<'a>() -> Text<'a> {
    to_text('\u{E811}')
}

pub fn config<'a>() -> Text<'a> {
    to_text('\u{F1C9}')
}

pub fn mail_alt<'a>() -> Text<'a> {
    to_text('\u{F100}')
}

pub fn file_code<'a>() -> Text<'a> {
    to_text('\u{F1C9}')
}

pub fn star<'a>() -> Text<'a> {
    to_text('\u{E819}')
}

pub fn certificate<'a>() -> Text<'a> {
    to_text('\u{F0A3}')
}

pub fn circle_empty<'a>() -> Text<'a> {
    to_text('\u{F10C}')
}

pub fn dot_circled<'a>() -> Text<'a> {
    to_text('\u{F192}')
}

pub fn asterisk<'a>() -> Text<'a> {
    to_text('\u{E815}')
}

pub fn speaker<'a>() -> Text<'a> {
    to_text('\u{E818}')
}

pub fn lightbulb<'a>() -> Text<'a> {
    to_text('\u{F0EB}')
}

pub fn quit<'a>() -> Text<'a> {
    to_text('\u{F02D}')
}

pub fn channel_discovery<'a>() -> Text<'a> {
    to_text('\u{E81D}')
}

fn to_text<'a>(unicode: char) -> Text<'a> {
    text(unicode.to_string())
        .line_height(LineHeight::Relative(1.0))
        .size(theme::ICON_SIZE)
        .font(font::ICON)
}

/// The naval icons, one per view and one for Settings (`assets/icons`).
pub mod naval {
    use std::sync::LazyLock;

    use data::dashboard::View;
    use iced::widget::svg::{self, Handle, Svg};

    use crate::{Theme, theme};

    macro_rules! icon {
        ($name:ident, $file:literal) => {
            static $name: LazyLock<Handle> = LazyLock::new(|| {
                Handle::from_memory(include_bytes!(concat!(
                    "../assets/icons/",
                    $file
                )))
            });
        };
    }

    icon!(TRIAGE, "triage.svg");
    icon!(FEED, "feed.svg");
    icon!(SHIPS, "ships.svg");
    icon!(FLEET, "fleet.svg");
    icon!(SPEND, "spend.svg");
    icon!(REPORTS, "reports.svg");
    icon!(SETTINGS, "settings.svg");

    /// The icon for a view, in the theme's secondary text colour.
    pub fn view<'a>(view: View) -> Svg<'a, Theme> {
        tinted(match view {
            View::Triage => &TRIAGE,
            View::Feed => &FEED,
            View::Ships => &SHIPS,
            View::Fleet => &FLEET,
            View::Spend => &SPEND,
            View::Reports => &REPORTS,
            View::Live => &SHIPS,
        })
    }

    pub fn settings<'a>() -> Svg<'a, Theme> {
        tinted(&SETTINGS)
    }

    fn tinted<'a>(handle: &LazyLock<Handle>) -> Svg<'a, Theme> {
        svg::Svg::new((**handle).clone())
            .width(16)
            .height(16)
            .style(theme::svg::secondary)
    }
}
