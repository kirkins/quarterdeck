use iced::widget::svg::{Catalog, Status, Style, StyleFn};

use super::Theme;

impl Catalog for Theme {
    type Class<'a> = StyleFn<'a, Self>;

    fn default<'a>() -> Self::Class<'a> {
        Box::new(none)
    }

    fn style(&self, class: &Self::Class<'_>, status: Status) -> Style {
        class(self, status)
    }
}

pub fn none(_theme: &Theme, _status: Status) -> Style {
    Style { color: None }
}

/// One colour for a whole single-colour icon: the theme's secondary text.
pub fn secondary(theme: &Theme, _status: Status) -> Style {
    Style {
        color: Some(theme.styles().text.secondary.color),
    }
}

pub fn error(theme: &Theme, _status: Status) -> Style {
    Style {
        color: Some(theme.styles().text.error.color),
    }
}
