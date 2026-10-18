use std::borrow::Cow;
use std::sync::OnceLock;

use data::Config;
use data::appearance::theme::FontStyle;
use iced::font;
use iced::widget::text::{LineHeight, Shaping};
use unicode_segmentation::UnicodeSegmentation;

pub static MONO: Font = Font::new(false, false);
pub static MONO_BOLD: Font = Font::new(true, false);
pub static MONO_ITALICS: Font = Font::new(false, true);
pub static MONO_BOLD_ITALICS: Font = Font::new(true, true);
pub const ICON: iced::Font = iced::Font::with_name("halloy-icons");

static LINE_HEIGHT: OnceLock<LineHeight> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct Font {
    bold: bool,
    italics: bool,
    inner: OnceLock<iced::Font>,
}

impl Font {
    const fn new(bold: bool, italics: bool) -> Self {
        Self {
            bold,
            italics,
            inner: OnceLock::new(),
        }
    }

    fn set(
        &self,
        name: String,
        weight: font::Weight,
        bold_weight: font::Weight,
    ) {
        let name = Box::leak(name.into_boxed_str());
        let weight = if self.bold { bold_weight } else { weight };
        let style = if self.italics {
            font::Style::Italic
        } else {
            font::Style::Normal
        };

        let _ = self.inner.set(iced::Font {
            weight,
            style,
            ..iced::Font::with_name(name)
        });
    }
}

impl From<Font> for iced::Font {
    fn from(value: Font) -> Self {
        value.inner.get().copied().expect("font is set on startup")
    }
}

pub fn line_height() -> LineHeight {
    LINE_HEIGHT.get().copied().unwrap_or_default()
}

pub fn contains_emoji(content: &str) -> bool {
    UnicodeSegmentation::graphemes(content, true)
        .any(|grapheme| emojis::get(grapheme).is_some())
}

pub fn needs_advanced_shaping(content: &str) -> bool {
    !content.is_ascii() || contains_emoji(content)
}

pub fn shaping_for_text(content: &str) -> Shaping {
    if needs_advanced_shaping(content) {
        Shaping::Advanced
    } else {
        #[cfg(debug_assertions)]
        {
            Shaping::Basic
        }

        #[cfg(not(debug_assertions))]
        {
            Shaping::Advanced
        }
    }
}

pub fn set(config: Option<&Config>) {
    let family = config
        .and_then(|config| config.font.family.clone())
        .unwrap_or_else(|| String::from("Iosevka Term"));
    let weight =
        config.map_or(font::Weight::Normal, |config| config.font.weight);
    let bold_weight = config
        .and_then(|config| config.font.bold_weight)
        .unwrap_or(match weight {
            font::Weight::Thin => font::Weight::Normal,
            font::Weight::ExtraLight => font::Weight::Medium,
            font::Weight::Light => font::Weight::Semibold,
            font::Weight::Normal => font::Weight::Bold,
            font::Weight::Medium => font::Weight::ExtraBold,
            font::Weight::Semibold
            | font::Weight::Bold
            | font::Weight::ExtraBold
            | font::Weight::Black => font::Weight::Black,
        });

    MONO.set(family.clone(), weight, bold_weight);
    MONO_BOLD.set(family.clone(), weight, bold_weight);
    MONO_ITALICS.set(family.clone(), weight, bold_weight);
    MONO_BOLD_ITALICS.set(family, weight, bold_weight);

    let lh = config
        .and_then(|c| c.font.line_height)
        .map(LineHeight::Relative)
        .unwrap_or_default();
    let _ = LINE_HEIGHT.set(lh);
}

pub fn load() -> Vec<Cow<'static, [u8]>> {
    vec![
        include_bytes!("../fonts/iosevka-term-regular.ttf")
            .as_slice()
            .into(),
        include_bytes!("../fonts/iosevka-term-bold.ttf")
            .as_slice()
            .into(),
        include_bytes!("../fonts/iosevka-term-italic.ttf")
            .as_slice()
            .into(),
        include_bytes!("../fonts/iosevka-term-light.ttf")
            .as_slice()
            .into(),
        include_bytes!("../fonts/iosevka-term-semibold.ttf")
            .as_slice()
            .into(),
        include_bytes!("../fonts/iosevka-term-lightitalic.ttf")
            .as_slice()
            .into(),
        include_bytes!("../fonts/halloy-icons.ttf")
            .as_slice()
            .into(),
    ]
}

pub fn get(font_style: FontStyle) -> Font {
    match font_style {
        FontStyle::Normal => MONO.clone(),
        FontStyle::Bold => MONO_BOLD.clone(),
        FontStyle::Italic => MONO_ITALICS.clone(),
        FontStyle::ItalicBold => MONO_BOLD_ITALICS.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        Shaping, contains_emoji, needs_advanced_shaping, shaping_for_text,
    };

    #[test]
    fn detects_emoji_graphemes() {
        assert!(contains_emoji("hello 🙂"));
        assert!(!contains_emoji("hello"));
    }

    #[test]
    fn emoji_text_uses_advanced_shaping() {
        assert_eq!(shaping_for_text("what's up 🙂"), Shaping::Advanced);
    }

    #[test]
    fn non_ascii_text_uses_advanced_shaping() {
        assert!(needs_advanced_shaping("ＦＯＯＴＢＡＬＬ"));
        assert_eq!(shaping_for_text("ＦＯＯＴＢＡＬＬ"), Shaping::Advanced);
    }
}
