use data::appearance::theme::FontStyle;

use super::Theme;

pub fn primary(theme: &Theme) -> Option<FontStyle> {
    theme.styles().text.primary.font_style
}

pub fn secondary(theme: &Theme) -> Option<FontStyle> {
    theme.styles().text.secondary.font_style
}

pub fn tertiary(theme: &Theme) -> Option<FontStyle> {
    theme.styles().text.tertiary.font_style
}

pub fn action(theme: &Theme) -> Option<FontStyle> {
    theme.styles().buffer.action.font_style
}

pub fn error(theme: &Theme) -> Option<FontStyle> {
    theme.styles().text.error.font_style
}

pub fn success(theme: &Theme) -> Option<FontStyle> {
    theme.styles().text.success.font_style
}

pub fn timestamp(theme: &Theme) -> Option<FontStyle> {
    theme.styles().buffer.timestamp.font_style
}

pub fn topic(theme: &Theme) -> Option<FontStyle> {
    theme.styles().buffer.topic.font_style
}

pub fn buffer_title_bar(theme: &Theme) -> Option<FontStyle> {
    theme.styles().buffer.topic.font_style
}

pub fn url(theme: &Theme) -> Option<FontStyle> {
    theme.styles().buffer.url.font_style
}
